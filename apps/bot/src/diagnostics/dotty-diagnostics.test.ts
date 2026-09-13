import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { SessionService } from "../sessions/session-service.ts";
import { DottyDiagnostics, formatBytes } from "./dotty-diagnostics.ts";

describe("diagnostic storage formatting", () => {
  it("uses readable binary units", () => {
    assert.equal(formatBytes(10 * 1_073_741_824), "10.0 GB");
    assert.equal(formatBytes(512 * 1_048_576), "512.0 MB");
    assert.equal(formatBytes(1024), "1 KB");
  });

  it("persists append-only session activity, stable issue codes and an aggregate report", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-diagnostics-"));
    try {
      const diagnostics = new DottyDiagnostics(
        {} as CampaignService,
        {} as SessionService,
        "http://127.0.0.1:8765",
        root,
      );
      await diagnostics.recordActivity({
        sessionId: "session:42",
        component: "transcription",
        process: "publish",
        outcome: "started",
        message: "Preparando transcripción",
      });
      await diagnostics.recordActivity({
        sessionId: "session:42",
        component: "transcription",
        process: "publish",
        outcome: "warning",
        issue: "TRANSCRIPTION_STATUS_FETCH_FAILED",
        message: "No se pudo consultar el estado; se reintentará.",
        durationMs: 1250,
        evidence: ["temporary_fetch_failure"],
        metrics: { jobs: 8, lines: 412, secret: "must-not-leak" },
      });

      const directory = join(root, ".diagnostics", "session_42");
      const lines = (await readFile(join(directory, "activity.bot.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(lines.length, 2);
      assert.equal(lines[1]?.outcome, "warning");
      assert.deepEqual(
        (lines[1]?.metrics as Record<string, unknown>)?.secret,
        "[REDACTED]",
      );
      const issue = lines[1]?.issue as Record<string, unknown>;
      assert.equal(issue.code, "DOTTY-PUB-6001");
      assert.equal(issue.name, "TRANSCRIPTION_STATUS_FETCH_FAILED");

      const report = JSON.parse(
        await readFile(join(directory, "report.bot.json"), "utf8"),
      ) as {
        eventCount: number;
        outcomes: Record<string, number>;
        processes: Record<string, { totalDurationMs: number }>;
        codes: Record<string, { name: string; count: number }>;
        recentIssues: unknown[];
      };
      assert.equal(report.eventCount, 2);
      assert.equal(report.outcomes.warning, 1);
      assert.equal(report.processes["transcription.publish"]?.totalDurationMs, 1250);
      assert.equal(report.codes["DOTTY-PUB-6001"]?.name, "TRANSCRIPTION_STATUS_FETCH_FAILED");
      assert.equal(report.codes["DOTTY-PUB-6001"]?.count, 1);
      assert.equal(report.recentIssues.length, 1);
      assert.notEqual(await diagnostics.readActivityReport("session:42"), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
