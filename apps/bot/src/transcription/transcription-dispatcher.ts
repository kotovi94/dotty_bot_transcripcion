import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Logger } from "pino";
import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { DottyDiagnostics } from "../diagnostics/dotty-diagnostics.ts";
import {
  baseTranscriptionVocabulary,
  priorityTranscriptionHotwords,
} from "./base-vocabulary.ts";
import { loadTranscriptCorrections } from "./transcript-corrections.ts";
import type { AdaptiveVocabularyStore } from "./adaptive-vocabulary.ts";

interface RecordingManifest {
  readonly version: 1 | 2;
  readonly sessionId: string;
  readonly campaignId: string;
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
    const markerPath = join(directory, ".transcription-enqueued");
    if (existsSync(markerPath)) return;
    let manifest: RecordingManifest;
    try {
      manifest = JSON.parse(
        await fs.readFile(join(directory, "manifest.json"), "utf8"),
      ) as RecordingManifest;
    } catch {
      return;
    }
    if (manifest.chunks.length === 0) return;

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

    const eligible = manifest.chunks.filter((chunk) => {
      if (manifest.version === 1 || manifest.clips === undefined) return manifest.status === "completed";
      const clip = manifest.clips.find((item) => item.clipIndex === (chunk.clipIndex ?? 1));
      return clip !== undefined && clip.transcriptionStatus !== "recording";
    });
    const jobMarkers = join(directory, ".transcription-jobs");
    await fs.mkdir(jobMarkers, { recursive: true });
    let newlyQueued = 0;
    for (const chunk of eligible) {
      const jobMarker = join(jobMarkers, chunk.id);
      if (existsSync(jobMarker)) continue;
      const queuedAt = performance.now();
      const response = await fetch(new URL("/v1/jobs", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: `${manifest.sessionId}:${chunk.id}`,
          audio_path: resolve(directory, chunk.file),
          speaker_user_id: chunk.speakerUserId,
          start_offset_ms: chunk.startedOffsetMs,
          language: "es",
          initial_prompt: transcriptionContext.initialPrompt,
          hotwords: transcriptionContext.hotwords,
        }),
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) {
        await this.report({
          sessionId: manifest.sessionId,
          component: "transcription",
          process: "enqueue_job",
          outcome: "failure",
          issue: "JOB_ENQUEUE_REJECTED",
          message: "El transcriptor rechazó un fragmento de audio.",
          durationMs: performance.now() - queuedAt,
          evidence: [`http_status_${response.status}`],
          metrics: {
            speaker_user_id: chunk.speakerUserId,
            start_offset_ms: chunk.startedOffsetMs,
          },
        });
        throw new Error(`Transcriber rejected job with HTTP ${response.status}.`);
      }
      await fs.writeFile(jobMarker, `${new Date().toISOString()}\n`, { flag: "wx" });
      newlyQueued += 1;
      await this.report({
        sessionId: manifest.sessionId,
        component: "transcription",
        process: "enqueue_job",
        outcome: "success",
        message: "Fragmento de audio aceptado por el transcriptor.",
        durationMs: performance.now() - queuedAt,
        evidence: ["http_request_ok", "job_marker_written"],
        metrics: {
          speaker_user_id: chunk.speakerUserId,
          start_offset_ms: chunk.startedOffsetMs,
          clip_index: chunk.clipIndex ?? 1,
        },
      });
    }
    if (newlyQueued > 0) {
      this.logger.info(
        { sessionId: manifest.sessionId, chunks: newlyQueued },
        "[Transcription] closed clips queued",
      );
    }
    if (manifest.status === "completed" && eligible.length === manifest.chunks.length) {
      await fs.writeFile(markerPath, `${new Date().toISOString()}\n`, { flag: "wx" });
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
