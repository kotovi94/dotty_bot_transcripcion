import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { saveTranscriptRevision } from "./transcript-edits.js";
import { writeFileAtomically } from "./atomic-file.js";
import { FailureTracker } from "./maintenance-failures.js";
import { SetupOperationLock } from "./setup-operation-lock.js";
import { evaluateBotHealth, inspectBotProcess, recentBotIdentity, type CachedBotIdentity } from "./bot-health.js";
import { promisify } from "node:util";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { shell } from "electron";
import { parseReadyMarker, verifyReadyMarker, type PublicationJob } from "../../../../packages/shared/src/transcription-ready.js";
import { SessionFileCoordinator } from "../../../bot/src/sessions/session-file-coordinator.js";

import type {
  DottyOperationError,
  EditorialFeedbackResult,
  EditorialLearningState,
  EditorialRuleView,
  EditorialScope,
  DottyState,
  LogKind,
  MaintenanceAction,
  MaintenanceState,
  OllamaHealth,
  OperationKind,
  OperationResult,
  NarrativeOperationResult,
  NarrativeReview,
  ProcessingStage,
  SaveResult,
  SessionDetails,
  SessionParticipant,
  SessionProcessingStatus,
  SystemStatus,
  TranscriptDetail,
  TranscriptSummary,
} from "../shared/contracts.js";

const execFileAsync = promisify(execFile);

interface HealthPayload {
  status?: string;
  model?: string;
  configured_device?: string;
  active_device?: string;
  active_compute_type?: string;
  model_loaded?: boolean;
  compute_type?: string;
  queue?: Partial<DottyState["transcriber"]["queue"]>;
  work?: DottyState["transcriber"]["work"];
}

const emptyQueue = {
  queued: 0,
  processing: 0,
  completed: 0,
  failed: 0,
};

export class DottySupervisor {
  dataRoot: string;
  exportsRoot: string;
  recordingsRoot: string;
  private readonly failureTracker = new FailureTracker();
  private lastBotProcess: CachedBotIdentity | null = null;

  private operation: {
    kind: OperationKind;
    startedAt: string;
    process: ChildProcessWithoutNullStreams;
  } | null = null;

  constructor(readonly projectRoot: string, private readonly spawnOperation: typeof spawn = spawn) {
    this.dataRoot = join(projectRoot, "data");
    this.exportsRoot = join(this.dataRoot, "exports");
    this.recordingsRoot = join(this.dataRoot, "recordings");
    this.reloadConfiguration();
  }

  reloadConfiguration(): void {
    let configuredData = "./data";
    try {
      const line = readFileSync(join(this.projectRoot, ".env"), "utf8")
        .split(/\r?\n/)
        .find((entry) => entry.startsWith("DOTTY_DATA_DIR="));
      if (line) configuredData = line.slice("DOTTY_DATA_DIR=".length).trim();
    } catch { /* El asistente todavía no ha creado la configuración. */ }
    this.dataRoot = resolve(this.projectRoot, configuredData);
    this.exportsRoot = join(this.dataRoot, "exports");
    this.recordingsRoot = join(this.dataRoot, "recordings");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
  }

  async getState(): Promise<DottyState> {
    const [bot, health] = await Promise.all([
      this.readBotState(),
      this.readHealth(),
    ]);
    if (health.work?.session_id) {
      const manifest = await this.readManifest(health.work.session_id);
      const sequence = manifest?.sequenceNumber;
      const campaign = manifest?.campaignName;
      health.work.session_label = typeof sequence === "number"
        ? `Sesión ${sequence}${typeof campaign === "string" ? ` · ${campaign}` : ""}`
        : health.work.session_id;
    }
    return {
      timestamp: new Date().toISOString(),
      bot,
      transcriber: health,
      operation: this.operation
        ? { kind: this.operation.kind, startedAt: this.operation.startedAt }
        : null,
    };
  }

  async getSystemStatus(): Promise<SystemStatus> {
    const [state, ollama] = await Promise.all([
      this.getState(),
      this.readOllamaHealth(),
    ]);
    const lastSession = await this.findLastSessionSummary();
    return {
      timestamp: new Date().toISOString(),
      bot: state.bot,
      transcriber: state.transcriber,
      ollama,
      lastSession,
    };
  }

