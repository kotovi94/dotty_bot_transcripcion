import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Logger } from "pino";

import {
  clipRotationDecision,
  inferRecoveredChunkOffsets,
  VoiceCaptureManager,
  type ClipRotationOptions,
} from "./voice-capture-manager.ts";

const temporaryDirectories: string[] = [];
after(async () => Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true }))));

const options: ClipRotationOptions = {
  searchStartMs: 55 * 60_000,
  targetMs: 60 * 60_000,
  maxMs: 65 * 60_000,
  overlapMs: 1_500,
};

describe("clip rotation policy", () => {
  it("keeps a short session in one clip and prefers silence in the search window", () => {
    assert.equal(clipRotationDecision(54 * 60_000, 0, options), "none");
    assert.equal(clipRotationDecision(59 * 60_000, 1, options), "none");
    assert.equal(clipRotationDecision(59 * 60_000, 0, options), "silence");
  });

  it("forces rotation at the maximum while a speaker is active", () => {
    assert.equal(clipRotationDecision(65 * 60_000 - 1, 1, options), "none");
    assert.equal(clipRotationDecision(65 * 60_000, 1, options), "forced");
  });

  it("can produce three successive logical clips without changing session identity", () => {
    const decisions = [59, 60, 64].map((minutes) =>
      clipRotationDecision(minutes * 60_000, 0, options),
    );
    assert.deepEqual(decisions, ["silence", "silence", "silence"]);
  });
});

describe("recovered chunk timestamps", () => {
  it("reconstructs the timeline from the WAV creation time", () => {
    assert.deepEqual(
      inferRecoveredChunkOffsets(
        "2026-08-11T00:00:00.000Z",
        Date.parse("2026-08-11T00:12:34.567Z"),
        1_250,
      ),
      { startedOffsetMs: 754_567, endedOffsetMs: 755_817 },
    );
  });

  it("falls back safely without a usable creation time", () => {
    assert.deepEqual(
      inferRecoveredChunkOffsets("2026-08-11T00:00:00.000Z", 0, 500),
      { startedOffsetMs: 0, endedOffsetMs: 500 },
    );
  });
});

describe("interrupted recording recovery", () => {
  it("recovers a finalizing manifest and repairs an unfinished WAV header", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "dotty-finalizing-"));
    temporaryDirectories.push(dataRoot);
    const sessionDirectory = join(dataRoot, "recordings", "session-1");
    const audioDirectory = join(sessionDirectory, "audio", "clip_001");
    await mkdir(audioDirectory, { recursive: true });
    const wavPath = join(audioDirectory, "user-1-last.wav");
    const pcm = Buffer.alloc(960, 7);
    await writeFile(wavPath, Buffer.concat([Buffer.alloc(44), pcm]));
    await writeFile(join(sessionDirectory, "manifest.json"), JSON.stringify({
      version: 2,
      sessionId: "session-1",
      campaignId: "campaign-1",
      sequenceNumber: 1,
      discordGuildId: "guild-1",
      voiceChannelId: "voice-1",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      status: "finalizing",
      endedAt: new Date().toISOString(),
      clips: [{
        clipIndex: 1,
        sessionStartOffsetMs: 0,
        startTimestamp: new Date(Date.now() - 60_000).toISOString(),
        endTimestamp: null,
        durationSeconds: null,
        audioDirectory: "audio/clip_001",
        transcriptionStatus: "recording",
      }],
      chunks: [],
    }));

    const manager = new VoiceCaptureManager(dataRoot, {} as Logger, options);
    assert.deepEqual(await manager.recoverInterrupted(), ["session-1"]);

    const manifest = JSON.parse(await readFile(join(sessionDirectory, "manifest.json"), "utf8")) as {
      status: string;
      chunks: unknown[];
    };
    const wav = await readFile(wavPath);
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.chunks.length, 1);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(40), pcm.length);
  });
});
