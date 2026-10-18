import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Client } from "discord.js";
import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import type { AdaptiveVocabularyStore } from "../transcription/adaptive-vocabulary.ts";
import { TranscriptionDispatcher } from "../transcription/transcription-dispatcher.ts";
import { SessionAdministration } from "./session-administration.ts";
import { ReprocessIntentStore } from "./reprocess-intent-store.ts";
import { CampaignFileCoordinator } from "./campaign-file-coordinator.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";
import type { SessionService } from "./session-service.ts";

const directories: string[] = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true }))));

function protection(root: string): [ReprocessIntentStore, SessionFileCoordinator, CampaignFileCoordinator] {
  const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const campaignCoordinator = new CampaignFileCoordinator(join(root, "campaign-locks"));
  return [new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator,
    { assertEligible: async (_sessionId: string) => {} }), coordinator, campaignCoordinator];
}

describe("session administration", () => {
  it("passes the requested session identity to capture cancellation and stops on mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-delete-identity-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const active = join(recordings, "session-a");
    const requested = join(recordings, "session-b");
    await mkdir(active, { recursive: true });
    await mkdir(requested, { recursive: true });
    await writeFile(join(active, "active.wav"), "active audio");
    await writeFile(join(requested, "requested.wav"), "requested audio");
    const calls: Array<[string, string]> = [];
    const recordingsManager = { cancelIfActive: async (guildId: string, sessionId: string) => {
      calls.push([guildId, sessionId]);
      throw new Error("Active voice capture does not match the requested session.");
    } } as unknown as VoiceCaptureManager;
    const administration = new SessionAdministration(
      {} as Client,
      {} as CampaignService,
      { findById: async () => ({ id: "session-b", discordGuildId: "guild", status: "recording" }) } as unknown as SessionService,
      recordingsManager, recordings, join(root, "exports"), "http://127.0.0.1:8765", "secret",
      { info() {}, error() {} } as unknown as Logger,
      ...protection(root),
    );
    await assert.rejects(administration.delete("session-b", "guild"), /does not match/);
    assert.deepEqual(calls, [["guild", "session-b"]]);
    assert.equal(await readFile(join(active, "active.wav"), "utf8"), "active audio");
    assert.equal(await readFile(join(requested, "requested.wav"), "utf8"), "requested audio");
  });

  it("leaves existing files and blocks redispatch when recovery fails after DELETE", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-reprocess-prisma-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const directory = join(recordings, "session-1");
    const audioPath = join(directory, "audio", "clip_001", "user-1.wav");
    await mkdir(join(directory, ".transcription-jobs"), { recursive: true });
    await mkdir(join(directory, "audio", "clip_001"), { recursive: true });
    await mkdir(join(exports, "session-1"), { recursive: true });
    const files = new Map([
      [join(directory, "manifest.json"), JSON.stringify({
        version: 1,
        sessionId: "session-1",
        campaignId: "campaign-1",
        campaignName: "Campaign",
        discordGuildId: "guild-1",
        status: "completed",
        chunks: [{ id: "chunk-1", file: "audio/clip_001/user-1.wav" }],
      })],
      [join(directory, ".transcription-jobs", "chunk-1"), "queued"],
      [join(directory, ".transcription-enqueued"), "queued"],
      [join(directory, ".transcription-failed"), "failed"],
      [join(directory, ".transcription-ready"), "ready"],
      [join(directory, ".transcription-published"), "published"],
      [join(exports, "session-1", "bitacora.md"), "old export"],
    ]);
    for (const [path, contents] of files) await writeFile(path, contents);
    const audio = Buffer.alloc(48, 1);
    await writeFile(audioPath, audio);

    let status = "failed";
    let recoverCalls = 0;
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
    };
    try {
      const administration = new SessionAdministration(
        { channels: { fetch: async () => null } } as unknown as Client,
        { findByGuildAndName: async () => ({ id: "campaign-1" }) } as unknown as CampaignService,
        {
          findById: async () => ({ id: "session-1", discordGuildId: "guild-1", campaignName: "Campaign", status }),
          recoverFailed: async () => {
            recoverCalls++;
            throw new Error("Prisma unavailable");
          },
        } as unknown as SessionService,
        {} as VoiceCaptureManager,
        recordings,
        exports,
        "http://127.0.0.1:8765",
        "secret",
        { info() {}, error() {} } as unknown as Logger,
        ...protection(root),
      );
      await assert.rejects(administration.reprocess("session-1", "guild-1"), /Prisma unavailable/);
      assert.equal(recoverCalls, 1);
      assert.equal(status, "failed");
      assert.deepEqual(requests, [{
        url: "http://127.0.0.1:8765/v1/sessions/session-1",
        method: "DELETE",
      }]);
      for (const [path, contents] of files) {
        assert.equal(await readFile(path, "utf8"), contents, path);
      }
      assert.deepEqual(await readFile(audioPath), audio);

      const dispatcher = new TranscriptionDispatcher(
        recordings,
        {} as CampaignService,
        "http://127.0.0.1:8765",
        "secret",
        {} as AdaptiveVocabularyStore,
        { info() {}, warn() {}, debug() {} } as unknown as Logger,
        { findById: async () => null } as never,
        new SessionFileCoordinator(join(root, "session-locks")),
        { read: async () => null } as never,
      );
      await dispatcher.dispatchCompleted();
      assert.equal(requests.length, 1, "the existing enqueued marker prevents a new POST");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a failed session and its files intact when the transcriber returns 503", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-reprocess-503-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const directory = join(recordings, "session-1");
    const exportDirectory = join(exports, "session-1");
    await mkdir(join(directory, ".transcription-jobs"), { recursive: true });
    await mkdir(exportDirectory, { recursive: true });
    const files = new Map([
      [join(directory, "manifest.json"), JSON.stringify({
        sessionId: "session-1",
        campaignId: "campaign-1",
        campaignName: "Campaign",
        discordGuildId: "guild-1",
        status: "interrupted",
        endedAt: "2026-01-01T01:00:00.000Z",
        chunks: [{ id: "chunk-1", file: "audio.wav" }],
      })],
      [join(directory, ".transcription-jobs", "chunk-1"), "queued"],
      [join(directory, ".transcription-enqueued"), "queued"],
      [join(directory, ".transcription-failed"), "failed"],
      [join(directory, ".transcription-ready"), "ready"],
      [join(directory, ".transcription-published"), "published"],
      [join(exportDirectory, "bitacora.md"), "old export"],
    ]);
    for (const [path, contents] of files) await writeFile(path, contents);
    await writeFile(join(directory, "audio.wav"), Buffer.alloc(48, 1));

    let status = "failed";
    let recoverCalls = 0;
    const session = {
      id: "session-1",
      discordGuildId: "guild-1",
      campaignName: "Campaign",
      status: "failed",
    };
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 503 });
    };
    try {
      const administration = new SessionAdministration(
        { channels: { fetch: async () => null } } as unknown as Client,
        { findByGuildAndName: async () => ({ id: "campaign-1" }) } as unknown as CampaignService,
        {
          findById: async () => session,
          recoverFailed: async () => {
            recoverCalls++;
            status = "completed";
            return true;
          },
        } as unknown as SessionService,
        {} as VoiceCaptureManager,
        recordings,
        exports,
        "http://127.0.0.1:8765",
        "secret",
        { info() {}, error() {} } as unknown as Logger,
        ...protection(root),
      );

      await assert.rejects(
        administration.reprocess("session-1", "guild-1"),
        /No se pudo conectar con el transcriptor/,
      );
      assert.deepEqual(requests, [{
        url: "http://127.0.0.1:8765/v1/sessions/session-1",
        method: "DELETE",
      }]);
      for (const [path, contents] of files) {
        assert.equal(await readFile(path, "utf8"), contents, path);
      }
      assert.equal(status, "failed", "a failed reprocess must not recover the session");
      assert.equal(recoverCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clears persistent job markers before reprocessing a session", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-reprocess-"));
    directories.push(root);
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const directory = join(recordings, "session-1");
    await mkdir(join(directory, ".transcription-jobs"), { recursive: true });
    await mkdir(join(exports, "session-1"), { recursive: true });
    await writeFile(join(directory, ".transcription-jobs", "chunk-1"), "queued");
    await writeFile(join(directory, ".transcription-enqueued"), "queued");
    await writeFile(join(directory, ".transcription-published"), "published");
    await writeFile(join(exports, "session-1", "bitacora.md"), "old export");
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      version: 2,
      sessionId: "session-1",
      campaignId: "campaign-1",
      sequenceNumber: 1,
      discordGuildId: "guild-1",
      voiceChannelId: "voice-1",
      logChannelId: null,
      campaignName: "Campaign",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T01:00:00.000Z",
      status: "completed",
      clips: [],
      chunks: [{
        id: "chunk-1",
        clipIndex: 1,
        speakerUserId: "user-1",
        speakerName: "Player",
        file: "audio/clip_001/user-1.wav",
        startedOffsetMs: 0,
        endedOffsetMs: 1_000,
        bytes: 100,
        sha256: "hash",
        overlapMs: 0,
      }],
    }));
    await mkdir(join(directory, "audio", "clip_001"), { recursive: true });
    await writeFile(join(directory, "audio", "clip_001", "user-1.wav"), Buffer.alloc(48, 1));

    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ deleted: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const session = {
        id: "session-1",
        discordGuildId: "guild-1",
        campaignName: "Campaign",
        sequenceNumber: 1,
        status: "completed",
        voiceChannelId: "voice-1",
        logChannelId: null,
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        endedAt: new Date("2026-01-01T01:00:00.000Z"),
      } as const;
      const administration = new SessionAdministration(
        { channels: { fetch: async () => null } } as unknown as Client,
        { findByGuildAndName: async () => ({ id: "campaign-1" }) } as unknown as CampaignService,
        { findById: async () => session } as unknown as SessionService,
        {} as VoiceCaptureManager,
        recordings,
        exports,
        "http://127.0.0.1:8765",
        "secret",
        { info() {}, error() {} } as unknown as Logger,
        ...protection(root),
      );

      await administration.reprocess("session-1", "guild-1");

      assert.deepEqual(requests, [{
        url: "http://127.0.0.1:8765/v1/sessions/session-1",
        method: "DELETE",
      }]);
      await assert.rejects(access(join(directory, ".transcription-jobs")));
      await assert.rejects(access(join(directory, ".transcription-enqueued")));
      await assert.rejects(access(join(directory, ".transcription-published")));
      await assert.rejects(access(join(exports, "session-1")));
      assert.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).sessionId, "session-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
