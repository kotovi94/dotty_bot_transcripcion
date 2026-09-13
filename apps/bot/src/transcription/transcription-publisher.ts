import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
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

interface TranscriptionJob {
  readonly id: string;
  readonly status: string;
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
      for (const entry of directories) {
        if (!entry.isDirectory()) continue;
        try {
          await this.publishDirectory(join(this.recordingsRoot, entry.name));
        } catch (error) {
          this.logger.warn(
            { error, directory: entry.name },
            "No se pudo publicar una sesión; las demás continuarán",
          );
          await this.report({
            sessionId: entry.name,
            component: "transcription",
            process: "consolidation",
            outcome: "failure",
            issue: "TRANSCRIPTION_EXPORT_FAILED",
            message: "Falló la consolidación o escritura de los artefactos de transcripción.",
            evidence: ["publisher_exception_captured", "other_sessions_continue"],
            error,
          });
        }
      }
    } catch (error) {
      this.logger.debug({ error }, "No hay transcripciones listas para publicar");
    } finally {
      this.publishing = false;
    }
  }

  private async publishDirectory(directory: string): Promise<void> {
    const publishedMarker = join(directory, ".transcription-published");
    const readyMarker = join(directory, ".transcription-ready");
    if (
      await exists(publishedMarker) ||
      await exists(readyMarker) ||
      !(await exists(join(directory, ".transcription-enqueued")))
    ) return;
    const manifest = JSON.parse(
      await fs.readFile(join(directory, "manifest.json"), "utf8"),
    ) as RecordingManifest;
    const publishStarted = performance.now();
    await this.report({
      sessionId: manifest.sessionId,
      component: "transcription",
      process: "consolidation",
      outcome: "started",
      message: "Dotty comenzó a comprobar y consolidar los trabajos de transcripción.",
      evidence: ["session_enqueued_marker_found", "manifest_loaded"],
      metrics: { chunks: manifest.chunks.length },
    });
    let payload: { jobs: TranscriptionJob[] };
    try {
      const response = await fetch(
        new URL(`/v1/sessions/${encodeURIComponent(manifest.sessionId)}`, this.baseUrl),
        {
          headers: { authorization: `Bearer ${this.secret}` },
          signal: AbortSignal.timeout(4_000),
        },
      );
      if (!response.ok) throw new Error(`Could not read transcript: HTTP ${response.status}`);
      payload = (await response.json()) as { jobs: TranscriptionJob[] };
      const failedJobs = payload.jobs.filter((job) => job.status === "failed");
      if (failedJobs.length > 0) {
        this.logger.error(
          { sessionId: manifest.sessionId, failedJobs: failedJobs.map((j) => ({ id: j.id, error: j.error })) },
          "Transcription jobs failed; abandoning session",
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
        for (const clip of manifest.clips ?? []) {
          const ids = new Set(manifest.chunks.filter((chunk) => chunk.clipIndex === clip.clipIndex).map((chunk) => `${manifest.sessionId}:${chunk.id}`));
          if (failedJobs.some((job) => ids.has(job.id))) clip.transcriptionStatus = "failed";
        }
        await writeAtomically(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await writeAtomically(
          join(directory, ".transcription-failed"),
          `${new Date().toISOString()} - Transcription failed: ${failedJobs.map((j) => j.error).join("; ")}\n`,
        );
        return;
      }
      if (
        payload.jobs.length !== manifest.chunks.length ||
        payload.jobs.some((job) => job.status !== "completed" || job.result === null)
      ) return;
    } catch (error) {
      this.logger.warn(
        { sessionId: manifest.sessionId, error },
        "Could not fetch transcription status; will retry",
      );
      await this.report({
        sessionId: manifest.sessionId,
        component: "transcription",
        process: "status_fetch",
        outcome: "warning",
        issue: "TRANSCRIPTION_STATUS_FETCH_FAILED",
        message: "No se pudo consultar el estado de los trabajos; Dotty lo volverá a intentar.",
        durationMs: performance.now() - publishStarted,
        evidence: ["status_fetch_failed", "automatic_retry_expected"],
        error,
      });
      return;
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
    const activatedTerms = await this.adaptiveVocabulary.observe(
      manifest.campaignId,
      manifest.sessionId,
      lines,
      [
        ...chronicleTerms,
        ...baseTranscriptionVocabulary().split(","),
      ],
    );
    if (activatedTerms.length > 0) {
      this.logger.info(
        { campaignId: manifest.campaignId, terms: activatedTerms },
        "Vocabulario adaptativo actualizado",
      );
    }
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
    await fs.writeFile(readyMarker, `${new Date().toISOString()}\n`, { flag: "wx" });
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

async function writeAtomically(path: string, content: string): Promise<void> {
  await writeFileAtomically(path, content);
}
