import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { SessionService } from "../sessions/session-service.ts";
import type { SessionFileCoordinator } from "../sessions/session-file-coordinator.ts";
import type { ReprocessIntentStore } from "../sessions/reprocess-intent-store.ts";
import type { DottyDiagnostics } from "../diagnostics/dotty-diagnostics.ts";
import type { RecordingManifest } from "../recording/voice-capture-manager.ts";
import {
  applyTranscriptCorrections,
  loadTranscriptCorrections,
} from "./transcript-corrections.ts";
import {
  averageWordConfidence,
  classifyTranscriptSegment,
  isLikelyHallucination,
  normalizeTranscriptText,
  qualitySummary,
  type RecognizedWord,
} from "./transcript-quality.ts";
import {
  generateSmartChronicle,
  type SmartChronicle,
} from "./smart-chronicle.ts";
import type { AdaptiveVocabularyStore } from "./adaptive-vocabulary.ts";
import { baseTranscriptionVocabulary } from "./base-vocabulary.ts";
import { writeFileAtomically } from "../recording/atomic-json-file.ts";
import { createReadyMarker, jobsDigest, parseReadyMarker, serializeReadyMarker, transcriptDigest, verifyReadyMarker } from "../../../../packages/shared/src/transcription-ready.ts";

interface TranscriptionJob {
  readonly id: string;
  readonly status: string;
  readonly completed_at: string | null;
  readonly speaker_user_id: string;
  readonly start_offset_ms: number;
  readonly error?: string | null;
  readonly result: null | {
    readonly language: string;
    readonly segments: readonly {
      readonly start_ms: number;
      readonly end_ms: number;
      readonly text: string;
      readonly avg_logprob?: number;
      readonly no_speech_prob?: number;
      readonly compression_ratio?: number;
      readonly status?: "transcribed" | "suspected_hallucination" | "unintelligible";
      readonly validation_reasons?: readonly string[];
      readonly words: readonly (RecognizedWord & {
        readonly start_ms?: number;
        readonly end_ms?: number;
      })[];
    }[];
  };
}

interface TimedRecognizedWord extends RecognizedWord {
  readonly start_ms?: number;
  readonly end_ms?: number;
}

export interface TranscriptLine {
  readonly utteranceId: string;
  readonly sourceClipIndex?: number;
  readonly sourceOverlapMs?: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerUserId: string;
  readonly speakerName: string;
  readonly rawText: string;
  readonly text: string;
  readonly words: readonly TimedRecognizedWord[];
  readonly confidence: number | null;
  readonly metadata?: {
    readonly durationMs: number;
    readonly voiceRatio: number;
    readonly noSpeechProbability: number | null;
    readonly avgLogProbability: number | null;
    readonly compressionRatio: number | null;
    readonly reason: string | null;
  };
}

export class TranscriptionPublisher {
  private timer: NodeJS.Timeout | null = null;
  private publishing = false;

  constructor(
    private readonly campaigns: CampaignService,
    private readonly recordingsRoot: string,
    private readonly exportsRoot: string,
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly adaptiveVocabulary: AdaptiveVocabularyStore,
    private readonly logger: Logger,
    private readonly sessions: Pick<SessionService, "findById">,
    private readonly coordinator: SessionFileCoordinator,
    private readonly intents: Pick<ReprocessIntentStore, "read">,
    private readonly diagnosticsReporter?: Pick<DottyDiagnostics, "recordActivity">,
  ) {}

