import { constants, promises as fs } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import type { DottyDiagnostics } from "./dotty-diagnostics.ts";
import {
  dottyIssue,
  type DottyIssueName,
  type DottyIssueSeverity,
} from "./error-codes.ts";
import { writeJsonAtomically } from "../recording/atomic-json-file.ts";

interface TranscriptRaw {
  readonly quality?: {
    readonly averageWordConfidence?: number | null;
    readonly wordCount?: number;
    readonly lowConfidenceWords?: number;
    readonly linesToReview?: number;
  };
  readonly lines?: readonly unknown[];
  readonly diagnostics?: readonly unknown[];
}

interface VoiceMetrics {
  readonly duration_total_seconds?: number;
  readonly time_silence_seconds?: number;
  readonly time_non_speech_seconds?: number;
  readonly time_speech_seconds?: number;
  readonly segments_sent_to_whisper?: number;
  readonly segments_transcribed?: number;
  readonly unintelligible?: number;
  readonly suspected_hallucination?: number;
  readonly gpu_seconds?: number;
}

interface ActivityCodeSummary {
  readonly name?: string;
  readonly count?: number;
  readonly severity?: string;
  readonly last_seen?: string;
  readonly lastSeen?: string;
}

interface ActivitySummary {
  readonly event_count?: number;
  readonly eventCount?: number;
  readonly outcomes?: Readonly<Record<string, number>>;
  readonly codes?: Readonly<Record<string, ActivityCodeSummary>>;
}

interface ReportIssue {
  readonly code: string;
  readonly name: DottyIssueName;
  readonly severity: DottyIssueSeverity;
  readonly count: number;
  readonly recoverable: boolean;
  readonly description: string;
  readonly suggestedAction: string;
}

interface TranscriptionReport {
  readonly version: 1;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly outcome: "success" | "warning" | "failure";
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
  readonly checks: readonly {
    readonly process: string;
    readonly outcome: "success" | "warning" | "failure" | "unknown";
    readonly detail: string;
    readonly evidence: readonly string[];
  }[];
  readonly issues: readonly ReportIssue[];
  readonly whatWentWell: readonly string[];
  readonly warnings: readonly string[];
  readonly failures: readonly string[];
  readonly artifacts: readonly string[];
  readonly activity: {
    readonly botEvents: number;
    readonly transcriberEvents: number;
  };
}

