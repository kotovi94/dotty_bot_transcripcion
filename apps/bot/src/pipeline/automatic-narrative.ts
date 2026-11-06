import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import type { NarrativeManager } from "../narrative/narrative-manager.ts";

interface PipelineMode {
  version: 1;
  mode: "automatic" | "manual";
  automaticFrom: string;
}

export class AutomaticNarrative {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(
    private readonly dataRoot: string,
    private readonly recordingsRoot: string,
    private readonly exportsRoot: string,
    private readonly transcriberUrl: string,
    private readonly narratives: NarrativeManager,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), 15_000);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(): Promise<void> {
    if (this.scanning || this.narratives.hasActiveGeneration()) return;
    this.scanning = true;
    try {
      const mode = await this.readMode();
      if (mode.mode !== "automatic") return;
      const health = await fetch(new URL("/health", this.transcriberUrl), {
        signal: AbortSignal.timeout(3_000),
      }).then((response) => response.ok ? response.json() as Promise<{ processing_paused?: boolean }> : null);
      if (!health || health.processing_paused !== false) return;
      const entries = await fs.readdir(this.recordingsRoot, { withFileTypes: true });
      for (const entry of entries.filter((entry) => entry.isDirectory())) {
        const sessionId = entry.name;
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) continue;
        const directory = join(this.recordingsRoot, sessionId);
        const exported = join(this.exportsRoot, sessionId);
        let manifest: { sessionId?: string; status?: string; endedAt?: string };
        try { manifest = JSON.parse(await fs.readFile(join(directory, "manifest.json"), "utf8")); }
        catch { continue; }
        if (manifest.sessionId !== sessionId || manifest.status !== "completed" ||
            !manifest.endedAt || Date.parse(manifest.endedAt) < Date.parse(mode.automaticFrom)) continue;
        if (!(await exists(join(directory, ".transcription-ready"))) ||
            await exists(join(directory, ".transcription-regenerating")) ||
            await exists(join(exported, "guion.md"))) continue;
        let status: { state?: string } | null = null;
        try { status = JSON.parse(await fs.readFile(join(exported, "guion.estado.json"), "utf8")); }
        catch { /* No draft has been generated yet. */ }
        if (status?.state === "failed" || status?.state === "ready") continue;
        await this.narratives.start(sessionId);
        break;
      }
    } catch (error) {
      this.logger.warn({ error }, "No se pudo revisar la generación automática del guion; se reintentará");
    } finally {
      this.scanning = false;
    }
  }

  private async readMode(): Promise<PipelineMode> {
    const path = join(this.dataRoot, "pipeline-mode.json");
    try {
      const handle = await fs.open(path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, mode: "automatic", automaticFrom: new Date().toISOString() })}\n`);
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as Partial<PipelineMode>;
    if (parsed.version !== 1 || !["automatic", "manual"].includes(parsed.mode ?? "") ||
        typeof parsed.automaticFrom !== "string" || !Number.isFinite(Date.parse(parsed.automaticFrom))) {
      throw new Error("Configuración del flujo automático inválida");
    }
    return parsed as PipelineMode;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await fs.stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