  async getSessionDetails(sessionId: string): Promise<SessionDetails | null> {
    const normalized = this.validateSessionIdOrThrow(sessionId);
    const [manifest, transcript, narrativeStatus, sessionMetadata] = await Promise.all([
      this.readManifest(normalized),
      this.readTranscriptText(normalized),
      this.readNarrativeStatus(normalized),
      this.readSessionMetadata(normalized),
    ]);
    if (!manifest && !sessionMetadata) return null;

    const startedAt = typeof manifest?.startedAt === "string" ? manifest.startedAt : sessionMetadata?.startedAt ?? null;
    const endedAt = typeof manifest?.endedAt === "string" ? manifest.endedAt : sessionMetadata?.endedAt ?? null;
    const durationSeconds = this.computeDurationSeconds(startedAt, endedAt);
    const participants = this.extractParticipants(manifest, transcript);

    const processing = this.getSessionProcessingStatus(normalized);
    const errors = this.normalizeErrors(manifest, narrativeStatus);

    const sequenceValue = typeof manifest?.sequenceNumber === "number" ? manifest.sequenceNumber : sessionMetadata?.sequenceNumber;
    const statusValue = typeof manifest?.status === "string" ? String(manifest.status) : sessionMetadata?.status;
    const campaignValue = manifest?.campaignId && typeof manifest.campaignName === "string"
      ? { id: String(manifest.campaignId), name: String(manifest.campaignName) }
      : sessionMetadata?.campaign ?? null;

    return {
      id: normalized,
      ...(typeof sequenceValue === "number" ? { sequence: sequenceValue } : {}),
      ...(typeof statusValue === "string" ? { status: statusValue } : {}),
      campaign: campaignValue,
      startedAt,
      endedAt,
      ...(durationSeconds !== null ? { durationSeconds } : {}),
      participants,
      files: {
        transcript: transcript ? this.transcriptPath(normalized) : null,
        narrative: narrativeStatus.state !== "missing" ? this.narrativePath(normalized) : null,
        manifest: manifest ? join(this.recordingsRoot, normalized, "manifest.json") : null,
      },
      processing: await processing,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  async getSessionProcessingStatus(sessionId: string): Promise<SessionProcessingStatus> {
    const normalized = this.validateSessionIdOrThrow(sessionId);
    const manifest = await this.readManifest(normalized);
    const status = this.computeProcessingStatus(normalized, manifest);
    return status;
  }

  async getRecentProcessingSessions(limit = 5): Promise<Array<{ sessionId: string; label: string }>> {
    const entries = await readdir(this.recordingsRoot, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/u.test(entry.name))
      .map(async (entry) => {
        const manifest = await this.readManifest(entry.name);
        if (!manifest) return null;
        return {
          sessionId: entry.name,
          label: `${typeof manifest.campaignName === "string" ? manifest.campaignName : "Campaña"} · sesión ${typeof manifest.sequenceNumber === "number" ? manifest.sequenceNumber : entry.name}`,
          startedAt: typeof manifest.startedAt === "string" ? manifest.startedAt : "",
        };
      }));
    return sessions.filter((session): session is NonNullable<typeof session> => session !== null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
      .map(({ sessionId, label }) => ({ sessionId, label }));
  }

  async runOperation(kind: OperationKind): Promise<OperationResult> {
    if (this.operation) {
      return {
        accepted: false,
        message: "Ya hay una operacion de Dotty en curso.",
      };
    }

    if (kind !== "start") {
      const activeRecording = await this.findProtectedRecording();
      if (activeRecording !== null) {
        return {
          accepted: false,
          message: activeRecording.status === "finalizing"
            ? "Dotty está cerrando una grabación. Espera a que termine antes de apagar o reiniciar."
            : "Hay una grabación activa o pausada. Finalízala desde Discord antes de apagar o reiniciar Dotty.",
        };
      }
    }

    const scriptNames: Record<OperationKind, string> = {
      start: "start-dotty.ps1",
      stop: "stop-dotty.ps1",
      restart: "restart-dotty.ps1",
      disconnect: "stop-dotty.ps1",
    };
    const scriptPath = join(this.projectRoot, "tools", scriptNames[kind]);
    const child = this.spawnOperation(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        cwd: this.projectRoot,
        windowsHide: true,
        stdio: "pipe",
      },
    );
    this.operation = {
      kind,
      startedAt: new Date().toISOString(),
      process: child,
    };

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("close", async (code) => {
      const stamp = new Date().toISOString();
      const output = [
        `[${stamp}] ${kind} finalizado con codigo ${code ?? "desconocido"}`,
        Buffer.concat(stdout).toString("utf8").trim(),
        Buffer.concat(stderr).toString("utf8").trim(),
      ]
        .filter(Boolean)
        .join("\n");
      await writeFile(join(this.dataRoot, "desktop-panel.log"), output, "utf8").catch(
        () => undefined,
      );
      if (kind === "disconnect" && code === 0) await this.cleanDottyArtifacts();
      this.operation = null;
    });
    child.once("error", async (error) => {
      await writeFile(
        join(this.dataRoot, "desktop-panel.log"),
        `[${new Date().toISOString()}] ${error.stack ?? error.message}`,
        "utf8",
      ).catch(() => undefined);
      this.operation = null;
    });

    return { accepted: true, message: "Operacion iniciada." };
  }

  async disconnect(): Promise<OperationResult> {
    return this.runOperation("disconnect");
  }

  async restoreBotIcon(): Promise<OperationResult> {
    const source = join(this.projectRoot, "apps", "control-panel", "src", "renderer", "assets", "dotty-bot.png");
    const target = join(this.projectRoot, "apps", "control-panel", "resources", "dotty-icon.png");
    try {
      await stat(source);
      await copyFile(source, target);
      return { accepted: true, message: "Icono del panel restaurado desde el asset oficial de Dotty." };
    } catch (error) {
      return { accepted: false, message: `No se pudo restaurar el icono del panel: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async cleanDottyArtifacts(): Promise<void> {
    // stop-dotty.ps1 owns process references and removes them only after
    // verifying that the corresponding shutdown completed.
    await rm(join(this.exportsRoot, ".narrative-engine.lock"), { force: true });
    const entries = await readdir(this.exportsRoot, { withFileTypes: true }).catch(() => [] as Dirent[]);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => rm(join(this.exportsRoot, entry.name, ".guion-generando"), { force: true })),
    );
  }

  async listTranscripts(): Promise<TranscriptSummary[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.exportsRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const results = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<TranscriptSummary | null> => {
          const sessionId = entry.name;
          const transcriptPath = this.transcriptPath(sessionId);
          try {
            const [content, fileStat, manifest, narrative, review] = await Promise.all([
              readFile(transcriptPath, "utf8"),
              stat(transcriptPath),
              this.readManifest(sessionId),
              this.readNarrativeStatus(sessionId),
              this.readNarrativeReview(sessionId, false),
            ]);
            const firstLine = content.split(/\r?\n/, 1)[0] ?? sessionId;
            const processing = await this.getSessionProcessingStatus(sessionId);
            const participants = this.extractParticipants(manifest, content);
            const startedAt = typeof manifest?.startedAt === "string" ? manifest.startedAt : null;
            const endedAt = typeof manifest?.endedAt === "string" ? manifest.endedAt : null;
            const durationSeconds = this.computeDurationSeconds(startedAt, endedAt);
            return {
              sessionId,
              title: firstLine.replace(/^#\s+/, "").trim() || sessionId,
              updatedAt: fileStat.mtime.toISOString(),
              status: typeof manifest?.status === "string" ? manifest.status : null,
              canOpenDiscord: Boolean(
                manifest?.discordGuildId &&
                  ((manifest.publication as { threadId?: unknown; channelId?: unknown } | undefined)?.threadId
                    || (manifest.publication as { channelId?: unknown } | undefined)?.channelId),
              ),
              narrativeState: narrative.state,
              narrativeProgress: narrative.progress,
              narrativePhase: narrative.phase,
              narrativeError: narrative.error ?? null,
              narrativeReviewState: review?.state ?? null,
              narrativeReviewPendingCount: review?.scenes.filter((scene) => scene.status === "NEEDS_REVIEW").length ?? 0,
              campaignName: typeof manifest?.campaignName === "string" ? manifest.campaignName : null,
              sequenceNumber: typeof manifest?.sequenceNumber === "number" ? manifest.sequenceNumber : null,
              startedAt,
              endedAt,
              durationSeconds,
              participants,
              processing,
              errors: this.normalizeErrors(manifest, narrative),
            };
          } catch {
            return null;
          }
        }),
    );
    return results
      .filter((entry): entry is TranscriptSummary => entry !== null)
      .sort((a, b) =>
        (b.endedAt ?? b.startedAt ?? b.updatedAt)
          .localeCompare(a.endedAt ?? a.startedAt ?? a.updatedAt),
      );
  }

  async readTranscript(sessionId: string): Promise<TranscriptDetail> {
    const summary = (await this.listTranscripts()).find(
      (entry) => entry.sessionId === sessionId,
    );
    if (!summary) throw new Error("No se encontro la bitacora seleccionada.");
    return {
      ...summary,
      content: await readFile(this.transcriptPath(sessionId), "utf8"),
      narrativeContent: await readFile(this.narrativePath(sessionId), "utf8").catch(() => null),
      narrativeReview: await this.readNarrativeReview(sessionId, true),
    };
  }

  async saveTranscript(sessionId: string, content: string): Promise<SaveResult> {
    const path = this.transcriptPath(sessionId);
    return new SessionFileCoordinator(join(this.dataRoot, "session-locks")).runExclusive(sessionId,
      () => saveTranscriptRevision(path, sessionId, content,
        () => this.invalidateNarrativeAfterTranscriptEdit(sessionId)), { timeoutMs: 5_000 });
  }

  async regenerateRaw(sessionId: string): Promise<OperationResult> {
    return new SetupOperationLock(this.projectRoot).run(async () => {
    this.validateSessionId(sessionId);
    const manifest = await this.readManifest(sessionId);
    const result = await this.transcriberRequest(
      `/v1/sessions/${encodeURIComponent(sessionId)}/retranscribe`, "POST",
    ) as { state?: string; queued?: number; total?: number; backup?: boolean };
    if (manifest?.status === "interrupted") {
      const python = join(this.projectRoot, "services", "transcriber", ".venv", "Scripts", "python.exe");
      const script = join(this.projectRoot, "tools", "recover-session-transcript.py");
      const worker = spawn(python, [script, sessionId, this.dataRoot, "--redo"], {
        cwd: this.projectRoot,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        worker.once("spawn", resolveSpawn);
        worker.once("error", rejectSpawn);
      });
      worker.unref();
    }
    await this.invalidateNarrativeAfterTranscriptEdit(sessionId);
    return {
      accepted: true,
      message: result.state === "running"
        ? "La transcripción ya se está rehaciendo. El raw actual sigue disponible hasta completar el nuevo."
        : `${Number(result.queued ?? 0)} de ${Number(result.total ?? 0)} fragmentos enviados de nuevo al transcriptor. ${result.backup ? "Se guardó un único respaldo del raw anterior." : "No había raw anterior para respaldar."}`,
    };
    });
  }

  async saveNarrative(sessionId: string, content: string): Promise<SaveResult> {
    if (content.length > 5_000_000) throw new Error("El guion es demasiado grande.");
    if (content.trim().length < 100) throw new Error("El guion está vacío o incompleto.");
    const narrativePath = this.narrativePath(sessionId);
    const exportDirectory = dirname(narrativePath);
    await stat(this.transcriptPath(sessionId));
    await mkdir(exportDirectory, { recursive: true });

    let backupName: string | undefined;
    if (await this.pathExists(narrativePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupName = `guion.respaldo-${stamp}.md`;
      await copyFile(narrativePath, join(exportDirectory, backupName));
    }

    await this.invalidateNarrativeAfterTranscriptEdit(sessionId);
    await writeFileAtomically(narrativePath, `${content.trim()}\n`);
    await writeFile(
      join(exportDirectory, "guion.estado.json"),
      `${JSON.stringify({
        state: "generating",
        sessionId,
        model: "manual",
        progress: 0.95,
        phase: "Verificando la edición manual",
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    try {
      await this.runBotScript(
        join("apps", "bot", "scripts", "editorial-cli.ts"),
        ["verify", sessionId],
        120_000,
      );
      const review = await this.readNarrativeReview(sessionId, false);
      await this.writeNarrativeReviewStatus(sessionId, review);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeNarrativeReviewStatus(sessionId, null, message);
    }
    return { saved: true, ...(backupName === undefined ? {} : { backupName }) };
  }

  async getEditorialLearning(sessionId: string): Promise<EditorialLearningState> {
    this.validateSessionId(sessionId);
    return this.runEditorialState(sessionId);
  }

  async submitEditorialFeedback(sessionId: string, comment: string, editedVersion: string): Promise<EditorialFeedbackResult> {
    this.validateSessionId(sessionId);
    if (editedVersion.length > 5_000_000) throw new Error("El guion es demasiado grande.");
    const exportDirectory = dirname(this.narrativePath(sessionId));
    const generatedVersion = await readFile(join(exportDirectory, "guion.generado.md"), "utf8")
      .catch(() => readFile(this.narrativePath(sessionId), "utf8"));
    return this.runEditorialRequest<EditorialFeedbackResult>("submit", {
      sessionId,
      generatedVersion,
      editedVersion,
      comment: comment.slice(0, 4_000),
    });
  }

  async decideEditorialRule(ruleId: string, decision: "approve" | "reject" | "deprecate", scope?: EditorialScope): Promise<EditorialRuleView> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(ruleId)) throw new Error("Regla editorial inválida.");
    return this.runEditorialRequest<EditorialRuleView>("decide", { ruleId, decision, ...(scope ? { scope } : {}) });
  }

  async rollbackEditorialRule(ruleId: string): Promise<EditorialRuleView> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(ruleId)) throw new Error("Regla editorial inválida.");
    const { stdout } = await this.runBotScript(join("apps", "bot", "scripts", "editorial-cli.ts"), ["rollback", ruleId], 120_000);
    return this.parseEditorialResult<EditorialRuleView>(stdout);
  }

  async generateNarrative(sessionId: string): Promise<NarrativeOperationResult> {
    this.validateSessionId(sessionId);
    const startedAt = Date.now();
    try {
      await this.runBotScript(
        join("apps", "bot", "scripts", "narrative-cli.ts"),
        ["generate", sessionId],
        3 * 60 * 60_000,
      );
      return { ok: true, message: "Guion narrativo generado y listo para revisar." };
    } catch (error) {
      const status = await this.readNarrativeStatus(sessionId);
      const fallback = error instanceof Error ? error.message.split(/\r?\n/u)[0] : String(error);
      const freshFailure = status.state === "failed" && status.updatedAt
        && Date.parse(status.updatedAt) >= startedAt;
      const reason = freshFailure && status.error ? status.error : fallback;
      return { ok: false, message: `No se pudo generar el guion: ${reason}` };
    }
  }

  async verifyNarrative(sessionId: string): Promise<NarrativeOperationResult> {
    this.validateSessionId(sessionId);
    try {
      await this.runBotScript(
        join("apps", "bot", "scripts", "editorial-cli.ts"),
        ["verify", sessionId],
        120_000,
      );
      const review = await this.readNarrativeReview(sessionId, false);
      await this.writeNarrativeReviewStatus(sessionId, review);
      return { ok: true, message: "Verificación editorial actualizada." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `No se pudo verificar el guion: ${message.slice(-600)}` };
    }
  }

  async approveNarrativeScene(sessionId: string, sceneId: string): Promise<NarrativeOperationResult> {
    this.validateSessionId(sessionId);
    if (!/^scene_\d+$/u.test(sceneId) && sceneId !== "manual") {
      return { ok: false, message: "La escena indicada no es válida." };
    }
    try {
      await this.runBotScript(
        join("apps", "bot", "scripts", "narrative-cli.ts"),
        ["approve-scene", sessionId, sceneId],
        120_000,
      );
      await this.writeNarrativeReviewStatus(sessionId, await this.readNarrativeReview(sessionId, false));
      return { ok: true, message: "Escena revisada y aceptada manualmente." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `No se pudo aceptar la escena: ${message.slice(-600)}` };
    }
  }

  async approveNarrative(sessionId: string): Promise<NarrativeOperationResult> {
    this.validateSessionId(sessionId);
    try {
      await this.runBotScript(
        join("apps", "bot", "scripts", "narrative-cli.ts"),
        ["approve", sessionId],
        120_000,
      );
      await this.writeNarrativeReviewStatus(sessionId, await this.readNarrativeReview(sessionId, false));
      return { ok: true, message: "Guion aprobado y habilitado para publicar." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `No se pudo aprobar el guion: ${message.slice(-600)}` };
    }
  }

  async publishNarrative(sessionId: string): Promise<NarrativeOperationResult> {
    this.validateSessionId(sessionId);
    try {
      await this.runBotScript(
        join("apps", "bot", "scripts", "narrative-cli.ts"),
        ["publish", sessionId],
        20 * 60_000,
      );
      return { ok: true, message: "Guion publicado manualmente en Discord." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `No se pudo publicar el guion: ${message.slice(-600)}` };
    }
  }

  async openTranscript(sessionId: string): Promise<void> {
    const error = await shell.openPath(this.transcriptPath(sessionId));
    if (error) throw new Error(error);
  }

  async openTranscriptFolder(sessionId: string): Promise<void> {
    shell.showItemInFolder(this.transcriptPath(sessionId));
  }

  async openDiscord(sessionId: string): Promise<boolean> {
    const manifest = await this.readManifest(sessionId);
    const guildId = manifest?.discordGuildId;
    const publication = manifest?.publication as { threadId?: unknown; channelId?: unknown } | undefined;
    const targetId = typeof publication?.threadId === "string"
      ? publication.threadId
      : typeof publication?.channelId === "string" ? publication.channelId : null;
    if (typeof guildId !== "string" || targetId === null) return false;
    await shell.openExternal(`https://discord.com/channels/${guildId}/${targetId}`);
    return true;
  }

  async openDataFolder(): Promise<void> {
    const error = await shell.openPath(this.dataRoot);
    if (error) throw new Error(error);
  }

  async readLogs(kind: LogKind): Promise<string> {
    const paths: Record<LogKind, string[]> = {
      bot: ["dotty.stdout.log", "dotty.stderr.log"],
      transcriber: ["transcriber.stdout.log", "transcriber.stderr.log"],
      lifecycle: ["startup.log", "shutdown.log"],
      panel: ["desktop-panel.log", "panel-operation.stderr.log"],
    };
    const sections = await Promise.all(
      paths[kind].map(async (name) => {
        const content = await this.readTail(join(this.dataRoot, name));
        return content ? `===== ${name} =====\n${content}` : "";
      }),
    );
    return sections.filter(Boolean).join("\n\n") || "Aun no hay actividad para mostrar.";
  }

  async getMaintenanceState(): Promise<MaintenanceState> {
    const snapshot = await this.failureTracker.query(() => this.transcriberRequest("/v1/failures"));
    const failures = new Map(snapshot.sessions.map((item) => [item.sessionId, item]));

    const bot = await this.readBotState();
    let entries: Dirent[];
    let localScanAvailable = true;
    try {
      entries = await readdir(this.recordingsRoot, { withFileTypes: true });
    } catch {
      entries = [];
      localScanAvailable = false;
    }
    const issues = [];
    const matchedFailures = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.readManifest(entry.name);
      if (!manifest) continue;
      const status = typeof manifest.status === "string" ? manifest.status : "desconocido";
      const failed = failures.get(entry.name);
      if (failed) matchedFailures.add(entry.name);
      const failedMarker = await this.pathExists(join(this.recordingsRoot, entry.name, ".transcription-failed"));
      let recovery: { phase?: string; enqueued?: number; completed?: number; total?: number; failed?: number; error?: string } | null = null;
      try {
        recovery = JSON.parse(await readFile(join(this.dataRoot, "recovered-audio", entry.name, "transcription.status.json"), "utf8"));
      } catch { /* La recuperación de texto aún no comenzó. */ }
      const staleActive = ["recording", "paused", "finalizing"].includes(status) && !bot.connected;
      const staleFinalizing = status === "finalizing" && Date.now() - (manifest.endedAt ? Date.parse(String(manifest.endedAt)) : 0) > 120_000;
      const recoverable = status === "interrupted" || staleActive || staleFinalizing || failedMarker;
      if (!recoverable && !failed) continue;
      const sequence = manifest.sequenceNumber;
      const campaign = manifest.campaignName;
      issues.push({
        sessionId: entry.name,
        title: `${typeof campaign === "string" ? campaign : "Campaña"}${typeof sequence === "number" ? ` · Sesión ${sequence}` : ""}`,
        status: recovery?.phase === "completed"
          ? "transcripción recuperada"
          : recovery?.phase === "transcribing" || recovery?.phase === "enqueuing"
            ? Number(recovery.enqueued ?? 0) < Number(recovery.total ?? 0)
              ? `enviando ${Number(recovery.enqueued ?? 0)}/${Number(recovery.total ?? 0)} fragmentos`
              : `transcribiendo ${Number(recovery.completed ?? 0)}/${Number(recovery.total ?? 0)} fragmentos`
            : staleActive ? "grabación detenida inesperadamente" : failedMarker ? "transcripción fallida" : status,
        chunks: Array.isArray(manifest.chunks) ? manifest.chunks.length : 0,
        failedJobs: failed?.failedJobs ?? 0,
        lastError: recovery?.error ?? failed?.lastError ?? null,
        canRecover: recoverable && recovery?.phase !== "completed" && Array.isArray(manifest.chunks) && manifest.chunks.length > 0,
        canRetry: (failed?.failedJobs ?? 0) > 0,
      });
    }
    for (const failed of snapshot.sessions) {
      if (matchedFailures.has(failed.sessionId)) continue;
      issues.push({
        sessionId: failed.sessionId,
        title: `Sesión ${failed.sessionId}`,
        status: "transcripción fallida",
        chunks: 0,
        failedJobs: failed.failedJobs,
        lastError: failed.lastError,
        canRecover: false,
        canRetry: /^[a-zA-Z0-9_-]+$/u.test(failed.sessionId),
      });
    }
    return { checkedAt: new Date().toISOString(), issues, localScanAvailable, failureQuery: snapshot.query };
  }

  async runMaintenanceAction(
    action: MaintenanceAction,
    sessionId: string,
  ): Promise<OperationResult> {
    return new SetupOperationLock(this.projectRoot).run(async () => {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Sesión inválida.");
    if (action === "retry-failed") {
      const result = await this.transcriberRequest(
        `/v1/sessions/${encodeURIComponent(sessionId)}/retry`,
        "POST",
      ) as { retried?: number };
      await rm(join(this.recordingsRoot, sessionId, ".transcription-failed"), { force: true });
      return {
        accepted: true,
        message: `${Number(result.retried ?? 0)} fragmentos enviados nuevamente a la cola.`,
      };
    }

    const python = join(this.projectRoot, "services", "transcriber", ".venv", "Scripts", "python.exe");
    const script = join(this.projectRoot, "tools", "recover-session-audio.py");
    const { stdout } = await execFileAsync(python, [script, sessionId, this.dataRoot], {
      cwd: this.projectRoot,
      windowsHide: true,
      timeout: 600_000,
      maxBuffer: 1024 * 1024,
    });
    const output = stdout.trim().split(/\r?\n/u).at(-1);
    if (!output || !await this.pathExists(join(output, "recovery.json"))) {
      throw new Error("La recuperación de audio no devolvió archivos verificados.");
    }
    const transcriptScript = join(this.projectRoot, "tools", "recover-session-transcript.py");
    if (!await this.pathExists(transcriptScript)) throw new Error("Falta el recuperador de transcripciones.");
    const worker = spawn(python, [transcriptScript, sessionId, this.dataRoot], {
      cwd: this.projectRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      worker.once("spawn", () => resolveSpawn());
      worker.once("error", rejectSpawn);
    });
    worker.unref();
    return { accepted: true, message: `Recuperación iniciada: Dotty transcribirá los fragmentos conservados. El avance aparecerá en Herramientas y el texto en ${output}.` };
    });
  }

  private async readBotState(): Promise<DottyState["bot"]> {
    try {
      const payload = JSON.parse(
        await readFile(join(this.dataRoot, "dotty.status.json"), "utf8"),
      ) as Record<string, unknown>;
      const pid = payload.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return evaluateBotHealth(payload, null);
      try {
        const identity = await inspectBotProcess(pid as number);
        if (identity) this.lastBotProcess = { identity, at: Date.now() };
        else this.lastBotProcess = null;
        return evaluateBotHealth(payload, identity);
      } catch {
        const previous = recentBotIdentity(this.lastBotProcess, pid as number);
        return previous ? evaluateBotHealth(payload, previous) :
          { running: false, connected: false, pid: null, connectedAt: null, status: "unknown",
            reason: "No se pudo consultar la identidad del proceso Node." };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const oldPid = await readFile(join(this.dataRoot, "dotty.pid"), "utf8").catch(() => "");
        return oldPid.trim() ? { running: false, connected: false, pid: null, connectedAt: null,
          status: "unknown", reason: "Existe un PID anterior sin señal verificable del bot." } :
          { running: false, connected: false, pid: null, connectedAt: null, status: "stopped", reason: null };
      }
      return { running: false, connected: false, pid: null, connectedAt: null,
        status: "unknown", reason: "El estado del bot no se pudo leer." };
    }
  }

  private async findProtectedRecording(): Promise<{ status: string } | null> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.recordingsRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.readManifest(entry.name);
      const status = typeof manifest?.status === "string" ? manifest.status : "";
      if (status === "recording" || status === "paused") return { status };
      if (status === "finalizing") {
        const endedAt = typeof manifest?.endedAt === "string" ? Date.parse(manifest.endedAt) : Date.now();
        if (!Number.isFinite(endedAt) || Date.now() - endedAt < 120_000) return { status };
      }
    }
    return null;
  }

  private async readHealth(): Promise<DottyState["transcriber"]> {
    try {
      const response = await fetch("http://127.0.0.1:8765/health", {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = (await response.json()) as HealthPayload;
      return {
        available: health.status === "ok",
        model: health.model ?? null,
        configuredDevice: health.configured_device ?? null,
        activeDevice: health.model_loaded === false ? null : health.active_device ?? null,
        computeType: health.active_compute_type ?? health.compute_type ?? null,
        queue: { ...emptyQueue, ...health.queue },
        work: health.work ?? null,
      };
    } catch {
      return {
        available: false,
        model: null,
        configuredDevice: null,
        activeDevice: null,
        computeType: null,
        queue: { ...emptyQueue },
        work: null,
      };
    }
  }

  private async readOllamaHealth(): Promise<OllamaHealth> {
    const configuredModel = this.readEnvironmentValue("OLLAMA_MODEL") || "qwen3:4b";
    try {
      const response = await fetch(new URL("/api/tags", "http://127.0.0.1:11434"), {
        signal: AbortSignal.timeout(2_500),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
      const models = (payload.models ?? []).flatMap((item) => [item.name, item.model]).filter((value): value is string => typeof value === "string" && value.trim() !== "");
      const available = models.some((model) => model === configuredModel || model === `${configuredModel}:latest`);
      return {
        available,
        modelConfigured: configuredModel,
        modelsAvailable: Array.from(new Set(models)).sort(),
        error: available ? null : "El modelo configurado no está instalado localmente.",
      };
    } catch (error) {
      return {
        available: false,
        modelConfigured: configuredModel,
        modelsAvailable: [],
        error: error instanceof Error ? error.message : "Sin respuesta de Ollama.",
      };
    }
  }

  private async transcriberRequest(path: string, method = "GET", timeoutMs = 10_000): Promise<unknown> {
    const configured = this.readEnvironmentValue("TRANSCRIBER_SHARED_SECRET");
    const secret = configured && configured !== "replace-with-a-long-random-local-secret"
      ? configured
      : (await readFile(join(this.dataRoot, "transcriber.secret"), "utf8")).trim();
    const baseUrl = this.readEnvironmentValue("TRANSCRIBER_BASE_URL") || "http://127.0.0.1:8765";
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { detail?: unknown } | null;
      const detail = typeof payload?.detail === "string" ? payload.detail : `HTTP ${response.status}`;
      throw new Error(`El transcriptor rechazó la operación (HTTP ${response.status}): ${detail}.`);
    }
    return response.json();
  }

  private async runEditorialState(sessionId: string): Promise<EditorialLearningState> {
    const { stdout } = await this.runBotScript(join("apps", "bot", "scripts", "editorial-cli.ts"), ["state", sessionId], 120_000);
    return this.parseEditorialResult<EditorialLearningState>(stdout);
  }

  private async runEditorialRequest<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    const directory = join(this.dataRoot, "editorial-requests");
    await mkdir(directory, { recursive: true });
    const requestPath = join(directory, `request-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(requestPath, JSON.stringify(payload), "utf8");
    try {
      const { stdout } = await this.runBotScript(join("apps", "bot", "scripts", "editorial-cli.ts"), [action, requestPath], 120_000);
      return this.parseEditorialResult<T>(stdout);
    } finally {
      await rm(requestPath, { force: true });
    }
  }

  private parseEditorialResult<T>(stdout: string): T {
    const lastLine = stdout.trim().split(/\r?\n/u).at(-1);
    if (!lastLine) throw new Error("La operación editorial no devolvió resultado.");
    const payload = JSON.parse(lastLine) as { ok?: boolean; result?: T };
    if (payload.ok !== true || payload.result === undefined) throw new Error("Respuesta editorial inválida.");
    return payload.result;
  }

  private async runBotScript(
    scriptRelativePath: string,
    args: readonly string[],
    timeout: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const configuredNpm = this.readEnvironmentValue("DOTTY_NPM_EXECUTABLE");
    const adjacentNode = configuredNpm === ""
      ? ""
      : join(dirname(configuredNpm), "node.exe");
    const nodeExecutable = adjacentNode !== "" && await this.pathExists(adjacentNode)
      ? adjacentNode
      : "node.exe";
    const tsxCli = join(this.projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const scriptPath = join(this.projectRoot, scriptRelativePath);
    if (!await this.pathExists(tsxCli) || !await this.pathExists(scriptPath)) {
      throw new Error("Faltan componentes locales de Dotty. Repara la instalación desde Configuración.");
    }
    return execFileAsync(nodeExecutable, [tsxCli, scriptPath, ...args], {
      cwd: this.projectRoot,
      windowsHide: true,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
  }

  private readEnvironmentValue(key: string): string {
    try {
      const line = readFileSync(join(this.projectRoot, ".env"), "utf8")
        .split(/\r?\n/u)
        .find((entry) => entry.startsWith(`${key}=`));
      return line?.slice(key.length + 1).trim().replace(/^"|"$/gu, "") ?? "";
    } catch {
      return "";
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private transcriptPath(sessionId: string): string {
    this.validateSessionId(sessionId);
    const path = resolve(this.exportsRoot, sessionId, "bitacora.md");
    if (relative(this.exportsRoot, path).startsWith("..")) {
      throw new Error("La ruta solicitada no es valida.");
    }
    return path;
  }

  private narrativePath(sessionId: string): string {
    this.validateSessionId(sessionId);
    const path = resolve(this.exportsRoot, sessionId, "guion.md");
    if (relative(this.exportsRoot, path).startsWith("..")) {
      throw new Error("La ruta solicitada no es válida.");
    }
    return path;
  }

  private async readNarrativeStatus(sessionId: string): Promise<{
    state: "missing" | "queued" | "generating" | "ready" | "failed";
    progress: number;
    phase: string;
    error?: string;
    updatedAt?: string;
  }> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.exportsRoot, sessionId, "guion.estado.json"), "utf8"),
      ) as {
        state?: unknown;
        progress?: unknown;
        phase?: unknown;
        error?: string;
        updatedAt?: unknown;
      };
      const scriptExists = await this.pathExists(this.narrativePath(sessionId));
      const state = parsed.state === "queued" || parsed.state === "generating" || parsed.state === "failed" || parsed.state === "missing"
        ? parsed.state
        : scriptExists ? "ready" : "missing";
      return {
        state,
        progress: typeof parsed.progress === "number" && Number.isFinite(parsed.progress)
          ? Math.max(0, Math.min(1, parsed.progress))
          : state === "ready" ? 1 : 0,
        phase: typeof parsed.phase === "string" && parsed.phase.trim() !== ""
          ? parsed.phase
          : state === "ready" ? "Guion disponible" : "Sin generar",
        ...(typeof parsed.error === "string" && parsed.error.trim() !== "" ? { error: parsed.error } : {}),
        ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
      };
    } catch {
      const ready = await this.pathExists(this.narrativePath(sessionId));
      return { state: ready ? "ready" : "missing", progress: ready ? 1 : 0, phase: ready ? "Guion disponible" : "Sin generar" };
    }
  }

  private async writeNarrativeReviewStatus(
    sessionId: string,
    review: NarrativeReview | null,
    verificationError?: string,
  ): Promise<void> {
    const approved = review?.state === "APPROVED";
    const readyForApproval = review?.state === "READY_FOR_REVIEW";
    const state = "ready";
    const phase = approved
      ? "Guion aprobado para publicar"
      : readyForApproval
        ? "Guion verificado; aprobación final pendiente"
        : verificationError
          ? "Guion guardado; la verificación falló"
          : "Guion disponible; requiere correcciones antes de publicar";
    await writeFile(
      join(this.exportsRoot, sessionId, "guion.estado.json"),
      `${JSON.stringify({
        state,
        sessionId,
        model: "manual",
        progress: 1,
        phase,
        updatedAt: new Date().toISOString(),
        ...(verificationError ? { error: verificationError.slice(-600) } : {}),
      }, null, 2)}\n`,
      "utf8",
    );
  }

  private async readNarrativeReview(sessionId: string, includeIssues: boolean): Promise<NarrativeReview | null> {
    this.validateSessionId(sessionId);
    const exportDirectory = resolve(this.exportsRoot, sessionId);
    try {
      const review = JSON.parse(
        await readFile(join(exportDirectory, "guion.revision.json"), "utf8"),
      ) as NarrativeReview;
      const normalizedReview: NarrativeReview = {
        ...review,
        scenes: review.scenes.map((scene) => ({ ...scene, blockers: scene.blockers ?? [], issues: scene.issues ?? [] })),
      };
      if (!includeIssues) return normalizedReview;
      const scenes = await Promise.all(normalizedReview.scenes.map(async (scene) => {
        if (!/^scene_\d+$/u.test(scene.id)) return { ...scene, issues: scene.issues ?? [] };
        try {
          const artifact = JSON.parse(
            await readFile(join(exportDirectory, "guion.work", `${scene.id}.json`), "utf8"),
          ) as {
            audit?: {
              auditStatus?: string;
              reason?: string;
              reviewReason?: string;
              issues?: Array<{ type?: string; severity?: string; reason?: string; sceneText?: string }>;
            };
          };
          const issues = (artifact.audit?.issues ?? [])
            .filter((issue) => issue.severity === "error" || issue.severity === "warning")
            .map((issue) => ({
              ...(issue.type ? { type: issue.type } : {}),
              severity: issue.severity as "error" | "warning",
              reason: issue.reason ?? "Observación editorial sin detalle.",
              ...(issue.sceneText ? { sceneText: issue.sceneText } : {}),
            }));
          return {
            ...scene,
            issues,
            ...(artifact.audit?.auditStatus ? { auditStatus: artifact.audit.auditStatus } : {}),
            ...((artifact.audit?.reviewReason ?? artifact.audit?.reason)
              ? { reviewReason: artifact.audit?.reviewReason ?? artifact.audit?.reason }
              : {}),
          };
        } catch {
          return { ...scene, issues: scene.issues ?? [] };
        }
      }));
      return { ...review, scenes };
    } catch {
      return null;
    }
  }

  private validateSessionId(sessionId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error("Sesión inválida.");
  }

  private async readManifest(sessionId: string): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(
        await readFile(join(this.recordingsRoot, basename(sessionId), "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async readTranscriptText(sessionId: string): Promise<string | null> {
    try {
      return await readFile(this.transcriptPath(sessionId), "utf8");
    } catch {
      return null;
    }
  }

  private async invalidateNarrativeAfterTranscriptEdit(sessionId: string): Promise<void> {
    const exportDirectory = join(this.exportsRoot, sessionId);
    const reviewPath = join(exportDirectory, "guion.revision.json");
    try {
      const current = JSON.parse(await readFile(reviewPath, "utf8")) as NarrativeReview;
      const { approval: _approval, ...withoutApproval } = current;
      await writeFileAtomically(reviewPath, `${JSON.stringify({
        ...withoutApproval,
        state: "NEEDS_REVIEW",
        reason: "SOURCE_TRANSCRIPT_CHANGED",
        updatedAt: new Date().toISOString(),
        scenes: current.scenes.map((scene) => ({
          ...scene,
          status: "NEEDS_REVIEW",
          approvedAt: undefined,
          approvedBy: undefined,
        })),
      }, (_key, value) => value === undefined ? undefined : value, 2)}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (await this.pathExists(this.narrativePath(sessionId))) {
      try {
        const statusPath = join(exportDirectory, "guion.estado.json");
        const previous = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
        await writeFile(statusPath, `${JSON.stringify({
          ...previous,
          state: "ready",
          progress: 1,
          phase: "Transcripción corregida; regenera el guion antes de publicarlo",
          updatedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
      } catch {
        // La revisión ya quedó invalidada; el estado es solo información visual.
      }
    }
  }

  private async readSessionMetadata(sessionId: string): Promise<{ id: string; campaign?: { id: string; name: string } | null; sequenceNumber?: number; status?: string; startedAt?: string | null; endedAt?: string | null } | null> {
    try {
      const manifest = await this.readManifest(sessionId);
      if (!manifest) return null;
      const sequenceNumber = typeof manifest.sequenceNumber === "number" ? manifest.sequenceNumber : undefined;
      const status = typeof manifest.status === "string" ? manifest.status : undefined;
      const startedAt = typeof manifest.startedAt === "string" ? manifest.startedAt : null;
      const endedAt = typeof manifest.endedAt === "string" ? manifest.endedAt : null;
      return {
        id: sessionId,
        campaign: typeof manifest.campaignId === "string" && typeof manifest.campaignName === "string"
          ? { id: manifest.campaignId, name: manifest.campaignName }
          : null,
        ...(typeof sequenceNumber === "number" ? { sequenceNumber } : {}),
        ...(typeof status === "string" ? { status } : {}),
        startedAt,
        endedAt,
      };
    } catch {
      return null;
    }
  }

  private computeDurationSeconds(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
    if (!startedAt || !endedAt) return null;
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const duration = Math.max(0, Math.round((end - start) / 1000));
    return duration > 0 ? duration : null;
  }

  private extractParticipants(manifest: Record<string, unknown> | null, transcript: string | null): SessionParticipant[] {
    const unique = new Map<string, SessionParticipant>();
    const chunkSpeakers = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
    for (const chunk of chunkSpeakers) {
      if (!chunk || typeof chunk !== "object") continue;
      const speakerName = typeof (chunk as { speakerName?: unknown }).speakerName === "string" ? (chunk as { speakerName: string }).speakerName : null;
      const speakerUserId = typeof (chunk as { speakerUserId?: unknown }).speakerUserId === "string" ? (chunk as { speakerUserId: string }).speakerUserId : null;
      if (!speakerName) continue;
      const key = speakerUserId ?? speakerName;
      if (!unique.has(key)) unique.set(key, { name: speakerName, userId: speakerUserId ?? null, source: "manifest" });
    }
    if (transcript) {
      const transcriptMatches = [...transcript.matchAll(/\[(\d{1,2}:\d{2}:\d{2})\]\s*\*\*(.+?):\*\*/g)];
      for (const match of transcriptMatches) {
        const speaker = match[2]?.trim();
        if (!speaker) continue;
        const key = speaker;
        if (!unique.has(key)) unique.set(key, { name: speaker, source: "transcript" });
      }
    }
    return Array.from(unique.values()).slice(0, 30);
  }

  private async findLastSessionSummary(): Promise<{ id: string; title: string } | null> {
    try {
      const entries = await readdir(this.exportsRoot, { withFileTypes: true });
      const candidates = await Promise.all(
        entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
          try {
            const transcriptPath = this.transcriptPath(entry.name);
            const [fileStat, manifest] = await Promise.all([
              stat(transcriptPath),
              this.readManifest(entry.name),
            ]);
            const endedAt = typeof manifest?.endedAt === "string" ? manifest.endedAt : null;
            const startedAt = typeof manifest?.startedAt === "string" ? manifest.startedAt : null;
            const parsed = Date.parse(endedAt ?? startedAt ?? fileStat.mtime.toISOString());
            return {
              sessionId: entry.name,
              transcriptPath,
              timestamp: Number.isFinite(parsed) ? parsed : fileStat.mtimeMs,
            };
          } catch {
            return null;
          }
        }),
      );
      const ordered = candidates
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((a, b) => b.timestamp - a.timestamp);
      for (const candidate of ordered) {
        try {
          const content = await readFile(candidate.transcriptPath, "utf8");
          const firstLine = content.split(/\r?\n/, 1)[0] ?? candidate.sessionId;
          return {
            id: candidate.sessionId,
            title: firstLine.replace(/^#\s+/, "").trim() || candidate.sessionId,
          };
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private normalizeErrors(manifest: Record<string, unknown> | null, narrative: { error?: string }): DottyOperationError[] {
    const errors: DottyOperationError[] = [];
    const narrativeError = typeof narrative?.error === "string" ? narrative.error : null;
    if (narrativeError) {
      const sessionId = manifest?.sessionId ? String(manifest.sessionId) : undefined;
      errors.push({
        source: "narrative",
        message: narrativeError,
        ...(sessionId ? { sessionId } : {}),
        timestamp: new Date().toISOString(),
      });
    }
    return errors;
  }

  private async readTranscriptionEvidence(
    sessionId: string, manifest: Record<string, unknown> | null, hasTranscript: boolean,
  ): Promise<NonNullable<SessionProcessingStatus["transcriptionEvidence"]>> {
    try {
      return await new SessionFileCoordinator(join(this.dataRoot, "session-locks")).runExclusive(
        sessionId, () => this.readTranscriptionEvidenceLocked(sessionId, manifest, hasTranscript),
        { timeoutMs: 250 },
      );
    } catch {
      return { availability: "unavailable", publication: "unavailable", total: null,
        queued: null, processing: null, completed: null, failed: null };
    }
  }

  private async readTranscriptionEvidenceLocked(
    sessionId: string, manifest: Record<string, unknown> | null, hasTranscript: boolean,
  ): Promise<NonNullable<SessionProcessingStatus["transcriptionEvidence"]>> {
    type Evidence = NonNullable<SessionProcessingStatus["transcriptionEvidence"]>;
    const empty = (availability: Evidence["availability"], publication: Evidence["publication"]): Evidence => ({
      availability, publication, total: null, queued: null, processing: null, completed: null, failed: null,
    });
    const directory = join(this.recordingsRoot, sessionId);
    const existsStrict = async (path: string): Promise<boolean> => {
      try { await stat(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    };
    let entries: string[];
    let regenerating: boolean;
    let enqueued: boolean;
    let intentText: string | null;
    let intentEntries: string[];
    const intentPrefix = `${Buffer.from(sessionId, "utf8").toString("hex")}.reprocess-intent.json`;
    try { [entries, regenerating, enqueued, intentText, intentEntries] = await Promise.all([
      readdir(join(directory, ".transcription-jobs")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      }),
      existsStrict(join(directory, ".transcription-regenerating")),
      existsStrict(join(directory, ".transcription-enqueued")),
      readFile(join(this.dataRoot, "reprocess-intents", intentPrefix), "utf8")
        .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error)),
      readdir(join(this.dataRoot, "reprocess-intents")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      }),
    ]); } catch { return empty("unavailable", "unavailable"); }
    let intentPending = false;
    if (intentText !== null) {
      try {
        const intent = JSON.parse(intentText) as { sessionId?: string; phase?: string };
        intentPending = intent.sessionId !== sessionId || intent.phase !== "completed";
      } catch { intentPending = true; }
    }
    const intentUncertain = intentEntries.some((entry) => entry.startsWith(`${intentPrefix}.`));
    const pendingMutation = entries.some((entry) => entry.endsWith(".posting")) || regenerating || intentPending || intentUncertain ||
      (manifest?.status === "completed" && !enqueued);
    let payload: unknown;
    try {
      payload = await this.transcriberRequest(`/v1/sessions/${encodeURIComponent(sessionId)}`, "GET", 1_500);
    } catch { return { ...empty("unavailable", "unavailable"), pendingMutation }; }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { ...empty("invalid", "unavailable"), pendingMutation };
    }
    const response = payload as { session_id?: unknown; jobs?: unknown };
    if (response.session_id !== sessionId || !Array.isArray(response.jobs) || response.jobs.some((job) =>
      job === null || typeof job !== "object" || typeof (job as Record<string, unknown>).id !== "string" ||
      !(job as { id: string }).id.startsWith(`${sessionId}:`) ||
      !["queued", "processing", "completed", "failed"].includes((job as { status: string }).status))) {
      return { ...empty("invalid", "unavailable"), pendingMutation };
    }
    const jobs = response.jobs as PublicationJob[];
    const counts = {
      total: jobs.length,
      queued: jobs.filter((job) => job.status === "queued").length,
      processing: jobs.filter((job) => job.status === "processing").length,
      completed: jobs.filter((job) => job.status === "completed").length,
      failed: jobs.filter((job) => job.status === "failed").length,
    };
    const markerPath = join(directory, ".transcription-ready");
    let marker: string | null;
    try { marker = await readFile(markerPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { availability: "available", publication: "unavailable", ...counts, pendingMutation };
      marker = null;
    }
    if (marker === null) return { availability: "available", publication: "missing", ...counts, pendingMutation };
    const parsed = parseReadyMarker(marker);
    if (parsed.kind !== "verifiable") return { availability: "available", publication: parsed.kind, ...counts, pendingMutation };
    if (parsed.marker.session_id !== sessionId) return { availability: "available", publication: "stale", ...counts, pendingMutation };
    if (!hasTranscript) return { availability: "available", publication: "stale", ...counts, pendingMutation };
    const chunks = manifest?.chunks;
    if (!Array.isArray(chunks) || chunks.length !== jobs.length || chunks.some((chunk) =>
      chunk === null || typeof chunk !== "object" ||
      !jobs.some((job) => job.id === `${sessionId}:${(chunk as { id?: unknown }).id}`))) {
      return { availability: "available", publication: "stale", ...counts, pendingMutation };
    }
    try {
      const bytes = await readFile(this.transcriptPath(sessionId));
      return { availability: "available", publication: verifyReadyMarker(marker, sessionId, jobs, bytes) === "verified" ? "verified" : "stale", ...counts, pendingMutation };
    } catch { return { availability: "available", publication: "unavailable", ...counts, pendingMutation }; }
  }

  private async computeProcessingStatus(sessionId: string, manifest: Record<string, unknown> | null): Promise<SessionProcessingStatus> {
    const exportDirectory = join(this.exportsRoot, sessionId);
    const [transcript, script, narrative, review, evidenceBundle, transcriptRaw, qualityReport, generationState, recovery, publicationAttempt, publicationLock, regenerationMarker] = await Promise.all([
      readFile(this.transcriptPath(sessionId), "utf8").catch(() => null),
      readFile(this.narrativePath(sessionId), "utf8").catch(() => null),
      this.readNarrativeStatus(sessionId),
      this.readNarrativeReview(sessionId, false),
      readFile(join(exportDirectory, "guion.evidencias.json"), "utf8")
        .then((content) => JSON.parse(content) as { blocks?: Array<{ evidenceIds?: unknown[]; evidence?: { extraction_status?: unknown } }> })
        .catch(() => null),
      readFile(join(exportDirectory, "transcript.raw.json"), "utf8")
        .then((content) => JSON.parse(content) as { quality?: { linesToReview?: number }; diagnostics?: unknown[] })
        .catch(() => null),
      readFile(join(this.dataRoot, ".diagnostics", sessionId, "transcription-report.json"), "utf8")
        .then((content) => JSON.parse(content) as { outcome?: "success" | "warning" | "failure"; summary?: { linesToReview?: number; suspectedHallucinations?: number; unintelligible?: number } })
        .catch(() => null),
      readFile(join(exportDirectory, "guion.work", "generation-state.json"), "utf8")
        .then((content) => JSON.parse(content) as { lastBlock?: number; lastScene?: number })
        .catch(() => null),
      readFile(join(this.dataRoot, "recovered-audio", sessionId, "transcription.status.json"), "utf8")
        .then((content) => JSON.parse(content) as { phase?: string; completed?: number; total?: number; failed?: number })
        .catch(() => null),
      readFile(join(this.recordingsRoot, sessionId, ".publication-attempt.json"), "utf8")
        .then((content) => JSON.parse(content) as { totalMessages?: number; steps?: Array<{ messageId?: string }> })
        .catch(() => null),
      this.pathExists(join(this.recordingsRoot, sessionId, ".publication.lock")),
      this.pathExists(join(this.recordingsRoot, sessionId, ".transcription-regenerating")),
    ]);
    const regenerating = regenerationMarker;
    const transcriptionEvidence = await this.readTranscriptionEvidence(sessionId, manifest, Boolean(transcript?.trim()));
    const regenerationTotal = transcriptionEvidence.total ?? 0;
    const regenerationCompleted = transcriptionEvidence.completed ?? 0;
    const regenerationFailed = transcriptionEvidence.failed ?? 0;
    const recordingStatus = typeof manifest?.status === "string" ? String(manifest.status) : "unknown";
    const recordingActive = ["recording", "paused", "finalizing"].includes(recordingStatus);
    const recordingComplete = recordingStatus === "completed";
    const publication = manifest?.publication as { threadId?: unknown; messageIds?: unknown } | undefined;
    const published = typeof publication?.threadId === "string"
      || (Array.isArray(publication?.messageIds) && publication.messageIds.length > 0);
    const scenes = review?.scenes ?? [];
    const pendingScenes = scenes.filter((scene) => scene.status === "NEEDS_REVIEW").length;
    const structuralBlockers = scenes.reduce((count, scene) => count + (scene.blockers?.length ?? 0), 0);
    const sceneErrors = scenes.reduce((count, scene) => count + scene.errorCount, 0);
    const sceneWarnings = scenes.reduce((count, scene) => count + scene.warningCount, 0);
    const scriptAssembled = script !== null
      && /^#\s+ESCENA\b/imu.test(script)
      && (transcript === null || script.trim() !== transcript.trim());
    const generationRunning = narrative.state === "generating" || narrative.state === "queued";
    const reviewBlocked = review?.state === "NEEDS_REVIEW";
    const approved = review?.state === "APPROVED";
    const readyForApproval = review?.state === "READY_FOR_REVIEW";
    const evidenceBlocks = evidenceBundle?.blocks ?? [];
    const failedEvidenceBlocks = evidenceBlocks.filter((block) => block.evidence?.extraction_status === "EVIDENCE_EXTRACTION_FAILED").length;
    const emptyEvidenceBlocks = evidenceBlocks.filter((block) => !Array.isArray(block.evidenceIds) || block.evidenceIds.length === 0).length;
    const qualityOutcome = qualityReport?.outcome;
    const qualityWarnings = Number(qualityReport?.summary?.linesToReview ?? transcriptRaw?.quality?.linesToReview ?? 0)
      + Number(qualityReport?.summary?.suspectedHallucinations ?? transcriptRaw?.diagnostics?.length ?? 0)
      + Number(qualityReport?.summary?.unintelligible ?? 0);
    const recoveryTotal = Number(recovery?.total ?? 0);
    const recoveryCompleted = Number(recovery?.completed ?? 0);
    const publicationTotal = Number(publicationAttempt?.totalMessages ?? 0);
    const publicationSent = publicationAttempt?.steps?.filter((step) => typeof step.messageId === "string").length ?? 0;
    const transcriptVerified = Boolean(transcript?.trim()) && transcriptionEvidence.availability === "available" &&
      transcriptionEvidence.publication === "verified" && transcriptionEvidence.pendingMutation !== true &&
      transcriptionEvidence.total !== null && transcriptionEvidence.total > 0 &&
      transcriptionEvidence.completed === transcriptionEvidence.total &&
      transcriptionEvidence.failed === 0 && transcriptionEvidence.processing === 0 && transcriptionEvidence.queued === 0;

    const stages: ProcessingStage[] = [
      {
        id: "capture",
        label: "Captura de audio",
        status: recordingActive ? "running" : recordingComplete ? "completed" : recordingStatus === "interrupted" ? "warning" : recordingStatus === "failed" ? "error" : "unknown",
        details: recordingActive ? `Sesión ${recordingStatus}` : recordingComplete ? "Grabación cerrada" : recordingStatus === "interrupted" ? "Grabación interrumpida" : recordingStatus === "failed" ? "Grabación fallida" : "Sin estado de grabación",
        artifact: "manifest.json",
      },
      {
        id: "transcription",
        label: "Transcripción",
        status: transcriptionEvidence.failed && transcriptionEvidence.failed > 0 || recovery?.phase === "failed" || recovery?.phase === "error" ? "error"
          : transcriptionEvidence.processing && transcriptionEvidence.processing > 0 || regenerating || recovery?.phase === "transcribing" || recovery?.phase === "enqueuing" ? "running"
          : transcriptionEvidence.queued && transcriptionEvidence.queued > 0 ? "pending"
          : transcriptionEvidence.pendingMutation ? "pending"
          : transcriptVerified ? "completed"
          : transcriptionEvidence.publication === "stale" || transcriptionEvidence.publication === "legacy-unverifiable" ? "warning"
          : transcriptionEvidence.availability === "unavailable" || transcriptionEvidence.availability === "invalid" ? "unknown"
          : transcriptionEvidence.publication === "missing" ? "pending"
          : transcriptionEvidence.total === 0 || recordingActive ? "pending" : "unknown",
        details: regenerating ? regenerationTotal > 0 ? `Rehaciendo raw: ${regenerationCompleted} de ${regenerationTotal} fragmentos` : "Preparando nueva transcripción"
          : transcriptionEvidence.publication === "verified" ? "Publicación y trabajos vigentes verificados"
          : transcriptionEvidence.publication === "legacy-unverifiable" ? "Bitácora histórica sin huellas verificables"
          : transcriptionEvidence.publication === "stale" ? "Bitácora anterior o modificada; publicación pendiente"
          : transcriptionEvidence.availability !== "available" ? "No se pudo verificar el estado de los trabajos"
          : transcriptionEvidence.publication === "missing" && transcriptionEvidence.total &&
            transcriptionEvidence.completed === transcriptionEvidence.total ? "Trabajos terminados; publicación pendiente"
          : transcriptionEvidence.total ? `${transcriptionEvidence.completed} de ${transcriptionEvidence.total} trabajos completados` : "Sin trabajos verificables",
        ...(regenerating && regenerationTotal > 0 ? { current: regenerationCompleted, total: regenerationTotal, progress: regenerationCompleted / regenerationTotal } : recoveryTotal > 0 ? { current: recoveryCompleted, total: recoveryTotal, progress: recoveryCompleted / recoveryTotal } : {}),
        ...(regenerating && regenerationFailed > 0 ? { errors: regenerationFailed } : recovery?.failed ? { errors: recovery.failed } : {}),
        ...(transcript?.trim() ? { artifact: "bitacora.md" } : {}),
      },
      {
        id: "raw_quality",
        label: "Calidad del raw",
        status: regenerating ? "running" : !transcriptVerified && transcriptRaw !== null ? "warning" : qualityOutcome === "failure" ? "error" : qualityOutcome === "warning" || qualityWarnings > 0 ? "warning" : transcriptRaw !== null ? "completed" : transcript !== null ? "warning" : "pending",
        details: regenerating ? "El raw anterior sigue disponible mientras se procesa el nuevo" : qualityReport !== null
          ? qualityOutcome === "success" ? "Informe de calidad sin alertas" : `${qualityWarnings} elementos requieren revisión`
          : transcriptRaw !== null ? "Raw disponible; informe consolidado pendiente" : transcript !== null ? "No hay raw para auditar" : "Esperando transcripción",
        warnings: qualityWarnings,
        ...(transcriptRaw !== null ? { artifact: "transcript.raw.json" } : {}),
      },
      {
        id: "evidence",
        label: "Extracción de evidencias",
        status: failedEvidenceBlocks > 0 ? "warning" : evidenceBundle !== null ? "completed" : generationRunning ? "running" : transcript !== null ? "pending" : "unknown",
        details: evidenceBundle !== null
          ? failedEvidenceBlocks > 0 || emptyEvidenceBlocks > 0
            ? `${evidenceBlocks.length} bloques; ${failedEvidenceBlocks} fallidos y ${emptyEvidenceBlocks} sin evidencia trazable`
            : `${evidenceBlocks.length} bloques procesados`
          : generationRunning ? narrative.phase : "Sin evidencias extraídas",
        ...(generationState?.lastBlock !== undefined ? { current: generationState.lastBlock } : {}),
        errors: failedEvidenceBlocks,
        warnings: emptyEvidenceBlocks,
        ...(evidenceBundle !== null ? { artifact: "guion.evidencias.json" } : {}),
      },
      {
        id: "scenes",
        label: "Redacción de escenas",
        status: structuralBlockers > 0 ? "blocked" : scenes.length > 0 ? "completed" : generationRunning ? "running" : "pending",
        details: structuralBlockers > 0 ? `${structuralBlockers} bloqueos estructurales` : scenes.length > 0 ? `${scenes.length} escenas generadas` : "Sin escenas verificables",
        ...(generationState?.lastScene !== undefined ? { current: generationState.lastScene } : {}),
        ...(scenes.length > 0 ? { total: scenes.length } : {}),
        errors: structuralBlockers,
        ...(scenes.length > 0 ? { artifact: "guion.work" } : {}),
      },
      {
        id: "audit",
        label: "Auditoría por escena",
        status: pendingScenes > 0 ? "blocked" : review !== null ? "completed" : generationRunning ? "running" : "pending",
        details: pendingScenes > 0 ? `${pendingScenes} escenas requieren acción` : review !== null ? "Auditoría consolidada" : "Aún no ejecutada",
        errors: sceneErrors,
        warnings: sceneWarnings,
        ...(review !== null ? { artifact: "guion.revision.json" } : {}),
      },
      {
        id: "assembly",
        label: "Ensamblado del guion",
        status: scriptAssembled ? "completed" : script !== null ? "blocked" : generationRunning ? "running" : "pending",
        details: scriptAssembled ? "Guion narrativo ensamblado" : script !== null ? "El guion no tiene estructura narrativa válida" : "Esperando escenas válidas",
        ...(script !== null ? { artifact: "guion.md" } : {}),
      },
      {
        id: "verification",
        label: "Verificación final",
        status: review?.verification.valid ? "completed" : review !== null ? "blocked" : "pending",
        details: review === null ? "No ejecutada" : review.verification.valid ? `${review.verification.warningCount} avisos` : `${review.verification.errorCount} errores`,
        ...(review !== null ? {
          errors: review.verification.errorCount,
          warnings: review.verification.warningCount,
          artifact: "guion.verificacion.json",
        } : {}),
      },
      {
        id: "approval",
        label: "Aprobación humana",
        status: approved ? "completed" : readyForApproval ? "pending" : reviewBlocked ? "blocked" : "pending",
        details: approved ? "Aprobado para publicación" : readyForApproval ? "Esperando aprobación final" : reviewBlocked ? "Bloqueada hasta corregir incidencias" : "Aún no disponible",
      },
      {
        id: "publication",
        label: "Publicación en Discord",
        status: published && (!approved || !transcriptVerified) ? "warning" : published ? "completed" : approved ? "pending" : "blocked",
        details: published && !approved ? "Existe una publicación anterior; el contenido actual requiere revisión" : published ? "Publicación confirmada" : approved ? "Lista para publicar" : "Requiere aprobación previa",
        ...(publicationAttempt !== null ? {
          status: publicationLock ? "running" as const : "blocked" as const,
          details: publicationLock
            ? publicationTotal > 0 ? `${publicationSent} de ${publicationTotal} mensajes enviados a Discord` : "Preparando la publicación en Discord"
            : "Publicación interrumpida; revisa Discord antes de reintentar",
          ...(publicationTotal > 0 ? { current: publicationSent, total: publicationTotal, progress: Math.min(1, publicationSent / publicationTotal) } : {}),
        } : {}),
      },
    ];

    const state: SessionProcessingStatus["state"] = regenerating
      ? regenerationFailed > 0 ? "error" : "transcribing"
      : publicationAttempt !== null && publicationLock
      ? "publishing"
      : publicationAttempt !== null
        ? "error"
      : narrative.state === "failed"
      ? "error"
      : recordingActive
        ? "recording"
        : generationRunning
          ? "generating_narrative"
          : reviewBlocked
            ? "review_blocked"
            : readyForApproval
              ? "awaiting_approval"
                : approved && published && stages[1]!.status === "completed"
                ? "completed"
                : approved
                  ? "narrative_ready"
                  : recovery?.phase === "transcribing" || recovery?.phase === "enqueuing"
                    ? "transcribing"
                    : transcriptionEvidence.publication === "verified" && stages[1]!.status === "completed"
                    ? "transcript_ready"
                    : "unknown";
    const narrativeStage = stages.find((stage) => stage.id === "verification")!;
    const publicationStage = stages.find((stage) => stage.id === "publication")!;
    return {
      sessionId,
      transcriptionEvidence,
      state,
      audio: { status: stages[0]!.status, details: stages[0]!.details },
      transcription: { status: stages[1]!.status, details: stages[1]!.details },
      narrative: { status: reviewBlocked ? "blocked" : narrative.state === "failed" ? "error" : generationRunning ? "running" : approved ? "completed" : narrativeStage.status, details: narrative.phase },
      publication: { status: publicationStage.status, details: publicationStage.details },
      stages,
      narrativeProgress: narrative.progress,
      narrativePhase: narrative.phase,
      updatedAt: new Date().toISOString(),
    };
  }

  private validateSessionIdOrThrow(sessionId: string): string {
    const normalized = String(sessionId ?? "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) throw new Error("Sesión inválida.");
    return normalized;
  }

  private async readTail(path: string, maxBytes = 160_000): Promise<string> {
    let handle;
    try {
      const fileStat = await stat(path);
      const length = Math.min(fileStat.size, maxBytes);
      handle = await open(path, "r");
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, fileStat.size - length));
      return buffer.toString("utf8").trim();
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