export class TranscriptionReportService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly recordingsRoot: string,
    private readonly exportsRoot: string,
    private readonly dataRoot: string,
    private readonly diagnostics: Pick<DottyDiagnostics, "recordActivity">,
    private readonly logger: Logger,
  ) {}

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), 5_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const directories = await fs.readdir(this.recordingsRoot, { withFileTypes: true });
      for (const entry of directories) {
        if (!entry.isDirectory()) continue;
        const recordingDirectory = join(this.recordingsRoot, entry.name);
        try {
          await this.generateIfNeeded(recordingDirectory, entry.name);
        } catch (error) {
          this.logger.debug(
            { error, directory: entry.name },
            "No se pudo actualizar el reporte interno de transcripción",
          );
        }
      }
    } catch (error) {
      this.logger.debug({ error }, "No se pudieron inspeccionar reportes internos de transcripción");
    } finally {
      this.running = false;
    }
  }

  private async generateIfNeeded(recordingDirectory: string, fallbackSessionId: string): Promise<void> {
    const readyPath = join(recordingDirectory, ".transcription-ready");
    const failedPath = join(recordingDirectory, ".transcription-failed");
    const readyStat = await statOrNull(readyPath);
    const failedStat = await statOrNull(failedPath);
    const terminalStat = newestStat(readyStat, failedStat);
    if (terminalStat === null) return;

    const manifest = await readJson<{ sessionId?: unknown }>(join(recordingDirectory, "manifest.json"));
    const sessionId = typeof manifest?.sessionId === "string" && manifest.sessionId.trim() !== ""
      ? manifest.sessionId
      : fallbackSessionId;
    const diagnosticsDirectory = join(this.dataRoot, ".diagnostics", safePathSegment(sessionId));
    const reportPath = join(diagnosticsDirectory, "transcription-report.json");
    const existingStat = await statOrNull(reportPath);
    if (existingStat !== null && existingStat.mtimeMs >= terminalStat.mtimeMs) return;

    await fs.mkdir(diagnosticsDirectory, { recursive: true });
    const completed = readyStat !== null && (failedStat === null || readyStat.mtimeMs >= failedStat.mtimeMs);
    const report = await this.buildReport(sessionId, recordingDirectory, completed);
    await writeJsonAtomically(reportPath, report);
    const reportIssue = report.outcome === "warning"
      ? "FINAL_REPORT_WARNING"
      : report.outcome === "failure"
        ? "FINAL_REPORT_FAILURE"
        : undefined;
    await this.diagnostics.recordActivity({
      sessionId,
      component: "transcription",
      process: "final_report",
      outcome: report.outcome === "success" ? "success" : report.outcome === "warning" ? "warning" : "failure",
      ...(reportIssue === undefined ? {} : { issue: reportIssue }),
      message: report.outcome === "success"
        ? "Reporte final generado: la transcripción terminó sin alertas detectadas."
        : report.outcome === "warning"
          ? "Reporte final generado: la transcripción terminó con puntos para revisar."
          : "Reporte final generado: la transcripción terminó con fallos.",
      evidence: [
        "transcription_terminal_marker_detected",
        "activity_logs_aggregated",
        "quality_metrics_aggregated",
        "error_codes_aggregated",
        "transcription_report_written",
      ],
      metrics: {
        bot_events: report.activity.botEvents,
        transcriber_events: report.activity.transcriberEvents,
        issues: report.issues.length,
        warnings: report.warnings.length,
        failures: report.failures.length,
        artifacts: report.artifacts.length,
      },
    });
  }

  private async buildReport(
    sessionId: string,
    recordingDirectory: string,
    completed: boolean,
  ): Promise<TranscriptionReport> {
    const exportDirectory = join(this.exportsRoot, sessionId);
    const diagnosticsDirectory = join(this.dataRoot, ".diagnostics", safePathSegment(sessionId));
    const [transcript, voiceMetrics, botActivity, transcriberActivity] = await Promise.all([
      readJson<TranscriptRaw>(join(exportDirectory, "transcript.raw.json")),
      readJson<VoiceMetrics>(join(recordingDirectory, "voice_metrics.json")),
      readJson<ActivitySummary>(join(diagnosticsDirectory, "report.bot.json")),
      readJson<ActivitySummary>(join(diagnosticsDirectory, "report.transcriber.json")),
    ]);

    const quality = transcript?.quality ?? {};
    const suspiciousSegments = Math.max(
      numberOrZero(voiceMetrics?.suspected_hallucination),
      transcript?.diagnostics?.length ?? 0,
    );
    const unintelligible = numberOrZero(voiceMetrics?.unintelligible);
    const linesToReview = numberOrZero(quality.linesToReview);
    const botFailures = outcomeCount(botActivity, "failure");
    const transcriberFailures = outcomeCount(transcriberActivity, "failure");
    const activityFailures = botFailures + transcriberFailures;
    const issueMap = mergeIssueCodes(botActivity, transcriberActivity);

    const artifacts = await existingArtifacts([
      join(exportDirectory, "transcript.raw.json"),
      join(exportDirectory, "bitacora.md"),
      join(exportDirectory, "bitacora-inteligente.json"),
      join(exportDirectory, "contexto-narrativo.json"),
      join(recordingDirectory, "transcript_full.json"),
      join(recordingDirectory, "transcript_full.txt"),
      join(recordingDirectory, "voice_metrics.json"),
    ], this.dataRoot);

    const warnings: string[] = [];
    const failures: string[] = [];
    const whatWentWell: string[] = [];

    if (!completed) {
      failures.push("La sesión terminó con el marcador de transcripción fallida.");
      ensureIssue(issueMap, "TRANSCRIPTION_JOB_FAILED", 1);
    }
    if (activityFailures > 0) {
      const detail = `${activityFailures} evento(s) interno(s) registraron un fallo durante el procesamiento.`;
      if (completed) warnings.push(`${detail} La sesión consiguió recuperarse y consolidarse después.`);
      else failures.push(detail);
    }
    if (completed && transcript === null) warnings.push("La sesión terminó, pero falta transcript.raw.json para auditar la calidad consolidada.");
    if (completed && voiceMetrics === null) warnings.push("La sesión terminó, pero falta voice_metrics.json para auditar VAD y uso de GPU.");
    if (completed && artifacts.length < 4) warnings.push(`Solo se encontraron ${artifacts.length} artefacto(s) principal(es) de salida.`);
    if (suspiciousSegments > 0) {
      warnings.push(`${suspiciousSegments} segmento(s) fueron marcados como posibles alucinaciones o dudosos.`);
      ensureIssue(issueMap, "SUSPECTED_HALLUCINATION", suspiciousSegments);
    }
    if (unintelligible > 0) {
      warnings.push(`${unintelligible} fragmento(s) terminaron como ininteligibles.`);
      ensureIssue(issueMap, "WHISPER_UNINTELLIGIBLE", unintelligible);
    }
    if (linesToReview > 0) {
      warnings.push(`${linesToReview} intervención(es) tienen confianza suficiente para conservarse, pero conviene revisarlas.`);
      ensureIssue(issueMap, "LOW_CONFIDENCE_OUTPUT", linesToReview);
    }

    if (completed) whatWentWell.push("Todos los trabajos necesarios alcanzaron un estado terminal y se consolidó la transcripción.");
    if (transcript !== null) whatWentWell.push("Se generó transcript.raw.json con líneas, calidad y diagnósticos de segmentos.");
    if ((quality.averageWordConfidence ?? null) !== null) {
      whatWentWell.push(`Whisper produjo una confianza media de palabra de ${Math.round((quality.averageWordConfidence ?? 0) * 100)} %.`);
    }
    if (suspiciousSegments === 0 && transcript !== null) {
      whatWentWell.push("Los filtros de calidad no dejaron segmentos marcados como posible alucinación en el resultado consolidado.");
    }
    if (numberOrZero(voiceMetrics?.segments_sent_to_whisper) > 0) {
      whatWentWell.push("VAD separó audio útil y envió únicamente fragmentos con voz a Whisper cuando correspondía.");
    }
    if (artifacts.length >= 4) whatWentWell.push("Los artefactos principales de transcripción y bitácora fueron escritos correctamente.");

    const checks: TranscriptionReport["checks"] = [
      {
        process: "cola y despacho",
        outcome: completed ? "success" : "failure",
        detail: completed
          ? "La sesión alcanzó .transcription-ready."
          : "La sesión alcanzó .transcription-failed.",
        evidence: [completed ? ".transcription-ready" : ".transcription-failed"],
      },
      {
        process: "VAD y voz",
        outcome: voiceMetrics === null ? "unknown" : unintelligible > 0 ? "warning" : "success",
        detail: voiceMetrics === null
          ? "No hay voice_metrics.json para evaluar esta etapa."
          : `${numberOrZero(voiceMetrics.segments_sent_to_whisper)} fragmento(s) enviados a Whisper; ${unintelligible} ininteligible(s).`,
        evidence: voiceMetrics === null ? [] : ["voice_metrics.json"],
      },
      {
        process: "Whisper y validación",
        outcome: transcript === null ? "unknown" : suspiciousSegments > 0 ? "warning" : "success",
        detail: transcript === null
          ? "No hay transcript.raw.json para evaluar la calidad consolidada."
          : `${transcript.lines?.length ?? 0} línea(s) consolidadas; ${suspiciousSegments} segmento(s) dudosos.`,
        evidence: transcript === null ? [] : ["transcript.raw.json", "diagnostic activity"],
      },
      {
        process: "exportación",
        outcome: artifacts.length >= 4 ? "success" : completed ? "warning" : "failure",
        detail: `${artifacts.length} artefacto(s) principales encontrados.`,
        evidence: artifacts,
      },
    ];

    const outcome: TranscriptionReport["outcome"] = failures.length > 0
      ? "failure"
      : warnings.length > 0
        ? "warning"
        : "success";
    if (outcome === "warning") ensureIssue(issueMap, "FINAL_REPORT_WARNING", 1);
    if (outcome === "failure") ensureIssue(issueMap, "FINAL_REPORT_FAILURE", 1);

    return {
      version: 1,
      sessionId,
      generatedAt: new Date().toISOString(),
      outcome,
      summary: {
        lines: transcript?.lines?.length ?? 0,
        averageWordConfidence: quality.averageWordConfidence ?? null,
        wordCount: numberOrZero(quality.wordCount),
        lowConfidenceWords: numberOrZero(quality.lowConfidenceWords),
        linesToReview,
        suspectedHallucinations: suspiciousSegments,
        unintelligible,
        totalAudioSeconds: roundMetric(voiceMetrics?.duration_total_seconds),
        speechSeconds: roundMetric(voiceMetrics?.time_speech_seconds),
        silenceSeconds: roundMetric(voiceMetrics?.time_silence_seconds),
        gpuSeconds: roundMetric(voiceMetrics?.gpu_seconds),
        segmentsSentToWhisper: numberOrZero(voiceMetrics?.segments_sent_to_whisper),
        segmentsTranscribed: numberOrZero(voiceMetrics?.segments_transcribed),
      },
      checks,
      issues: [...issueMap.values()].sort((left, right) => left.code.localeCompare(right.code)),
      whatWentWell,
      warnings,
      failures,
      artifacts,
      activity: {
        botEvents: eventCount(botActivity),
        transcriberEvents: eventCount(transcriberActivity),
      },
    };
  }
}

