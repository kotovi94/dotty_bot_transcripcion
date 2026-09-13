import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import pino from "pino";

import type { DottyDiagnostics } from "./dotty-diagnostics.ts";
import { TranscriptionReportService } from "./transcription-report-service.ts";

describe("transcription diagnostic report", () => {
  it("combines quality, voice and activity evidence into a final session report", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-transcription-report-"));
    const sessionId = "session-42";
    const recordings = join(root, "recordings");
    const exportsRoot = join(root, "exports");
    const recording = join(recordings, sessionId);
    const exported = join(exportsRoot, sessionId);
    const diagnosticsDirectory = join(root, ".diagnostics", sessionId);
    try {
      await Promise.all([
        mkdir(recording, { recursive: true }),
        mkdir(exported, { recursive: true }),
        mkdir(diagnosticsDirectory, { recursive: true }),
      ]);
      await writeFile(
        join(recording, "manifest.json"),
        `${JSON.stringify({ sessionId, status: "completed" })}\n`,
        "utf8",
      );
      await writeFile(
        join(recording, "voice_metrics.json"),
        `${JSON.stringify({
          duration_total_seconds: 3600,
          time_speech_seconds: 1800,
          time_silence_seconds: 1200,
          segments_sent_to_whisper: 8,
          segments_transcribed: 8,
          unintelligible: 1,
          suspected_hallucination: 1,
          gpu_seconds: 320,
        })}\n`,
        "utf8",
      );
      await writeFile(
        join(exported, "transcript.raw.json"),
        `${JSON.stringify({
          quality: {
            averageWordConfidence: 0.91,
            wordCount: 1500,
            lowConfidenceWords: 12,
            linesToReview: 2,
          },
          lines: Array.from({ length: 120 }, (_, index) => ({ index })),
          diagnostics: [{ reason: "possible hallucination" }],
        })}\n`,
        "utf8",
      );
      await Promise.all([
        writeFile(join(exported, "bitacora.md"), "# test\n", "utf8"),
        writeFile(join(exported, "bitacora-inteligente.json"), "{}\n", "utf8"),
        writeFile(join(exported, "contexto-narrativo.json"), "{}\n", "utf8"),
        writeFile(join(recording, "transcript_full.json"), "{}\n", "utf8"),
        writeFile(join(recording, "transcript_full.txt"), "test\n", "utf8"),
        writeFile(join(diagnosticsDirectory, "report.bot.json"), `${JSON.stringify({ eventCount: 4, outcomes: { failure: 0 } })}\n`, "utf8"),
        writeFile(join(diagnosticsDirectory, "report.transcriber.json"), `${JSON.stringify({ event_count: 12, outcomes: { failure: 0 } })}\n`, "utf8"),
      ]);
      await writeFile(join(recording, ".transcription-ready"), `${new Date().toISOString()}\n`, "utf8");

      const recorded: unknown[] = [];
      const diagnostics = {
        recordActivity: async (event: unknown) => { recorded.push(event); },
      } as Pick<DottyDiagnostics, "recordActivity">;
      const service = new TranscriptionReportService(
        recordings,
        exportsRoot,
        root,
        diagnostics,
        pino({ level: "silent" }),
      );
      await service.scan();

      const report = JSON.parse(
        await readFile(join(diagnosticsDirectory, "transcription-report.json"), "utf8"),
      ) as {
        outcome: string;
        summary: Record<string, number>;
        warnings: string[];
        whatWentWell: string[];
        activity: { botEvents: number; transcriberEvents: number };
      };
      assert.equal(report.outcome, "warning");
      assert.equal(report.summary.lines, 120);
      assert.equal(report.summary.averageWordConfidence, 0.91);
      assert.equal(report.summary.suspectedHallucinations, 1);
      assert.equal(report.activity.botEvents, 4);
      assert.equal(report.activity.transcriberEvents, 12);
      assert(report.warnings.some((item) => item.includes("posibles alucinaciones")));
      assert(report.whatWentWell.some((item) => item.includes("91 %")));
      assert.equal(recorded.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
