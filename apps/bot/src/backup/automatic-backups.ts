import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { writeJsonAtomically } from "../recording/atomic-json-file.ts";
import { ActiveRecordingBackupError, type BackupManager } from "./backup-manager.ts";

type BackupService = Pick<BackupManager, "create" | "verify">;
interface Completion { key: string; fingerprint: string; sessionId: string; reason: string }
interface Receipt { fingerprint: string; backupName: string }
interface State { version: 1; receipts: Record<string, Receipt> }

/** Durable polling also catches completions that happened while the bot was off. */
export class AutomaticBackups {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly statePath: string;

  constructor(private readonly dataRoot: string, private readonly backups: BackupService,
    private readonly logger: Pick<Logger, "info" | "error">) {
    this.statePath = join(dataRoot, "backups", "automatic-state.json");
  }

  start(): void {
    if (this.timer !== undefined) return;
    const run = () => void this.tick().catch((error) => this.logger.error({ error }, "Fallo del respaldo automático; se reintentará"));
    run();
    this.timer = setInterval(run, 15_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  tick(): Promise<void> {
    return this.running ??= this.scan().finally(() => { this.running = undefined; });
  }

  /** Call only after a verified full backup; existing completions are covered by it. */
  async seedFromFullBackup(backupName: string, covered: readonly Completion[]): Promise<void> {
    const state: State = { version: 1, receipts: {} };
    for (const event of covered) state.receipts[event.key] = { fingerprint: event.fingerprint, backupName };
    await fs.mkdir(join(this.dataRoot, "backups"), { recursive: true });
    await writeJsonAtomically(this.statePath, state);
  }

  private async scan(): Promise<void> {
    let state: State;
    try {
      state = JSON.parse(await fs.readFile(this.statePath, "utf8")) as State;
      if (state.version !== 1 || !state.receipts) throw new Error("Invalid automatic backup state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 1, receipts: {} };
    }
    for (const event of await this.completions()) {
      if (state.receipts[event.key]?.fingerprint === event.fingerprint) continue;
      try {
        const backup = await this.backups.create({ sessionId: event.sessionId, reason: event.reason });
        const verification = await this.backups.verify(backup.name);
        if (!verification.valid) throw new Error(`Backup verification failed: ${backup.name}`);
        state.receipts[event.key] = { fingerprint: event.fingerprint, backupName: backup.name };
        await writeJsonAtomically(this.statePath, state);
        this.logger.info({ sessionId: event.sessionId, reason: event.reason, backup: backup.path }, "Respaldo automático verificado");
      } catch (error) {
        if (error instanceof ActiveRecordingBackupError) return; // Retry after capture closes.
        this.logger.error({ error, sessionId: event.sessionId }, "Respaldo automático pendiente; se reintentará");
      }
    }
  }

  async completions(): Promise<Completion[]> {
    const root = join(this.dataRoot, "recordings");
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const events: Completion[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
      const directory = join(root, entry.name);
      try {
        const manifest = JSON.parse(await fs.readFile(join(directory, "manifest.json"), "utf8")) as { status: string; endedAt?: string; chunks?: unknown[] };
        if (!["completed", "interrupted"].includes(manifest.status)) continue;
        events.push({ key: `${entry.name}:recording`, sessionId: entry.name, reason: "recording-finished",
          fingerprint: digest(JSON.stringify([manifest.status, manifest.endedAt, manifest.chunks])) });
        const marker = await fs.readFile(join(directory, ".transcription-ready"), "utf8").catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (marker !== null) events.push({ key: `${entry.name}:transcription`, sessionId: entry.name,
          reason: "transcription-finished", fingerprint: digest(marker) });
      } catch (error) {
        this.logger.error({ error, sessionId: entry.name }, "No se pudo inspeccionar una sesión para respaldo");
      }
    }
    return events;
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