function mergeIssueCodes(
  ...summaries: readonly (ActivitySummary | null)[]
): Map<string, ReportIssue> {
  const result = new Map<string, ReportIssue>();
  for (const summary of summaries) {
    for (const [code, value] of Object.entries(summary?.codes ?? {})) {
      const name = value.name as DottyIssueName | undefined;
      if (name === undefined) continue;
      try {
        const definition = dottyIssue(name);
        const current = result.get(code);
        result.set(code, {
          code: definition.code,
          name: definition.name,
          severity: definition.severity,
          count: (current?.count ?? 0) + Math.max(1, numberOrZero(value.count)),
          recoverable: definition.recoverable,
          description: definition.description,
          suggestedAction: definition.suggestedAction,
        });
      } catch {
        // Unknown legacy codes are ignored rather than breaking the final report.
      }
    }
  }
  return result;
}

function ensureIssue(
  issues: Map<string, ReportIssue>,
  name: DottyIssueName,
  observedCount: number,
): void {
  const definition = dottyIssue(name);
  const current = issues.get(definition.code);
  issues.set(definition.code, {
    code: definition.code,
    name: definition.name,
    severity: definition.severity,
    count: Math.max(current?.count ?? 0, Math.max(1, Math.round(observedCount))),
    recoverable: definition.recoverable,
    description: definition.description,
    suggestedAction: definition.suggestedAction,
  });
}

function eventCount(summary: ActivitySummary | null): number {
  return numberOrZero(summary?.eventCount ?? summary?.event_count);
}

function outcomeCount(summary: ActivitySummary | null, outcome: string): number {
  return numberOrZero(summary?.outcomes?.[outcome]);
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 160);
  return safe || "_system";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundMetric(value: unknown): number {
  return Math.round(numberOrZero(value) * 1000) / 1000;
}

async function readJson<T extends object>(path: string): Promise<T | null> {
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as T
      : null;
  } catch {
    return null;
  }
}

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

function newestStat(
  left: Awaited<ReturnType<typeof fs.stat>> | null,
  right: Awaited<ReturnType<typeof fs.stat>> | null,
): Awaited<ReturnType<typeof fs.stat>> | null {
  if (left === null) return right;
  if (right === null) return left;
  return left.mtimeMs >= right.mtimeMs ? left : right;
}

async function existingArtifacts(paths: readonly string[], root: string): Promise<string[]> {
  const existing = await Promise.all(paths.map(async (path) => {
    try {
      await fs.access(path, constants.F_OK);
      return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/u, "") : path;
    } catch {
      return null;
    }
  }));
  return existing.filter((path): path is string => path !== null);
}
