import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { RecordingManifest } from "../recording/voice-capture-manager.ts";
import { ReprocessIntentStore } from "../sessions/reprocess-intent-store.ts";
import { SessionFileCoordinator } from "../sessions/session-file-coordinator.ts";

const eligible = { assertEligible: async (_sessionId: string) => {} };
import { AudioRetentionManager } from "./audio-retention-manager.ts";

const directories: string[] = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true }))));

describe("audio retention", () => {
  it("preserves WAV with .posting after restart and purges when it is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-retention-posting-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    for (const id of ["session-1", "session-2"]) {
      const directory = join(recordings, id);
      await mkdir(join(directory, ".transcription-jobs"), { recursive: true });
      await writeFile(join(directory, "manifest.json"), JSON.stringify({
        version: 1, sessionId: id, campaignId: "campaign-1", status: "completed",
        endedAt: "2026-01-01T01:00:00.000Z", chunks: [],
      }));
      await writeFile(join(directory, ".transcription-published"), "ok");
      await writeFile(join(directory, "audio.wav"), Buffer.alloc(48, 1));
    }
    await writeFile(join(recordings, "session-1", ".transcription-jobs", "chunk-1.posting"), "pending");
    const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
    const campaigns = { findById: async () => ({ audioRetentionDays: 7 }) } as unknown as CampaignService;
    const makeManager = () => new AudioRetentionManager(campaigns, recordings, join(root, "exports"),
      { info() {}, error() {} } as unknown as Logger,
      new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator, eligible), coordinator);
    const beforeRestart = makeManager();
    assert.equal(await beforeRestart.cleanupExpired(), 1);
    await access(join(recordings, "session-1", "audio.wav"));
    await assert.rejects(access(join(recordings, "session-2", "audio.wav")));
    const afterRestart = makeManager();
    assert.equal(await afterRestart.cleanupExpired(), 0);
    await access(join(recordings, "session-1", "audio.wav"));
  });

  it("skips unreadable job markers and continues with independent sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-retention-unreadable-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    for (const id of ["session-1", "session-2"]) {
      const directory = join(recordings, id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "manifest.json"), JSON.stringify({
        version: 1, sessionId: id, campaignId: "campaign-1", status: "completed",
        endedAt: "2026-01-01T01:00:00.000Z", chunks: [],
      }));
      await writeFile(join(directory, ".transcription-published"), "ok");
      await writeFile(join(directory, "audio.wav"), Buffer.alloc(48, 1));
    }
    // readdir on a file fails with ENOTDIR, independently of account permissions.
    await writeFile(join(recordings, "session-1", ".transcription-jobs"), "unreadable directory");
    const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
    const errors: unknown[] = [];
    const manager = new AudioRetentionManager(
      { findById: async () => ({ audioRetentionDays: 7 }) } as unknown as CampaignService,
      recordings, join(root, "exports"),
      { info() {}, error(value: unknown) { errors.push(value); } } as unknown as Logger,
      new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator, eligible), coordinator);
    assert.equal(await manager.cleanupExpired(), 1);
    assert.equal(errors.length, 1);
    await access(join(recordings, "session-1", "audio.wav"));
    await assert.rejects(access(join(recordings, "session-2", "audio.wav")));
  });
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
    const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
    const manager = new AudioRetentionManager(campaigns, recordings, exports, logger,
      new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator, eligible), coordinator);
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
        new ReprocessIntentStore(join(root, "reprocess-intents"), new SessionFileCoordinator(join(root, "session-locks")), eligible),
        new SessionFileCoordinator(join(root, "session-locks")),
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

  for (const phase of ["prepared", "delete-confirmed", "recovering", "redispatch-ready", "completed"] as const) {
    it(`checks intent phase ${phase} before deleting audio`, async () => {
      const root = await mkdtemp(join(tmpdir(), "dotty-retention-intent-"));
      directories.push(root);
      const recordings = join(root, "recordings");
      const sessionDirectory = join(recordings, "session-1");
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(join(sessionDirectory, "manifest.json"), JSON.stringify({
        version: 1, sessionId: "session-1", campaignId: "campaign-1", status: "completed",
        endedAt: "2026-01-01T01:00:00.000Z", chunks: [],
      }));
      await writeFile(join(sessionDirectory, ".transcription-published"), "ok");
      const wav = join(sessionDirectory, "audio.wav");
      await writeFile(wav, "fictional audio");
      const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
      const intents = new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator, eligible);
      const created = await intents.create("session-1");
      for (const next of ["delete-confirmed", "recovering", "redispatch-ready", "completed"] as const) {
        if (phase === "prepared") break;
        await intents.updatePhase("session-1", created.operationId, next);
        if (phase === next) break;
      }
      const campaigns = { findById: async () => ({ audioRetentionDays: 7 }) } as unknown as CampaignService;
      const logger = { info() {}, error() {} } as unknown as Logger;
      const restarted = new AudioRetentionManager(campaigns, recordings, join(root, "exports"), logger,
        new ReprocessIntentStore(join(root, "reprocess-intents"), new SessionFileCoordinator(join(root, "session-locks")), eligible),
        new SessionFileCoordinator(join(root, "session-locks")));
      if (phase === "completed") {
        await writeFile(`${intents.pathFor("session-1")}.lock`, "abandoned");
        assert.equal(await restarted.cleanupExpired(), 0);
        assert.equal(await readFile(wav, "utf8"), "fictional audio");
        await rm(`${intents.pathFor("session-1")}.lock`);
      }
      assert.equal(await restarted.cleanupExpired(), phase === "completed" ? 1 : 0);
      if (phase === "completed") await assert.rejects(access(wav));
      else assert.equal(await readFile(wav, "utf8"), "fictional audio");
    });
  }

  it("keeps audio when an intent is corrupt or only a temporary survives", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-retention-uncertain-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const sessionDirectory = join(recordings, "session-1");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "manifest.json"), JSON.stringify({
      sessionId: "session-1", campaignId: "campaign-1", status: "completed",
      endedAt: "2026-01-01T01:00:00.000Z", chunks: [],
    }));
    await writeFile(join(sessionDirectory, ".transcription-published"), "ok");
    const wav = join(sessionDirectory, "audio.wav");
    await writeFile(wav, "fictional audio");
    const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
    const intents = new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator, eligible);
    const campaigns = { findById: async () => ({ audioRetentionDays: 7 }) } as unknown as CampaignService;
    const errors: unknown[] = [];
    const logger = { info() {}, error(value: unknown) { errors.push(value); } } as unknown as Logger;
    const manager = new AudioRetentionManager(campaigns, recordings, join(root, "exports"), logger, intents, coordinator);
    await mkdir(join(root, "reprocess-intents"));
    await writeFile(intents.pathFor("session-1"), "corrupt");
    assert.equal(await manager.cleanupExpired(), 0);
    assert.equal(await readFile(wav, "utf8"), "fictional audio");
    await rm(intents.pathFor("session-1"));
    await writeFile(`${intents.pathFor("session-1")}.interrupted.tmp`, "uncommitted");
    assert.equal(await manager.cleanupExpired(), 0);
    assert.equal(await readFile(wav, "utf8"), "fictional audio");
    assert.equal(errors.length, 2);
  });

  it("keeps audio when the shared lock cannot be acquired", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-retention-lock-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const sessionDirectory = join(recordings, "session-1");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "manifest.json"), JSON.stringify({
      sessionId: "session-1", campaignId: "campaign-1", status: "completed",
      endedAt: "2026-01-01T01:00:00.000Z", chunks: [],
    }));
    await writeFile(join(sessionDirectory, ".transcription-published"), "ok");
    const wav = join(sessionDirectory, "audio.wav");
    await writeFile(wav, "fictional audio");
    const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
    await mkdir(join(root, "session-locks"));
    await writeFile(coordinator.pathFor("session-1"), "abandoned");
    const errors: unknown[] = [];
    const logger = { info() {}, error(value: unknown) { errors.push(value); } } as unknown as Logger;
    const intents = new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator, eligible);
    const manager = new AudioRetentionManager(
      { findById: async () => ({ audioRetentionDays: 7 }) } as unknown as CampaignService,
      recordings, join(root, "exports"), logger, intents, coordinator);
    assert.equal(await manager.cleanupExpired(), 0);
    assert.equal(await readFile(wav, "utf8"), "fictional audio");
    assert.equal(await readFile(coordinator.pathFor("session-1"), "utf8"), "abandoned");
    assert.equal(errors.length, 1);
  });

  it("sees an intent created while retention is scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-retention-race-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const sessionDirectory = join(recordings, "session-1");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "manifest.json"), JSON.stringify({
      sessionId: "session-1", campaignId: "campaign-1", status: "completed",
      endedAt: "2026-01-01T01:00:00.000Z", chunks: [],
    }));
    await writeFile(join(sessionDirectory, ".transcription-published"), "ok");
    const wav = join(sessionDirectory, "audio.wav");
    await writeFile(wav, "fictional audio");
    let scanned!: () => void;
    const atCampaign = new Promise<void>((resolve) => { scanned = resolve; });
    let proceed!: () => void;
    const continueScan = new Promise<void>((resolve) => { proceed = resolve; });
    const campaigns = { findById: async () => {
      scanned();
      await continueScan;
      return { audioRetentionDays: 7 };
    } } as unknown as CampaignService;
    const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
    const intents = new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator, eligible);
    const manager = new AudioRetentionManager(campaigns, recordings, join(root, "exports"),
      { info() {}, error() {} } as unknown as Logger, intents, coordinator);
    const cleanup = manager.cleanupExpired();
    await atCampaign;
    await intents.create("session-1");
    proceed();
    assert.equal(await cleanup, 0);
    assert.equal(await readFile(wav, "utf8"), "fictional audio");
  });
});
