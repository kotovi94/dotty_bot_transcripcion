import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export type BotPhase = "starting" | "ready" | "disconnected" | "reconnecting" | "error" | "stopping";

export interface BotHeartbeat {
  version: 1;
  instanceId: string;
  pid: number;
  processStartedAt: string;
  heartbeatAt: string;
  status: BotPhase;
  connectedAt: string | null;
  userId: string | null;
}

export class BotStatusPublisher {
  readonly instanceId = randomUUID();
  readonly processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  private phase: BotPhase = "starting";
  private connectedAt: string | null = null;
  private userId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> = Promise.resolve();
  private allowStaleTakeover = false;

  constructor(private readonly path: string, private readonly discordReady: () => boolean,
    private readonly intervalMs = 2_000) {}

  async start(): Promise<void> {
    try {
      const old = JSON.parse(await readFile(this.path, "utf8")) as Partial<BotHeartbeat>;
      let alive = false;
      if (Number.isSafeInteger(old.pid) && (old.pid as number) > 0) {
        try { process.kill(old.pid as number, 0); alive = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") alive = true; }
      }
      const fresh = old.version === 1 && typeof old.heartbeatAt === "string" &&
        Date.now() - Date.parse(old.heartbeatAt) < 8_000 && Date.now() >= Date.parse(old.heartbeatAt);
      if (alive && (fresh || old.version !== 1))
        throw new Error("Otra instancia de Dotty tiene una señal de estado reciente o histórica sin verificar.");
      this.allowStaleTakeover = true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Otra instancia")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await this.publish();
    if (!await this.stillOwned()) throw new Error("No se pudo reclamar el archivo de estado del bot.");
    this.timer = setInterval(() => { void this.publish().catch(() => undefined); }, this.intervalMs);
    this.timer.unref();
  }

  setPhase(phase: BotPhase, userId?: string): Promise<void> {
    this.phase = phase;
    if (phase === "ready" && this.discordReady()) {
      if (!this.connectedAt) this.connectedAt = new Date().toISOString();
      if (userId) this.userId = userId;
    } else if (phase !== "ready") {
      this.connectedAt = null;
    }
    return this.publish();
  }

  snapshot(): BotHeartbeat {
    const ready = this.discordReady();
    const status = this.phase === "ready" && !ready ? "disconnected" : this.phase;
    if (status === "ready" && !this.connectedAt) this.connectedAt = new Date().toISOString();
    if (status !== "ready") this.connectedAt = null;
    return { version: 1, instanceId: this.instanceId, pid: process.pid,
      processStartedAt: this.processStartedAt, heartbeatAt: new Date().toISOString(),
      status, connectedAt: this.connectedAt, userId: this.userId };
  }

  publish(): Promise<void> {
    this.pending = this.pending.catch(() => undefined).then(async () => {
      const current = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (current) {
        try {
          const owner = JSON.parse(current) as Partial<BotHeartbeat>;
          if (owner.version === 1 && owner.instanceId !== this.instanceId && !this.allowStaleTakeover) return;
        } catch { /* Un estado histórico o corrupto se sustituye al iniciar. */ }
      }
      const temporary = `${this.path}.${this.instanceId}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(this.snapshot()), { encoding: "utf8", flag: "w" });
        if (await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        }) !== current) return;
        try {
          await rename(temporary, this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM" &&
              (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (await readFile(this.path, "utf8") !== current) return;
          // Windows puede impedir rename sobre un destino existente. Una lectura
          // durante la sustitución se interpreta como desconocida en el panel.
          await writeFile(this.path, await readFile(temporary));
        }
        this.allowStaleTakeover = false;
      } finally {
        await rm(temporary, { force: true });
      }
    });
    return this.pending;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.setPhase("stopping");
  }

  private async stillOwned(): Promise<boolean> {
    try {
      const current = JSON.parse(await readFile(this.path, "utf8")) as Partial<BotHeartbeat>;
      return current.version === 1 && current.instanceId === this.instanceId;
    } catch { return false; }
  }

  async removeIfOwned(): Promise<void> {
    await this.pending.catch(() => undefined);
    if (await this.stillOwned()) await rm(this.path, { force: true });
  }

  async reportIfOwned(report: Record<string, unknown>): Promise<void> {
    await this.pending.catch(() => undefined);
    if (await this.stillOwned()) await writeFile(this.path, JSON.stringify(report, null, 2), "utf8");
  }
}
