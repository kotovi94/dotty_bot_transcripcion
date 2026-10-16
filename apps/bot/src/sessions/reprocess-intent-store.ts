import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";

export const reprocessPhases = [
  "prepared", "delete-confirmed", "recovering", "redispatch-ready", "completed",
] as const;
export type ReprocessPhase = typeof reprocessPhases[number];

export interface ReprocessIntent {
  version: 1;
  sessionId: string;
  operationId: string;
  phase: ReprocessPhase;
  createdAt: string;
  updatedAt: string;
}

export class ReprocessIntentError extends Error {}
export class ReprocessIntentAppliedError extends ReprocessIntentError {
  constructor(readonly intent: ReprocessIntent, cause: unknown) {
    super("Intent update was applied; backup cleanup is incomplete", { cause });
  }
}

interface StoreOperations {
  removeBackup?: (path: string) => Promise<void>;
}

// This store is intentionally separate from atomic-json-file.ts. On Windows,
// replacing an existing file requires moving it aside; a valid .bak is the
// recoverable state during that gap. A .tmp is never considered committed.
// A recovered phase is only the last locally confirmed phase: external work
// (including Python DELETE) may already have happened after that phase.
export class ReprocessIntentStore {
  constructor(private readonly root: string, private readonly operations: StoreOperations = {}) {}

  pathFor(sessionId: string): string {
    if (!sessionId || sessionId === "." || sessionId === ".." ||
      sessionId.length > 128 || /[/\\\0\x00-\x1f]/u.test(sessionId)) {
      throw new ReprocessIntentError("Invalid session ID");
    }
    // Hex uses only lowercase ASCII and remains distinct on case-insensitive Windows volumes.
    return join(this.root, `${Buffer.from(sessionId, "utf8").toString("hex")}.reprocess-intent.json`);
  }

  async read(sessionId: string): Promise<ReprocessIntent | null> {
    const path = this.pathFor(sessionId);
    const backup = `${path}.bak`;
    const primary = await readCandidate(path, sessionId);
    const saved = await readCandidate(backup, sessionId);
    if (primary.kind === "valid") return primary.intent;
    if (primary.kind === "invalid") throw new ReprocessIntentError("Corrupt primary intent");
    if (saved.kind === "valid") return saved.intent;
    if (saved.kind === "invalid") throw new ReprocessIntentError("Corrupt backup intent");
    // A leftover .tmp is not evidence that its update was committed.
    return null;
  }

  async hasPending(sessionId: string): Promise<boolean> {
    const intent = await this.read(sessionId);
    return intent !== null && intent.phase !== "completed";
  }

  async create(sessionId: string, operationId: string = randomUUID()): Promise<ReprocessIntent> {
    return this.locked(sessionId, async (path) => {
      if (await exists(path) || await exists(`${path}.bak`)) {
        throw new ReprocessIntentError("Intent already exists");
      }
      const now = new Date().toISOString();
      const intent: ReprocessIntent = {
        version: 1, sessionId, operationId, phase: "prepared", createdAt: now, updatedAt: now,
      };
      validate(intent, sessionId);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeSynced(temporary, intent);
      await fs.rename(temporary, path);
      await syncDirectory(this.root);
      return intent;
    });
  }

  async updatePhase(sessionId: string, operationId: string, phase: ReprocessPhase): Promise<ReprocessIntent> {
    return this.locked(sessionId, async (path) => {
      const current = await this.read(sessionId);
      if (current === null) throw new ReprocessIntentError("Intent does not exist");
      if (current.operationId !== operationId) throw new ReprocessIntentError("Operation ID mismatch");
      const from = reprocessPhases.indexOf(current.phase);
      const to = reprocessPhases.indexOf(phase);
      if (to !== from + 1) throw new ReprocessIntentError("Incompatible phase transition");
      if (!(await exists(path))) throw new ReprocessIntentError("Restore backup before updating");
      const backup = `${path}.bak`;
      if (await exists(backup)) await this.cleanOldBackup(path, current);
      const next: ReprocessIntent = { ...current, phase, updatedAt: new Date().toISOString() };
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeSynced(temporary, next);
      await fs.rename(path, backup);
      await syncDirectory(this.root);
      // A failed rename leaves the old confirmed phase in .bak.
      await fs.rename(temporary, path);
      try {
        await syncDirectory(this.root);
        await this.removeBackup(backup);
        await syncDirectory(this.root);
      } catch (error) {
        // The new primary is already installed. Callers must not retry external work.
        throw new ReprocessIntentAppliedError(next, error);
      }
      return next;
    });
  }

