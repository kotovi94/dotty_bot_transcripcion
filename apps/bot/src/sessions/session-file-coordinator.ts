import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

export class SessionCoordinationError extends Error {}

export interface SessionLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

// Share one root (outside recordings) between every process that accesses the data.
// A surviving lock is never removed automatically: its owner may still be active.
export class SessionFileCoordinator {
  private static readonly active = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(private readonly root: string) {}

  pathFor(sessionId: string): string {
    if (!sessionId || sessionId === "." || sessionId === ".." ||
      sessionId.length > 128 || /[/\\\x00-\x1f]/u.test(sessionId)) {
      throw new SessionCoordinationError("Invalid session ID");
    }
    return join(this.root, `${Buffer.from(sessionId, "utf8").toString("hex")}.session.lock`);
  }

  async runExclusive<T>(sessionId: string, action: () => Promise<T>, options: SessionLockOptions = {}): Promise<T> {
    const path = this.pathFor(sessionId);
    const timeoutMs = options.timeoutMs ?? 5_000;
    const pollMs = options.pollMs ?? 25;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
      throw new SessionCoordinationError("Invalid lock timing");
    }
    const key = resolve(path).toLowerCase();
    if (SessionFileCoordinator.active.getStore()?.has(key)) throw new SessionCoordinationError("Reentrant session lock acquisition");
    await fs.mkdir(this.root, { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let handle: fs.FileHandle;
    for (;;) {
      try {
        handle = await fs.open(path, "wx");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new SessionCoordinationError(`Timed out waiting for session lock: ${sessionId}; inspect ${path}`);
        }
        await new Promise((done) => setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      }
    }
    const token = randomUUID();
    let owned = false;
    let identity: Awaited<ReturnType<fs.FileHandle["stat"]>> | undefined;
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.sync();
      identity = await handle.stat();
      owned = true;
      const inherited = SessionFileCoordinator.active.getStore() ?? new Set<string>();
      return await SessionFileCoordinator.active.run(new Set([...inherited, key]), action);
    } finally {
      let releaseError: unknown;
      try {
        if (owned) {
          const [current, stat] = await Promise.all([fs.readFile(path, "utf8"), fs.stat(path)]);
          let recordedToken: string | undefined;
          try { recordedToken = (JSON.parse(current) as { token?: string }).token; } catch { /* Foreign lock. */ }
          if (recordedToken !== token || stat.dev !== identity!.dev || stat.ino !== identity!.ino) {
            throw new SessionCoordinationError(`Session lock ownership changed; inspect ${path}`);
          }
          // Node has no atomic compare-and-unlink. External replacement during
          // this final check remains a Windows limitation; never force removal.
          await fs.unlink(path);
        }
      } catch (error) {
        releaseError = error;
      } finally {
        await handle.close();
      }
      if (releaseError !== undefined) throw releaseError;
    }
  }
}
