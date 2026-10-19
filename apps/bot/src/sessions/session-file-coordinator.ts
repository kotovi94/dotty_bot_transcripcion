import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

export class SessionCoordinationError extends Error {}

export interface SessionLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  drainTimeoutMs?: number;
}

type LeaseState = "active" | "closing" | "released" | "uncertain";

interface SessionLease {
  readonly id: string;
  readonly key: string;
  readonly sessionId: string;
  state: LeaseState;
  readonly pending: Set<Promise<unknown>>;
  readonly failures: unknown[];
}

// Share one root (outside recordings) between every process that accesses the data.
// A surviving lock is never removed automatically: its owner may still be active.
export class SessionFileCoordinator {
  static readonly #active = new AsyncLocalStorage<ReadonlyMap<string, SessionLease>>();
  static readonly #issued = new WeakSet<SessionLease>();

  constructor(
    private readonly root: string,
    private readonly namespace = "session",
  ) {}

  pathFor(sessionId: string): string {
    if (!sessionId || sessionId === "." || sessionId === ".." ||
      sessionId.length > 128 || /[/\\\x00-\x1f]/u.test(sessionId)) {
      throw new SessionCoordinationError(`Invalid ${this.namespace} ID`);
    }
    return join(this.root, `${Buffer.from(sessionId, "utf8").toString("hex")}.${this.namespace}.lock`);
  }

  async runExclusive<T>(sessionId: string, action: () => Promise<T>, options: SessionLockOptions = {}): Promise<T> {
    const path = this.pathFor(sessionId);
    const timeoutMs = options.timeoutMs ?? 5_000;
    const pollMs = options.pollMs ?? 25;
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0 ||
      !Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0) {
      throw new SessionCoordinationError("Invalid lock timing");
    }
    const key = resolve(path).toLowerCase();
    if (SessionFileCoordinator.#active.getStore()?.has(key)) throw new SessionCoordinationError(`Reentrant ${this.namespace} lock acquisition`);
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
          throw new SessionCoordinationError(`Timed out waiting for ${this.namespace} lock: ${sessionId}; inspect ${path}`);
        }
        await new Promise((done) => setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      }
    }
    const token = randomUUID();
    let owned = false;
    let retainLock = false;
    let lease: SessionLease | undefined;
    let identity: Awaited<ReturnType<fs.FileHandle["stat"]>> | undefined;
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.sync();
      identity = await handle.stat();
      owned = true;
      lease = { id: token, key, sessionId, state: "active", pending: new Set(), failures: [] };
      SessionFileCoordinator.#issued.add(lease);
      const inherited = SessionFileCoordinator.#active.getStore() ?? new Map<string, SessionLease>();
      const context = new Map(inherited);
      context.set(key, lease);
      return await SessionFileCoordinator.#active.run(context, async () => {
        let value: T | undefined;
        let actionError: unknown;
        let actionFailed = false;
        try { value = await action(); }
        catch (error) { actionError = error; actionFailed = true; }
        // Close registration before waiting. An inherited async context alone
        // can never reopen this acquisition or pin a later acquisition.
        lease!.state = "closing";
        const pending = [...lease!.pending];
        if (pending.length > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const drained = await Promise.race([
              Promise.allSettled(pending).then(() => true),
              new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), drainTimeoutMs);
              }),
            ]);
            if (!drained) {
              retainLock = true;
              lease!.state = "uncertain";
              throw new SessionCoordinationError(`Timed out draining protected ${this.namespace} operations: ${sessionId}; inspect ${path}`);
            }
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
        const failures = lease!.failures;
        if (actionFailed && failures.length === 0) throw actionError;
        if (!actionFailed && failures.length === 1) throw failures[0];
        if (actionFailed || failures.length > 0) {
          throw new AggregateError(actionFailed ? [actionError, ...failures] : failures,
            `Protected ${this.namespace} operations failed: ${sessionId}`);
        }
        return value as T;
      });
    } finally {
      let releaseError: unknown;
      try {
        if (lease !== undefined && lease.state === "active") lease.state = "closing";
        if (lease !== undefined && lease.pending.size > 0) {
          retainLock = true;
          lease.state = "uncertain";
        }
        if (owned && !retainLock) {
          const [current, stat] = await Promise.all([fs.readFile(path, "utf8"), fs.stat(path)]);
          let recordedToken: string | undefined;
          try { recordedToken = (JSON.parse(current) as { token?: string }).token; } catch { /* Foreign lock. */ }
          if (recordedToken !== token || stat.dev !== identity!.dev || stat.ino !== identity!.ino) {
            throw new SessionCoordinationError(`${this.namespace} lock ownership changed; inspect ${path}`);
          }
          // Node has no atomic compare-and-unlink. External replacement during
          // this final check remains a Windows limitation; never force removal.
          await fs.unlink(path);
        }
      } catch (error) {
        releaseError = error;
      } finally {
        if (lease !== undefined) lease.state = retainLock || releaseError !== undefined ? "uncertain" : "released";
        await handle.close();
      }
      if (releaseError !== undefined) throw releaseError;
    }
  }

  // Only code executing in this acquisition's async context can register work.
  // Registration is synchronous and runExclusive waits for it. Arbitrary tasks
  // not registered here cannot be tracked or made safe by this coordinator.
  runWithHeldLock<T>(sessionId: string, action: () => Promise<T> | T): Promise<T> {
    const key = resolve(this.pathFor(sessionId)).toLowerCase();
    const lease = SessionFileCoordinator.#active.getStore()?.get(key);
    if (lease === undefined || !SessionFileCoordinator.#issued.has(lease) ||
      lease.key !== key || lease.sessionId !== sessionId || lease.state !== "active") {
      return Promise.reject(new SessionCoordinationError(`No active ${this.namespace} lock ownership: ${sessionId}`));
    }
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    lease.pending.add(result);
    // Attach both handlers immediately so a detached rejection remains visible
    // to runExclusive instead of becoming an unhandled rejection.
    result.then(
      () => { lease.pending.delete(result); },
      (error: unknown) => { lease.pending.delete(result); lease.failures.push(error); },
    );
    try { Promise.resolve(action()).then(resolveResult, rejectResult); }
    catch (error) { rejectResult(error); }
    return result;
  }
}
