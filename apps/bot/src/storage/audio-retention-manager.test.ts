import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { RecordingManifest } from "../recording/voice-capture-manager.ts";
import { AudioRetentionManager } from "./audio-retention-manager.ts";

const directories: string[] = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true }))));

describe("audio retention", () => {
  it("removes only WAV files from expired published sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-retention-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const sessionDirectory = join(recordings, "session-1");
    const exportDirectory = join(exports, "session-1");
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(exportDirectory, { recursive: true });
    await writeFile(
      join(sessionDirectory, "manifest.json"),
      JSON.stringify({
        version: 1,
        sessionId: "session-1",
        campaignId: "campaign-1",
        sequenceNumber: 1,
        discordGuildId: "guild",
        voiceChannelId: "voice",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T01:00:00.000Z",
        status: "completed",
        chunks: [],
      }),
    );
    await writeFile(join(sessionDirectory, ".transcription-published"), "ok");
    const audioDirectory = join(sessionDirectory, "audio", "clip_001");
    await mkdir(audioDirectory, { recursive: true });
    await writeFile(join(audioDirectory, "voice.wav"), Buffer.alloc(2048));
    await writeFile(join(audioDirectory, "preserve.txt"), "metadata");
    await writeFile(join(exportDirectory, "bitacora.md"), "transcripción");

    const campaigns = {
      findById: async () => ({ audioRetentionDays: 7 }),
    } as unknown as CampaignService;
    const logger = { info() {}, error() {} } as unknown as Logger;
    const manager = new AudioRetentionManager(campaigns, recordings, exports, logger);
    assert.equal((await manager.report("campaign-1")).eligibleForCleanup, 1);
    assert.equal(await manager.cleanupExpired(), 1);
    await assert.rejects(access(join(audioDirectory, "voice.wav")));
    assert.equal(await readFile(join(audioDirectory, "preserve.txt"), "utf8"), "metadata");
    assert.match(await readFile(join(sessionDirectory, "manifest.json"), "utf8"), /session-1/);
    assert.equal(await readFile(join(exportDirectory, "bitacora.md"), "utf8"), "transcripción");
    const report = await manager.report("campaign-1");
    assert.equal(report.sessionsWithAudio, 0);
    assert.equal(report.sessionsWithoutAudio, 1);
    assert.equal(report.eligibleForCleanup, 0);
  });

  const protectedCases: readonly {
    name: string;
    status: RecordingManifest["status"];
    retentionDays: number | null;
    marker: ".transcription-ready" | ".transcription-published" | null;
    endedAt: string | null;
  }[] = [
    { name: "prepared but unpublished", status: "completed", retentionDays: 7, marker: ".transcription-ready", endedAt: "2026-01-01T01:00:00.000Z" },
    { name: "without a publication marker", status: "completed", retentionDays: 7, marker: null, endedAt: "2026-01-01T01:00:00.000Z" },
    { name: "without a retention policy", status: "completed", retentionDays: null, marker: ".transcription-published", endedAt: "2026-01-01T01:00:00.000Z" },
    { name: "not yet expired", status: "completed", retentionDays: 7, marker: ".transcription-published", endedAt: "2999-01-01T01:00:00.000Z" },
    { name: "without an end timestamp", status: "completed", retentionDays: 7, marker: ".transcription-published", endedAt: null },
    ...(["recording", "paused", "finalizing", "interrupted"] as const).map((status) => ({
      name: status,
      status,
      retentionDays: 7,
      marker: ".transcription-published" as const,
      endedAt: "2026-01-01T01:00:00.000Z",
    })),
  ];

  for (const scenario of protectedCases) {
    it(`preserves audio and reports no cleanup for a session ${scenario.name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "dotty-retention-protected-"));
      directories.push(root);
      const recordings = join(root, "recordings");
      const sessionDirectory = join(recordings, "session-1");
      const audioDirectory = join(sessionDirectory, "audio", "clip_001");
      await mkdir(audioDirectory, { recursive: true });
      const manifest = JSON.stringify({
        version: 2,
        sessionId: "session-1",
        campaignId: "campaign-1",
        status: scenario.status,
        endedAt: scenario.endedAt,
        chunks: [],
      });
      await writeFile(join(sessionDirectory, "manifest.json"), manifest);
      if (scenario.marker !== null) {
        await writeFile(join(sessionDirectory, scenario.marker), "ok");
      }
      const audio = Buffer.alloc(2048, 7);
      const audioPath = join(audioDirectory, "voice.wav");
      await writeFile(audioPath, audio);
      const campaigns = {
        findById: async () => ({ audioRetentionDays: scenario.retentionDays }),
      } as unknown as CampaignService;
      const manager = new AudioRetentionManager(
        campaigns,
        recordings,
        join(root, "exports"),
        { info() {}, error() {} } as unknown as Logger,
      );

      const report = await manager.report("campaign-1");
      assert.equal(report.eligibleForCleanup, 0);
      assert.equal(report.sessionsWithAudio, 1);
      assert.equal(await manager.cleanupExpired(), 0);
      assert.deepEqual(await readFile(audioPath), audio);
      assert.equal(await readFile(join(sessionDirectory, "manifest.json"), "utf8"), manifest);
      await assert.rejects(access(join(sessionDirectory, ".audio-purged")));
      assert.equal((await manager.report("campaign-1")).eligibleForCleanup, 0);
    });
  }
});