  start(): void {
    void this.publishReady();
    this.timer = setInterval(() => void this.publishReady(), 5_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async publishReady(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      const directories = await fs.readdir(this.recordingsRoot, { withFileTypes: true });
      const sessions = await Promise.all(directories.filter((entry) => entry.isDirectory()).map(async (entry) => ({
        entry,
        updatedAt: (await fs.stat(join(this.recordingsRoot, entry.name, "manifest.json")).catch(() => null))?.mtimeMs ?? 0,
      })));
      sessions.sort((left, right) => right.updatedAt - left.updatedAt);
      for (const { entry } of sessions) {
        try {
          await this.publishDirectory(join(this.recordingsRoot, entry.name));
        } catch (error) {
          this.logger.warn(
            { error, directory: entry.name },
            "No se pudo publicar una sesión; las demás continuarán",
          );
          // The directory may have been deleted while the lock was pending.
          // Do not recreate diagnostic files for a session we cannot validate.
        }
      }
    } catch (error) {
      this.logger.debug({ error }, "No hay transcripciones listas para publicar");
    } finally {
      this.publishing = false;
    }
  }

  private async publishDirectory(directory: string): Promise<void> {
    const sessionId = basename(directory);
    const publishedMarker = join(directory, ".transcription-published");
    const readyMarker = join(directory, ".transcription-ready");
    const failedMarker = join(directory, ".transcription-failed");
    if (
      await exists(publishedMarker) ||
      !(await exists(join(directory, ".transcription-enqueued")))
    ) return;
    const manifestText = await fs.readFile(join(directory, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText) as RecordingManifest;
    if (manifest.sessionId !== sessionId || !Array.isArray(manifest.chunks)) return;
    const fetchTimeoutMs = Math.max(4_000, Math.min(30_000, manifest.chunks.length * 4));
    const readyText = await fs.readFile(readyMarker, "utf8").catch(() => null);
    const ready = readyText === null ? null : parseReadyMarker(readyText);
    if (ready?.kind === "verifiable" && ready.marker.session_id === sessionId &&
        !(await exists(join(directory, ".transcription-regenerating"))) &&
        await exists(join(this.exportsRoot, sessionId, "bitacora.md"))) {
      try {
        const response = await fetch(
          new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/progress`, this.baseUrl),
          { headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(4_000) },
        );
        if (response.ok) {
          const progress = await response.json() as Record<string, unknown>;
          const latest = typeof progress.latest_updated_at === "string" ? Date.parse(progress.latest_updated_at) : NaN;
          if (progress.session_id === sessionId && progress.total === manifest.chunks.length &&
              progress.completed === progress.total && progress.queued === 0 &&
              progress.processing === 0 && progress.failed === 0 &&
              Number.isFinite(latest) && latest <= Date.parse(ready.marker.published_at)) return;
        }
      } catch { /* An older or unavailable service needs the full verification path. */ }
    }
    const publishStarted = performance.now();
    let payload: { jobs: TranscriptionJob[] };
    try {
      const response = await fetch(
        new URL(`/v1/sessions/${encodeURIComponent(manifest.sessionId)}`, this.baseUrl),
        {
          headers: { authorization: `Bearer ${this.secret}` },
          signal: AbortSignal.timeout(fetchTimeoutMs),
        },
      );
      if (!response.ok) throw new Error(`Could not read transcript: HTTP ${response.status}`);
      payload = (await response.json()) as { jobs: TranscriptionJob[] };
    } catch (error) {
      this.logger.warn({ sessionId, error }, "Could not fetch transcription status; will retry");
      return;
    }

    await this.coordinator.runExclusive(sessionId, async () => {
      if (!(await this.validate(directory, manifestText, payload))) return;
      await this.report({
        sessionId,
        component: "transcription",
        process: "consolidation",
        outcome: "started",
        message: "Dotty comenzó a comprobar y consolidar los trabajos de transcripción.",
        evidence: ["session_enqueued_marker_found", "manifest_loaded"],
        metrics: { chunks: manifest.chunks.length },
      });
      const failedJobs = payload.jobs.filter((job) => job.status === "failed");
      if (failedJobs.length > 0) {
        if (await markerExists(failedMarker)) return;
        this.logger.error(
          { sessionId: manifest.sessionId, failedJobs: failedJobs.map((j) => ({ id: j.id, error: j.error })) },
          "Transcription jobs failed; abandoning session",
        );
        for (const clip of manifest.clips ?? []) {
          const ids = new Set(manifest.chunks.filter((chunk) => chunk.clipIndex === clip.clipIndex).map((chunk) => `${manifest.sessionId}:${chunk.id}`));
          if (failedJobs.some((job) => ids.has(job.id))) clip.transcriptionStatus = "failed";
        }
        await writeAtomically(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await writeAtomically(
          failedMarker,
          `${new Date().toISOString()} - Transcription failed: ${failedJobs.map((j) => j.error).join("; ")}\n`,
        );
        await this.report({
          sessionId: manifest.sessionId,
          component: "transcription",
          process: "consolidation_gate",
          outcome: "failure",
          issue: "TRANSCRIPTION_JOB_FAILED",
          message: "La consolidación se detuvo porque uno o más trabajos terminaron en failed.",
          durationMs: performance.now() - publishStarted,
          evidence: ["failed_jobs_detected", "session_marked_failed"],
          metrics: { failed_jobs: failedJobs.length, total_jobs: payload.jobs.length },
        });
        return;
      }
      if (payload.jobs.some((job) => job.status !== "completed" || job.result === null)) return;
      const publishedJobsDigest = jobsDigest(sessionId, payload.jobs);
      const existingReady = await fs.readFile(readyMarker, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const regenerating = await markerExists(join(directory, ".transcription-regenerating"));
      if (existingReady !== null) {
        const parsed = parseReadyMarker(existingReady);
        if (parsed.kind !== "verifiable" && !regenerating) return;
        if (parsed.kind === "verifiable" && parsed.marker.session_id !== sessionId) return;
        const existingTranscript = await fs.readFile(join(this.exportsRoot, sessionId, "bitacora.md")).catch(() => null);
        if (parsed.kind === "verifiable" && existingTranscript !== null &&
          verifyReadyMarker(existingReady, sessionId, payload.jobs, existingTranscript) === "verified" && !regenerating) return;
        if (parsed.kind === "verifiable" && existingTranscript !== null &&
          transcriptDigest(existingTranscript) !== parsed.marker.transcript_digest && !regenerating) return;
        // A changed bitácora with unchanged jobs may contain a manual revision.
        if (parsed.kind === "verifiable" && parsed.marker.jobs_digest === publishedJobsDigest && !regenerating) return;
        await preservePriorPublication(this.exportsRoot, sessionId, existingReady);
      }

    const corrections = [
      ...(await loadTranscriptCorrections(join(dirname(this.recordingsRoot), "campaigns", manifest.campaignId))),
      ...(await loadTranscriptCorrections(directory)),
    ];
    const names = new Map(manifest.chunks.map((chunk) => [chunk.speakerUserId, chunk.speakerName]));
    const configuredCampaign = await this.campaigns.findById(manifest.campaignId);
    const configuredMembers = await this.campaigns.listMembersByCampaignId(
      manifest.campaignId,
    );
    for (const member of configuredMembers) {
      names.set(
        member.discordUserId,
        member.characterName?.trim() || member.playerName,
      );
    }
    const diagnostics: Array<{
      readonly speakerUserId: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly text: string;
      readonly reason: string;
      readonly confidence: number | null;
      readonly voiceRatio: number;
    }> = [];
    const compiledLines = payload.jobs
      .flatMap((job) =>
        (job.result?.segments ?? []).flatMap((segment, segmentIndex) => {
          const sourceChunk = manifest.chunks.find((chunk) => job.id === `${manifest.sessionId}:${chunk.id}`);
          const provenance = sourceChunk === undefined ? {} : {
            sourceClipIndex: sourceChunk.clipIndex ?? 1,
            sourceOverlapMs: sourceChunk.overlapMs ?? 0,
          };
          const clippingDuration = Math.max(0, segment.end_ms - segment.start_ms);
          const assessment = classifyTranscriptSegment({
            text: segment.text,
            avgLogProbability: segment.avg_logprob,
            noSpeechProbability: segment.no_speech_prob,
            compressionRatio: segment.compression_ratio,
            durationMs: clippingDuration,
            voiceRatio: undefined,
            words: segment.words,
          });
          if (segment.status === "suspected_hallucination" || assessment.shouldDiscard) {
            const reason = segment.status === "suspected_hallucination"
              ? `posible alucinacion: ${(segment.validation_reasons ?? []).join(", ")}`
              : assessment.reason ?? "segmento dudoso";
            diagnostics.push({
              speakerUserId: job.speaker_user_id,
              startMs: job.start_offset_ms + segment.start_ms,
              endMs: job.start_offset_ms + segment.end_ms,
              text: segment.text,
              reason,
              confidence: assessment.confidence,
              voiceRatio: assessment.voiceRatio,
            });
            this.logger.debug(
              {
                sessionId: manifest.sessionId,
                speakerUserId: job.speaker_user_id,
                startMs: job.start_offset_ms + segment.start_ms,
                endMs: job.start_offset_ms + segment.end_ms,
                reason,
                voiceRatio: assessment.voiceRatio,
              },
              "[Validation] Segmento preservado para revision y omitido de la vista normal",
            );
            return [{
              utteranceId: `${job.id}:${segmentIndex}:unintelligible`,
              ...provenance,
              startMs: job.start_offset_ms + segment.start_ms,
              endMs: job.start_offset_ms + segment.end_ms,
              speakerUserId: job.speaker_user_id,
              speakerName: names.get(job.speaker_user_id) ?? job.speaker_user_id,
              rawText: segment.text,
              text: "[ininteligible]",
              words: [],
              confidence: assessment.confidence,
              metadata: {
                durationMs: clippingDuration,
                voiceRatio: assessment.voiceRatio,
                noSpeechProbability: segment.no_speech_prob ?? null,
                avgLogProbability: segment.avg_logprob ?? null,
                compressionRatio: segment.compression_ratio ?? null,
                reason,
              },
            }];
          }
          return splitTranscriptionSegment(segment).map((sentence) => ({
            utteranceId: `${job.id}:${segmentIndex}`,
            ...provenance,
            startMs: job.start_offset_ms + sentence.start_ms,
            endMs: job.start_offset_ms + sentence.end_ms,
            speakerUserId: job.speaker_user_id,
            speakerName: names.get(job.speaker_user_id) ?? job.speaker_user_id,
            rawText: sentence.text,
            text: applyTranscriptCorrections(
              normalizeTranscriptText(sentence.text),
              corrections,
            ),
            words: sentence.words.map((word) => ({
              ...word,
              ...(word.start_ms === undefined ? {} : { start_ms: job.start_offset_ms + word.start_ms }),
              ...(word.end_ms === undefined ? {} : { end_ms: job.start_offset_ms + word.end_ms }),
            })),
            confidence: averageWordConfidence(sentence.words),
            metadata: {
              durationMs: Math.max(0, sentence.end_ms - sentence.start_ms),
              voiceRatio: assessment.voiceRatio,
              noSpeechProbability: segment.no_speech_prob ?? null,
              avgLogProbability: segment.avg_logprob ?? null,
              compressionRatio: segment.compression_ratio ?? null,
              reason: assessment.reason ?? null,
            },
          }));
        }),
      )
      .sort((left, right) => left.startMs - right.startMs);
    const lines = deduplicateOverlapLines(
      interleaveOverlappingLines(compiledLines, (text) =>
        applyTranscriptCorrections(normalizeTranscriptText(text), corrections),
      ),
    );
    const quality = qualitySummary(lines);
    if (diagnostics.length > 0) {
      const hallucinationCount = diagnostics.filter((item) => item.reason.startsWith("posible alucinacion")).length;
      await this.report({
        sessionId: manifest.sessionId,
        component: "transcription",
        process: "validation",
        outcome: "warning",
        issue: hallucinationCount > 0 ? "SUSPECTED_HALLUCINATION" : "LOW_CONFIDENCE_OUTPUT",
        message: "La consolidación encontró segmentos que deben quedar visibles como ininteligibles o revisarse.",
        evidence: ["publisher_quality_filter_applied", "doubtful_segments_preserved_in_diagnostics"],
        metrics: {
          diagnostics: diagnostics.length,
          suspected_hallucinations: hallucinationCount,
          lines_to_review: quality.linesToReview,
        },
      });
    }
    const chronicleTerms = [
      configuredCampaign?.name,
      ...(configuredCampaign?.transcriptionVocabulary.split(",") ?? []),
      ...configuredMembers.flatMap((member) => [member.playerName, member.characterName]),
    ].filter((term): term is string => typeof term === "string" && term.trim() !== "");
    const chronicle = generateSmartChronicle(lines, chronicleTerms);

    const exportDirectory = join(this.exportsRoot, manifest.sessionId);
    await fs.mkdir(exportDirectory, { recursive: true });
    const jsonPath = join(exportDirectory, "transcript.raw.json");
    const markdownPath = join(exportDirectory, "bitacora.md");
    const chroniclePath = join(exportDirectory, "bitacora-inteligente.json");
    const narrativeContextPath = join(exportDirectory, "contexto-narrativo.json");
    const title = manifest.campaignName ?? "Campaña";
    await writeAtomically(jsonPath, `${JSON.stringify({ manifest, quality, lines, diagnostics }, null, 2)}\n`);
    await writeAtomically(chroniclePath, `${JSON.stringify(chronicle, null, 2)}\n`);
    await writeAtomically(
      narrativeContextPath,
      `${JSON.stringify({
        campaignName: configuredCampaign?.name ?? title,
        vocabulary: configuredCampaign?.transcriptionVocabulary
          .split(",")
          .map((term) => term.trim())
          .filter(Boolean) ?? [],
        members: configuredMembers.map((member) => ({
          playerName: member.playerName,
          characterName: member.characterName,
        })),
      }, null, 2)}\n`,
    );
    await writeAtomically(markdownPath, renderMarkdown(title, manifest, lines, quality, chronicle));

    const transcriptsDirectory = join(directory, "transcripts");
    await fs.mkdir(transcriptsDirectory, { recursive: true });
    for (const clip of manifest.clips ?? []) {
      const chunkIds = new Set(
        manifest.chunks.filter((chunk) => chunk.clipIndex === clip.clipIndex).map((chunk) => chunk.id),
      );
      const jobs = payload.jobs.filter((job) => chunkIds.has(job.id.split(":").at(-1) ?? ""));
      await writeAtomically(
        join(transcriptsDirectory, `clip_${String(clip.clipIndex).padStart(3, "0")}.json`),
        `${JSON.stringify({ clip, jobs }, null, 2)}\n`,
      );
      clip.transcriptionStatus = "completed";
    }
    await writeAtomically(
      join(directory, "transcript_full.json"),
      `${JSON.stringify({ sessionId: manifest.sessionId, lines }, null, 2)}\n`,
    );
    await writeAtomically(
      join(directory, "transcript_full.txt"),
      `${lines.map((line) => `[${formatTime(line.startMs)}] ${line.speakerName}: ${line.text}`).join("\n")}\n`,
    );
    await writeAtomically(join(directory, "bitacora.json"), `${JSON.stringify(chronicle, null, 2)}\n`);

    await writeAtomically(
      join(directory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    if (await exists(join(directory, ".transcription-regenerating"))) {
      await fs.rm(join(exportDirectory, "guion.revision.json"), { force: true });
      await writeAtomically(join(exportDirectory, "guion.estado.json"), `${JSON.stringify({
        state: "missing",
        sessionId: manifest.sessionId,
        model: "",
        progress: 0,
        phase: "Transcripción rehecha; regenera el guion antes de publicar",
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`);
    }
    const activatedTerms = await this.adaptiveVocabulary.observe(
      manifest.campaignId, manifest.sessionId, lines,
      [...chronicleTerms, ...baseTranscriptionVocabulary().split(",")],
    );
    if (activatedTerms.length > 0) {
      this.logger.info({ campaignId: manifest.campaignId, terms: activatedTerms }, "Vocabulario adaptativo actualizado");
    }
    // The artifacts above and the marker below must describe the same job snapshot.
    // Python may accept a direct retry while the bot holds its own session lock.
    const latestResponse = await fetch(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, this.baseUrl), {
      headers: { authorization: `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!latestResponse.ok) throw new Error(`Could not recheck transcription jobs: HTTP ${latestResponse.status}`);
    const latestPayload = (await latestResponse.json()) as { jobs?: TranscriptionJob[] };
    if (!Array.isArray(latestPayload.jobs) || jobsDigest(sessionId, latestPayload.jobs) !== publishedJobsDigest) {
      throw new Error("Transcription jobs changed during publication");
    }
    const finalTranscriptBytes = await fs.readFile(markdownPath);
    const marker = createReadyMarker(sessionId, payload.jobs, finalTranscriptBytes, new Date().toISOString());
    await writeReadyMarker(readyMarker, serializeReadyMarker(marker), existingReady);
    await fs.rm(join(directory, ".transcription-regenerating"), { force: true });
    this.logger.info(
      { sessionId: manifest.sessionId },
      "Transcripcion preparada; queda pendiente generar y publicar el guion manualmente",
    );
    await this.report({
      sessionId: manifest.sessionId,
      component: "transcription",
      process: "consolidation",
      outcome: diagnostics.length > 0 || quality.linesToReview > 0 ? "warning" : "success",
      message: diagnostics.length > 0 || quality.linesToReview > 0
        ? "Transcripción consolidada y exportada correctamente, con elementos marcados para revisión."
        : "Transcripción consolidada y exportada correctamente sin alertas de calidad en esta etapa.",
      durationMs: performance.now() - publishStarted,
      evidence: [
        "all_jobs_completed",
        "transcript_raw_written",
        "bitacora_written",
        "full_transcript_written",
        "ready_marker_written",
      ],
      metrics: {
        jobs: payload.jobs.length,
        lines: lines.length,
        diagnostics: diagnostics.length,
        lines_to_review: quality.linesToReview,
        average_word_confidence: quality.averageWordConfidence,
        activated_vocabulary_terms: activatedTerms.length,
      },
    });
    });
  }

  private async validate(directory: string, expectedManifest: string, payload: { jobs: TranscriptionJob[] }): Promise<boolean> {
    const sessionId = basename(directory);
    const session = await this.sessions.findById(sessionId);
    if (session === null || session.id !== sessionId || session.status !== "completed") return false;
    // Provisional policy shared with dispatcher: only absent/completed intents are eligible.
    const intent = await this.intents.read(sessionId);
    if (intent !== null && intent.phase !== "completed") return false;
    const currentText = await fs.readFile(join(directory, "manifest.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (currentText === null || currentText !== expectedManifest) return false;
    const manifest = JSON.parse(currentText) as RecordingManifest;
    const campaign = await this.campaigns.findByGuildAndName(session.discordGuildId, session.campaignName);
    if (campaign === null || manifest.sessionId !== sessionId || manifest.campaignId !== campaign.id ||
      (manifest.campaignName !== undefined && manifest.campaignName !== session.campaignName) ||
      manifest.discordGuildId !== session.discordGuildId ||
      manifest.status !== "completed" || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0 ||
      !Array.isArray(manifest.clips) ||
      !Array.isArray(payload.jobs) || payload.jobs.length !== manifest.chunks.length) return false;
    if (!(await markerExists(join(directory, ".transcription-enqueued"))) ||
      await markerExists(join(directory, ".transcription-published"))) return false;
    const jobDirectory = join(directory, ".transcription-jobs");
    const entries = await fs.readdir(jobDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.some((entry) => entry.endsWith(".posting"))) return false;
    const ids = new Set<string>();
    for (const chunk of manifest.chunks) {
      const clip = manifest.clips.find((item) => item.clipIndex === chunk.clipIndex);
      if (clip === undefined || clip.transcriptionStatus === "recording") return false;
      const id = `${sessionId}:${chunk.id}`;
      if (ids.has(id) || !/^[a-zA-Z0-9_-]+$/u.test(chunk.id)) return false;
      ids.add(id);
      const job = payload.jobs.find((candidate) => candidate.id === id);
      if (job === undefined || job.speaker_user_id !== chunk.speakerUserId ||
        job.start_offset_ms !== chunk.startedOffsetMs ||
        !(await regularMarkerExists(join(jobDirectory, chunk.id)))) return false;
    }
    return payload.jobs.every((job) => ids.has(job.id));
  }

  private async report(
    input: Parameters<DottyDiagnostics["recordActivity"]>[0],
  ): Promise<void> {
    await this.diagnosticsReporter?.recordActivity(input).catch((error) => {
      this.logger.debug({ error }, "No se pudo guardar el diagnóstico interno de consolidación");
    });
  }
}

export function deduplicateOverlapLines(lines: readonly TranscriptLine[]): TranscriptLine[] {
  const result: TranscriptLine[] = [];
  for (const line of [...lines].sort((left, right) => left.startMs - right.startMs)) {
    const normalized = normalizeForDeduplication(line.text);
    const duplicate = result.slice(-12).some((previous) => {
      if (previous.speakerUserId !== line.speakerUserId) return false;
      if (!(line.sourceOverlapMs && previous.sourceClipIndex !== undefined
        && line.sourceClipIndex !== undefined && previous.sourceClipIndex !== line.sourceClipIndex)) return false;
      const overlapsInTime = line.startMs <= previous.endMs + 250 && previous.startMs <= line.endMs + 250;
      return overlapsInTime && normalized !== "" && normalized === normalizeForDeduplication(previous.text);
    });
    if (!duplicate) result.push(line);
  }
  return result;
}

export function interleaveOverlappingLines(
  lines: readonly TranscriptLine[],
  formatText: (text: string) => string = normalizeTranscriptText,
): TranscriptLine[] {
  const ordered = [...lines].sort((left, right) => left.startMs - right.startMs);
  const result: TranscriptLine[] = [];
  for (const line of ordered) {
    const timedWords = line.words.filter(
      (word): word is TimedRecognizedWord & { start_ms: number; end_ms: number } =>
        word.start_ms !== undefined && word.end_ms !== undefined,
    );
    if (timedWords.length !== line.words.length || timedWords.length < 2) {
      result.push(line);
      continue;
    }

    const boundaries = ordered
      .filter((other) =>
        other.speakerUserId !== line.speakerUserId &&
        other.text !== "[ininteligible]" &&
        other.startMs > line.startMs + 100 &&
        other.startMs < line.endMs - 100,
      )
      .map((other) => other.startMs)
      .sort((left, right) => left - right);
    if (boundaries.length === 0) {
      result.push(line);
      continue;
    }

    const groups: TimedRecognizedWord[][] = [];
    let groupStart = 0;
    for (const boundary of boundaries) {
      const splitAt = timedWords.findIndex(
        (word, index) => index > groupStart && (word.start_ms ?? 0) >= boundary,
      );
      if (splitAt <= groupStart || splitAt >= timedWords.length) continue;
      groups.push(timedWords.slice(groupStart, splitAt));
      groupStart = splitAt;
    }
    groups.push(timedWords.slice(groupStart));
    if (groups.length === 1) {
      result.push(line);
      continue;
    }

    for (const [partIndex, words] of groups.entries()) {
      const rawText = joinRecognizedWords(words);
      const startMs = words[0]?.start_ms ?? line.startMs;
      const endMs = words.at(-1)?.end_ms ?? line.endMs;
      result.push({
        ...line,
        utteranceId: `${line.utteranceId}:part-${partIndex + 1}`,
        startMs,
        endMs,
        rawText,
        text: formatText(rawText),
        words,
        confidence: averageWordConfidence(words),
        ...(line.metadata === undefined ? {} : {
          metadata: { ...line.metadata, durationMs: Math.max(0, endMs - startMs) },
        }),
      });
    }
  }
  return result.sort((left, right) => left.startMs - right.startMs);
}

function normalizeForDeduplication(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();
}

function renderMarkdown(
  title: string,
  manifest: RecordingManifest,
  lines: readonly TranscriptLine[],
  quality: ReturnType<typeof qualitySummary>,
  chronicle: SmartChronicle,
): string {
  return [
    `# ${title} — Sesión ${manifest.sequenceNumber}`,
    "",
    `- Inicio: ${manifest.startedAt}`,
    `- Fin: ${manifest.endedAt ?? ""}`,
    `- Fuente: sesión ${manifest.sessionId}`,
    `- Confianza media estimada: ${quality.averageWordConfidence === null ? "sin datos" : `${Math.round(quality.averageWordConfidence * 100)} %`}`,
    `- Palabras de baja confianza: ${quality.lowConfidenceWords} de ${quality.wordCount}`,
    `- Intervenciones para revisar: ${quality.linesToReview}`,
    "",
    renderChronicleMarkdown(chronicle),
    "",
    "## Transcripción",
    "",
    ...lines.map((line) => `[${formatTime(line.startMs)}] **${line.speakerName}:** ${line.text}`),
    "",
  ].join("\n");
}

function renderChronicleMarkdown(chronicle: SmartChronicle): string {
  return [
    "## Bitácora inteligente",
    "",
    "_Resumen extractivo: cada punto procede de la transcripción y conserva su marca temporal._",
    "",
    "### Resumen",
    ...renderPoints(chronicle.summary),
    "",
    "### Participantes",
    ...(chronicle.participants.length === 0
      ? ["- No se reconocieron voces."]
      : [
          `- Participantes: ${chronicle.participants.map((participant) => participant.name).join(", ")}`,
          `- Intervenciones transcritas: ${chronicle.participants.reduce((total, participant) => total + participant.interventions, 0)}`,
        ]),
    "",
    "### Términos reconocidos",
    chronicle.mentionedTerms.length === 0 ? "- Ninguno configurado." : `- ${chronicle.mentionedTerms.join(", ")}`,
    "",
    "### Momentos clave",
    ...renderPoints(chronicle.keyMoments),
    "",
    "### Decisiones y acuerdos",
    ...renderPoints(chronicle.decisions),
    "",
    "### Pendiente para la próxima sesión",
    ...renderPoints(chronicle.pendingTasks),
  ].join("\n");
}

function renderPoints(points: SmartChronicle["summary"]): string[] {
  return points.length === 0
    ? ["- No se detectaron elementos con suficiente respaldo."]
    : points.map((point) => `- [${formatTime(point.startMs)}] **${point.speakerName}:** ${point.text}`);
}

export function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function splitMessage(value: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("El límite debe ser positivo.");
  const chunks: string[] = [];
  let current = "";
  for (const line of value.split("\n")) {
    if (line.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }
    if (current.length > 0 && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current += `${current.length > 0 ? "\n" : ""}${line}`;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function splitTranscriptionSegment(segment: {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly words: readonly TimedRecognizedWord[];
}): Array<{
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly words: readonly TimedRecognizedWord[];
}> {
  const words = segment.words.filter((word) => word.text.trim().length > 0);
  if (words.length === 0) {
    return [{
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      text: segment.text,
      words: [],
    }];
  }

  const groups: TimedRecognizedWord[][] = [];
  let current: TimedRecognizedWord[] = [];
  for (const word of words) {
    current.push(word);
    if (/[.!?][\])}"'»]*$/u.test(word.text.trim())) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => ({
    start_ms: group[0]?.start_ms ?? (index === 0 ? segment.start_ms : segment.end_ms),
    end_ms: group.at(-1)?.end_ms ?? segment.end_ms,
    text: joinRecognizedWords(group),
    words: group,
  }));
}

function joinRecognizedWords(words: readonly TimedRecognizedWord[]): string {
  const joined = words.map((word) => word.text).join("").trim();
  if (/\s/u.test(joined)) return joined;
  return words.map((word) => word.text.trim()).join(" ");
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function regularMarkerExists(path: string): Promise<boolean> {
  try { return (await fs.lstat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await writeFileAtomically(path, content);
}

async function writeReadyMarker(path: string, content: string, expectedPrevious: string | null): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    const current = await fs.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current !== expectedPrevious) throw new Error("Transcription ready marker changed during publication");
    // The shared session lock excludes cooperative Node and Python mutators.
    // Same-directory rename replaces the marker atomically where supported.
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function preservePriorPublication(exportsRoot: string, sessionId: string, marker: string): Promise<void> {
  const exported = join(exportsRoot, sessionId);
  const identity = createHash("sha256").update(marker).digest("hex");
  const history = join(exported, "publication-history", identity);
  await fs.mkdir(join(exported, "publication-history"), { recursive: true });
  try { await fs.mkdir(history); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await fs.readFile(join(history, ".complete"), "utf8").catch(() => null) !== `${identity}\n` ||
      await fs.readFile(join(history, ".transcription-ready"), "utf8").catch(() => null) !== marker) {
      throw new Error("Incomplete historical publication backup requires inspection");
    }
    // A panel edit made after an interrupted attempt is also retained before retry.
    for (const [name, extension] of [["bitacora.md", "md"], ["transcript.raw.json", "json"]] as const) {
      const current = await fs.readFile(join(exported, name)).catch((readError: NodeJS.ErrnoException) => {
        if (readError.code === "ENOENT") return null;
        throw readError;
      });
      if (current === null) continue;
      const digest = createHash("sha256").update(current).digest("hex");
      const snapshot = join(history, `${name}.${digest}.${extension}`);
      try { await fs.writeFile(snapshot, current, { flag: "wx" }); }
      catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await fs.readFile(snapshot)).equals(current)) throw writeError;
      }
    }
    return;
  }
  for (const [source, name] of [
    [null, ".transcription-ready"],
    [join(exported, "bitacora.md"), "bitacora.md"],
    [join(exported, "transcript.raw.json"), "transcript.raw.json"],
  ] as const) {
    const content = source === null ? Buffer.from(marker, "utf8") : await fs.readFile(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (content === null) continue;
    const destination = join(history, name);
    await fs.writeFile(destination, content, { flag: "wx" });
  }
  await fs.writeFile(join(history, ".complete"), `${identity}\n`, { flag: "wx" });
}
