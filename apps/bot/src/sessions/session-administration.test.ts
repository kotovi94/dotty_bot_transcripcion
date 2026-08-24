import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Client } from "discord.js";
import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import { SessionAdministration } from "./session-administration.ts";
import type { SessionService } from "./session-service.ts";

const directories: string[] = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true }))));

describe("session administration", () => {
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
        {} as CampaignService,
        { findById: async () => session } as unknown as SessionService,
        {} as VoiceCaptureManager,
        recordings,
        exports,
        "http://127.0.0.1:8765",
        "secret",
        { info() {}, error() {} } as unknown as Logger,
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