  async restoreBackup(sessionId: string): Promise<ReprocessIntent> {
    return this.locked(sessionId, async (path) => {
      if (await exists(path)) throw new ReprocessIntentError("Primary intent exists; review before restoring");
      const backup = `${path}.bak`;
      const saved = await readCandidate(backup, sessionId);
      if (saved.kind !== "valid") throw new ReprocessIntentError("No valid backup to restore");
      await fs.rename(backup, path);
      await syncDirectory(this.root);
      return saved.intent;
    });
  }

  async recoverAbandonedLock(sessionId: string): Promise<never> {
    this.pathFor(sessionId);
    // A lock file does not prove whether another Windows process still writes.
    // Stop every Dotty process, verify that no writer remains, then archive the
    // lock manually before restarting. Never remove it based on its age.
    throw new ReprocessIntentError("Cannot prove the writer is inactive; stop Dotty and review the lock manually");
  }

  private async cleanOldBackup(path: string, primary: ReprocessIntent): Promise<void> {
    const saved = await readCandidate(`${path}.bak`, primary.sessionId);
    const prior = reprocessPhases.indexOf(primary.phase) - 1;
    if (saved.kind !== "valid" || saved.intent.operationId !== primary.operationId ||
      saved.intent.createdAt !== primary.createdAt ||
      reprocessPhases.indexOf(saved.intent.phase) !== prior ||
      Date.parse(saved.intent.updatedAt) > Date.parse(primary.updatedAt)) {
      throw new ReprocessIntentError("Old backup is incompatible; review required");
    }
    await this.removeBackup(`${path}.bak`);
    await syncDirectory(this.root);
  }

  private removeBackup(path: string): Promise<void> {
    return this.operations.removeBackup?.(path) ?? fs.rm(path);
  }

  private async locked<T>(sessionId: string, action: (path: string) => Promise<T>): Promise<T> {
    const path = this.pathFor(sessionId);
    await fs.mkdir(this.root, { recursive: true });
    let lock: fs.FileHandle;
    try {
      lock = await fs.open(`${path}.lock`, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ReprocessIntentError("Intent is locked; inspect an interrupted operation");
      }
      throw error;
    }
    try {
      return await action(path);
    } finally {
      await lock.close();
      await fs.rm(`${path}.lock`, { force: true });
    }
  }
}

type Candidate = { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; intent: ReprocessIntent };

async function readCandidate(path: string, sessionId: string): Promise<Candidate> {
  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { kind: "missing" };
    throw error;
  }
  try {
    const intent = JSON.parse(content) as unknown;
    validate(intent, sessionId);
    return { kind: "valid", intent };
  } catch {
    return { kind: "invalid" };
  }
}

function validate(value: unknown, sessionId: string): asserts value is ReprocessIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid intent");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || item.sessionId !== sessionId ||
    typeof item.operationId !== "string" || item.operationId.length === 0 ||
    item.operationId.length > 128 || /[\x00-\x1f]/u.test(item.operationId) ||
    !reprocessPhases.includes(item.phase as ReprocessPhase) ||
    !validDate(item.createdAt) || !validDate(item.updatedAt) ||
    Date.parse(item.updatedAt as string) < Date.parse(item.createdAt as string)) {
    throw new Error("Invalid intent");
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

async function writeSynced(path: string, value: ReprocessIntent): Promise<void> {
  const handle = await fs.open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Directory fsync is unavailable on some Windows filesystems. The file is
  // synced, but this does not promise survival of a sudden power loss.
  const handle = await fs.open(path, constants.O_RDONLY);
  try {
    try { await handle.sync(); }
    catch (error) {
      // On this Windows runtime, opening a directory works but syncing its
      // handle returns EPERM. Do not conceal open/permission or I/O failures.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally { await handle.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await fs.access(path); return true; }
  catch (error) { if (isNotFound(error)) return false; throw error; }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
