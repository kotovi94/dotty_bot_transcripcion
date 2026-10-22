import { randomBytes } from "node:crypto";
import { constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { Logger } from "pino";
import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { DottyDiagnostics } from "../diagnostics/dotty-diagnostics.ts";
import {
  baseTranscriptionVocabulary,
  priorityTranscriptionHotwords,
} from "./base-vocabulary.ts";
import { loadTranscriptCorrections } from "./transcript-corrections.ts";
import type { AdaptiveVocabularyStore } from "./adaptive-vocabulary.ts";
import type { SessionService } from "../sessions/session-service.ts";
import type { SessionFileCoordinator } from "../sessions/session-file-coordinator.ts";
import type { ReprocessIntentStore } from "../sessions/reprocess-intent-store.ts";

interface RecordingManifest {
  readonly version: 1 | 2;
  readonly sessionId: string;
  readonly campaignId: string;
  readonly discordGuildId: string;
  readonly campaignName?: string;
  readonly status: string;
  readonly clips?: readonly {
    readonly clipIndex: number;
    readonly transcriptionStatus: string;
  }[];
  readonly chunks: readonly {
    readonly id: string;
    readonly speakerUserId: string;
    readonly file: string;
    readonly startedOffsetMs: number;
    readonly clipIndex?: number;
  }[];
}

function isEligible(manifest: RecordingManifest, chunk: RecordingManifest["chunks"][number]): boolean {
  if (manifest.version === 1 || manifest.clips === undefined) return manifest.status === "completed";
  const clip = manifest.clips.find((item) => item.clipIndex === (chunk.clipIndex ?? 1));
  return clip !== undefined && clip.transcriptionStatus !== "recording";
}

export class TranscriptionDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    private readonly recordingsRoot: string,
    private readonly campaigns: CampaignService,
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly adaptiveVocabulary: AdaptiveVocabularyStore,
    private readonly logger: Logger,
    private readonly sessions: Pick<SessionService, "findById">,
    private readonly coordinator: SessionFileCoordinator,
    private readonly intents: Pick<ReprocessIntentStore, "read">,
    private readonly diagnostics?: Pick<DottyDiagnostics, "recordActivity">,
  ) {}

  start(): void {
    void this.dispatchCompleted();
    this.timer = setInterval(() => void this.dispatchCompleted(), 5_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async dispatchCompleted(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const directories = await fs.readdir(this.recordingsRoot, { withFileTypes: true });
      for (const entry of directories) {
        if (!entry.isDirectory()) continue;
        try {
          await this.dispatchDirectory(join(this.recordingsRoot, entry.name));
        } catch (error) {
          this.logger.warn(
            { error, directory: entry.name },
            "No se pudo encolar una sesión; las demás continuarán",
          );
          await this.report({
            sessionId: entry.name,
            component: "transcription",
            process: "dispatch",
            outcome: "failure",
            issue: "SESSION_DISPATCH_FAILED",
            message: "No se pudo enviar la sesión al transcriptor local.",
            evidence: ["dispatch_exception_captured", "other_sessions_continue"],
            error,
          });
        }
      }
    } catch (error) {
      this.logger.debug({ error }, "Transcriptor local no disponible; se reintentara");
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatchDirectory(directory: string): Promise<void> {
    const sessionId = basename(directory);
    if (await markerExists(join(directory, ".transcription-enqueued"))) return;
    let manifestText: string;
    let manifest: RecordingManifest;
    try {
      manifestText = await fs.readFile(join(directory, "manifest.json"), "utf8");
      manifest = JSON.parse(manifestText) as RecordingManifest;
    } catch {
      return;
    }
    if (manifest.sessionId !== sessionId || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) return;

    const contextStarted = performance.now();
    const transcriptionContext = await this.buildContext(manifest);
    await this.report({
      sessionId: manifest.sessionId,
      component: "transcription",
      process: "context",
      outcome: "success",
      message: "Contexto de campaña preparado para Whisper.",
      durationMs: performance.now() - contextStarted,
      evidence: ["campaign_context_loaded", "hotwords_built", "known_corrections_loaded"],
      metrics: {
        prompt_chars: transcriptionContext.initialPrompt.length,
        hotwords_chars: transcriptionContext.hotwords.length,
      },
    });

    const eligible = manifest.chunks.filter((chunk) => isEligible(manifest, chunk));
    let newlyQueued = 0;
    for (const chunk of eligible) {
      const jobMarkers = join(directory, ".transcription-jobs");
      const jobMarker = join(jobMarkers, chunk.id);
      const postingMarker = join(jobMarkers, `${chunk.id}.posting`);
      const body = await this.coordinator.runExclusive(sessionId, async () => {
        if (!(await this.validate(directory, manifestText, chunk.id))) return;
        if (await jobMarkerExists(jobMarker)) return;
        await fs.mkdir(jobMarkers).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        if (await markerExists(postingMarker)) {
          // Legacy date-only markers cannot be replayed: their original request is unknown.
          const saved = await fs.readFile(postingMarker, "utf8");
          try {
            const parsed = JSON.parse(saved) as { version?: number; body?: string };
            if (parsed.version !== 1 || typeof parsed.body !== "string") return;
            const request = JSON.parse(parsed.body) as { id?: string };
            return request.id === `${sessionId}:${chunk.id}` ? parsed.body : undefined;
          } catch { return; }
        }
        const requestBody = JSON.stringify({
          id: `${sessionId}:${chunk.id}`,
          audio_path: resolve(directory, chunk.file),
          speaker_user_id: chunk.speakerUserId,
          start_offset_ms: chunk.startedOffsetMs,
          language: "es",
          initial_prompt: transcriptionContext.initialPrompt,
          hotwords: transcriptionContext.hotwords,
        });
        await writeSyncedMarker(postingMarker, `${JSON.stringify({ version: 1, body: requestBody })}\n`);
        await syncDirectory(jobMarkers);
        return requestBody;
      });
      if (body === undefined) continue;
      // Python may now acquire the same session lock before its SQLite transaction.
      const queuedAt = performance.now();
      const response = await fetch(new URL("/v1/jobs", this.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) throw new Error(`Transcriber rejected or could not reconcile job: HTTP ${response.status}.`);
      await this.coordinator.runExclusive(sessionId, async () => {
        // Keep the durable request if the manifest changed while POST was in flight.
        if (!(await this.validate(directory, manifestText, chunk.id))) return;
        if (await jobMarkerExists(jobMarker)) return;
        const saved = JSON.parse(await fs.readFile(postingMarker, "utf8")) as { version?: number; body?: string };
        if (saved.version !== 1 || saved.body !== body) return;
        await writeSyncedMarker(jobMarker);
        await syncDirectory(jobMarkers);
        await fs.rm(postingMarker);
        await syncDirectory(jobMarkers);
        newlyQueued += 1;
        await this.report({
          sessionId, component: "transcription", process: "enqueue_job", outcome: "success",
          message: "Fragmento de audio aceptado por el transcriptor.",
          durationMs: performance.now() - queuedAt,
          evidence: ["http_request_ok", "job_marker_written"],
          metrics: { speaker_user_id: chunk.speakerUserId, start_offset_ms: chunk.startedOffsetMs, clip_index: chunk.clipIndex ?? 1 },
        });
      });
    }
    if (newlyQueued > 0) {
      this.logger.info(
        { sessionId: manifest.sessionId, chunks: newlyQueued },
        "[Transcription] closed clips queued",
      );
    }
    if (manifest.status === "completed" && eligible.length === manifest.chunks.length) {
      const finalWritten = await this.coordinator.runExclusive(sessionId, async () => {
        if (!(await this.validate(directory, manifestText))) return false;
        for (const chunk of manifest.chunks) {
          if (!(await jobMarkerExists(join(directory, ".transcription-jobs", chunk.id)))) return false;
        }
        await fs.writeFile(join(directory, ".transcription-enqueued"), `${new Date().toISOString()}\n`, { flag: "wx" });
        return true;
      });
      if (!finalWritten) return;
      this.logger.info(
        { sessionId: manifest.sessionId, chunks: manifest.chunks.length },
        "Grabacion completa enviada al transcriptor",
      );
      await this.report({
        sessionId: manifest.sessionId,
        component: "transcription",
        process: "dispatch",
        outcome: "success",
        message: "Todos los fragmentos elegibles de la sesión fueron enviados al transcriptor.",
        evidence: ["all_chunks_eligible", "session_enqueue_marker_written"],
        metrics: {
          chunks_total: manifest.chunks.length,
          chunks_eligible: eligible.length,
          chunks_queued_now: newlyQueued,
        },
      });
    }
  }

  private async validate(directory: string, expectedManifest: string, chunkId?: string): Promise<boolean> {
    const sessionId = basename(directory);
    const session = await this.sessions.findById(sessionId);
    if (session === null || session.id !== sessionId) return false;
    const intent = await this.intents.read(sessionId);
    // Provisional policy until reprocess phases have an operational driver:
    // absent/completed may dispatch; prepared, delete-confirmed, recovering and
    // redispatch-ready must wait. read() errors also fail closed.
    if (intent !== null && intent.phase !== "completed") return false;
    let currentText: string;
    try { currentText = await fs.readFile(join(directory, "manifest.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (currentText !== expectedManifest) return false;
    const manifest = JSON.parse(currentText) as RecordingManifest;
    const campaign = await this.campaigns.findByGuildAndName(session.discordGuildId, session.campaignName);
    if (campaign === null || manifest.sessionId !== sessionId || manifest.campaignId !== campaign.id ||
      (manifest.campaignName !== undefined && manifest.campaignName !== session.campaignName) ||
      manifest.discordGuildId !== session.discordGuildId ||
      !["recording", "paused", "finalizing", "completed"].includes(session.status) ||
      manifest.status !== session.status ||
      !Array.isArray(manifest.chunks) || manifest.chunks.length === 0 ||
      await markerExists(join(directory, ".transcription-enqueued"))) return false;
    if (chunkId !== undefined && !manifest.chunks.some((chunk) => chunk.id === chunkId && isEligible(manifest, chunk))) return false;
    for (const chunk of manifest.chunks) {
      if (typeof chunk.file !== "string" || typeof chunk.id !== "string" ||
        !/^[a-zA-Z0-9_-]+$/u.test(chunk.id) || !chunk.file.toLowerCase().endsWith(".wav")) return false;
      const path = resolve(directory, chunk.file);
      const within = relative(directory, path);
      if (!within || within === ".." || within.startsWith(`..\\`) || within.startsWith("../") || isAbsolute(within)) return false;
      const stat = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat === null || !stat.isFile() || stat.size === 0) return false;
    }
    return true;
  }

  private async buildContext(manifest: RecordingManifest): Promise<{
    initialPrompt: string;
    hotwords: string;
  }> {
    const campaign = await this.campaigns.findById(manifest.campaignId);
    const members = await this.campaigns.listMembersByCampaignId(manifest.campaignId);
    const names = members
      .flatMap((member) => [member.playerName, member.characterName])
      .filter((name): name is string => name !== null && name.trim() !== "");
    const vocabulary = campaign?.transcriptionVocabulary.trim() ?? "";
    const learnedVocabulary = await this.adaptiveVocabulary.listActive(manifest.campaignId);
    const knownCorrections = await loadTranscriptCorrections(
      join(dirname(this.recordingsRoot), "campaigns", manifest.campaignId),
    );
    const baseVocabulary = baseTranscriptionVocabulary()
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
    const customVocabulary = vocabulary
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
    const allVocabulary = [...new Set([
      ...customVocabulary,
      ...learnedVocabulary,
      ...knownCorrections.map((correction) => correction.to),
      ...baseVocabulary,
    ])];
    const priorityVocabulary = [...new Set([
      ...customVocabulary,
      ...learnedVocabulary,
      ...knownCorrections.map((correction) => correction.to),
    ])];
    const parts = [
      "Transcribe únicamente las palabras claramente audibles. No completes frases, no deduzcas intenciones y no agregues introducciones, despedidas ni expresiones habituales que no estén presentes en el audio. Si el fragmento contiene solamente silencio, ruido, respiración o palabras ininteligibles, devuelve una transcripción vacía. Conserva las frases incompletas y los errores naturales del hablante. El contenido corresponde a sesiones de rol y al bot Dotty.",
      "Usa el vocabulario proporcionado como contexto, pero no fuerces esas palabras cuando no sean audibles.",
      `La campaña se llama ${campaign?.name ?? manifest.campaignName ?? "sin nombre"}.`,
    ];
    if (names.length > 0) parts.push(`Los participantes y personajes incluyen: ${names.join(", ")}.`);
    if (allVocabulary.length > 0) parts.push(`Vocabulario útil: ${allVocabulary.join(", ")}.`);
    const hotwords = [
      campaign?.name ?? manifest.campaignName,
      ...names,
      ...priorityVocabulary,
      ...priorityTranscriptionHotwords(),
    ]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(", ")
      .slice(0, 1_000);
    return { initialPrompt: parts.join(" ").slice(0, 4_000), hotwords };
  }

  private async report(
    input: Parameters<DottyDiagnostics["recordActivity"]>[0],
  ): Promise<void> {
    await this.diagnostics?.recordActivity(input).catch((error) => {
      this.logger.debug({ error }, "No se pudo guardar el diagnóstico interno de despacho");
    });
  }
}

async function writeSyncedMarker(path: string, content = `${new Date().toISOString()}\n`): Promise<void> {
  const handle = await fs.open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function markerExists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function jobMarkerExists(path: string): Promise<boolean> {
  try {
    const entry = await fs.lstat(path);
    if (!entry.isFile()) throw new Error(`Job marker is not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY);
  try {
    try { await handle.sync(); }
    catch (error) {
      // Windows may reject directory fsync; the marker file itself was synced.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally {
    await handle.close();
  }
}

export function resolveTranscriberSecret(dataDirectory: string, configured: string): string {
  const trimmed = configured.trim();
  if (trimmed !== "" && trimmed !== "replace-with-a-long-random-local-secret") {
    return trimmed;
  }
  mkdirSync(dataDirectory, { recursive: true });
  const path = join(dataDirectory, "transcriber.secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const value = randomBytes(48).toString("base64url");
  writeFileSync(path, value, { encoding: "utf8", flag: "wx" });
  return value;
}
