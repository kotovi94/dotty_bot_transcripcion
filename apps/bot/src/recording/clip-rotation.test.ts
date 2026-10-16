import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Logger } from "pino";
import type { Guild } from "discord.js";
import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import type prism from "prism-media";
import type { PersistedSession } from "../sessions/session-repository.ts";
import { WavFileWriter } from "./wav-writer.ts";

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
  it("preserves all PCM through four hours of simulated clip rotation with four speakers", async (test) => {
    const root = await mkdtemp(join(tmpdir(), "dotty-long-capture-"));
    temporaryDirectories.push(root);
    const base = Date.parse("2026-01-01T00:00:00Z");
    let now = base;
    test.mock.method(Date, "now", () => now);
    const speaking = new EventEmitter();
    const sources = new Map<string, PassThrough>();
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Ready },
      receiver: { speaking, subscribe: (id: string) => { const source = new PassThrough(); sources.set(id, source); return source; } },
      destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; },
    });
    const manager = new VoiceCaptureManager(root, { info() {}, error() {}, warn() {} } as unknown as Logger, options, {
      connect: () => connection as unknown as VoiceConnection,
      decoder: () => new PassThrough() as unknown as prism.opus.Decoder,
    });
    await manager.start({ id: "guild", voiceAdapterCreator: {}, members: { cache: new Map() } } as unknown as Guild,
      { id: "long", campaignId: "campaign", sequenceNumber: 1, voiceChannelId: "voice", startedAt: new Date(base) } as PersistedSession);
    const probe = manager as unknown as { active: Map<string, unknown>; maybeRotate(recording: unknown): Promise<void> };
    let inputBytes = 0;
    for (const id of ["1", "2", "3", "4"]) speaking.emit("start", id);
    for (const minutes of [65, 130, 195, 240]) {
      now = base + minutes * 60_000;
      for (const source of sources.values()) { source.write(Buffer.alloc(960, minutes)); inputBytes += 960; }
      await probe.maybeRotate(probe.active.get("guild"));
    }
    await manager.finish("guild");
    const manifest = JSON.parse(await readFile(join(root, "recordings", "long", "manifest.json"), "utf8"));
    assert.equal(manifest.clips.length, 4);
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.chunks.length, 16);
    let uniqueBytes = 0;
    for (const chunk of manifest.chunks) {
      const wav = await readFile(join(root, "recordings", "long", chunk.file));
      uniqueBytes += wav.readUInt32LE(40) - chunk.overlapMs * 96;
    }
    assert.equal(uniqueBytes, inputBytes);
    assert.equal(manifest.clips.reduce((sum: number, clip: { durationSeconds: number }) => sum + clip.durationSeconds, 0), 4 * 60 * 60);
  });

  for (const failure of ["writer", "disconnect", "shutdown"] as const) {
    it(`preserves and recovers audio after ${failure}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "dotty-capture-failure-"));
      temporaryDirectories.push(root);
      const speaking = new EventEmitter();
      const subscription = new PassThrough();
      const connection = Object.assign(new EventEmitter(), {
        state: { status: VoiceConnectionStatus.Ready },
        receiver: { speaking, subscribe: () => subscription },
        destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; },
      });
      let writer: WavFileWriter | undefined;
      const manager = new VoiceCaptureManager(root, { info() {}, error() {}, warn() {} } as unknown as Logger, options, {
        connect: () => connection as unknown as VoiceConnection,
        decoder: () => new PassThrough() as unknown as prism.opus.Decoder,
        writer: (path) => { writer = new WavFileWriter(path); return writer; },
      });
      const guild = { id: "guild", voiceAdapterCreator: {}, members: { cache: new Map() } } as unknown as Guild;
      const session = { id: "session", campaignId: "campaign", sequenceNumber: 1, voiceChannelId: "voice", startedAt: new Date() } as PersistedSession;
      await manager.start(guild, session);
      speaking.emit("start", "12345");
      subscription.write(Buffer.alloc(960, 5));
      if (failure === "writer") writer!.destroy(new Error("synthetic ENOSPC"));
      if (failure === "disconnect") connection.emit("stateChange", connection.state, { status: VoiceConnectionStatus.Disconnected });
      // Allow stream events to finish before shutdown joins the interruption.
      await new Promise((done) => setImmediate(done));
      await manager.shutdown();
      const path = join(root, "recordings", "session", "manifest.json");
      const interrupted = JSON.parse(await readFile(path, "utf8"));
      assert.equal(interrupted.status, "interrupted");
      if (failure !== "shutdown") assert.match(interrupted.interruptionReason, /ENOSPC|disconnected/iu);
      const endedAt = interrupted.endedAt;
      assert.deepEqual(await manager.recoverInterrupted(), ["session"]);
      const recovered = JSON.parse(await readFile(path, "utf8"));
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.endedAt, endedAt);
      assert.equal(recovered.chunks.length, 1);
      assert.equal((await readFile(join(root, "recordings", "session", recovered.chunks[0].file))).readUInt32LE(40), 960);
      assert.deepEqual(await manager.recoverInterrupted(), []);
    });
  }

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
