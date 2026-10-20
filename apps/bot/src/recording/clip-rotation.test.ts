import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Logger } from "pino";
import type { Guild } from "discord.js";
import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import prism from "prism-media";
import type { PersistedSession } from "../sessions/session-repository.ts";
import { SessionFileCoordinator } from "../sessions/session-file-coordinator.ts";
import { WavFileWriter } from "./wav-writer.ts";

import {
  clipRotationDecision,
  inferRecoveredChunkOffsets,
  CaptureClosureError,
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

describe("capture cancellation identity", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "dotty-cancel-identity-"));
    temporaryDirectories.push(root);
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Ready },
      receiver: { speaking: new EventEmitter(), subscribe: () => new PassThrough() },
      destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; },
    });
    const manager = new VoiceCaptureManager(root, { info() {}, error() {}, warn() {} } as unknown as Logger, options, {
      connect: () => connection as unknown as VoiceConnection,
      decoder: () => new PassThrough() as unknown as prism.opus.Decoder,
    });
    const guild = { id: "guild", voiceAdapterCreator: {}, members: { cache: new Map() } } as unknown as Guild;
    await manager.start(guild, {
      id: "session-a", campaignId: "campaign", sequenceNumber: 1,
      voiceChannelId: "voice", startedAt: new Date("2026-01-01T00:00:00Z"),
    } as PersistedSession);
    const directory = join(root, "recordings", "session-a");
    const wav = join(directory, "audio", "original.wav");
    await writeFile(wav, "fictional audio");
    return { manager, directory, wav, connection };
  }

  it("cancels and removes only the matching active session", async () => {
    const { manager, directory } = await fixture();
    await manager.cancel("guild", "session-a");
    await assert.rejects(readFile(join(directory, "manifest.json")));
  });

  it("rejects a different session in the same guild and preserves its WAV", async () => {
    const { manager, wav, connection } = await fixture();
    await assert.rejects(manager.cancel("guild", "session-b"), /does not match/);
    assert.equal(await readFile(wav, "utf8"), "fictional audio");
    assert.equal(connection.state.status, VoiceConnectionStatus.Ready);
    await manager.cancel("guild", "session-a");
  });

  it("rejects a guild without an active capture", async () => {
    const { manager, wav } = await fixture();
    await assert.rejects(manager.cancel("other-guild", "session-a"), /No active voice capture/);
    assert.equal(await readFile(wav, "utf8"), "fictional audio");
    await manager.cancel("guild", "session-a");
  });

  it("preserves files if stopping chunks fails", async () => {
    const { manager, wav } = await fixture();
    const active = (manager as unknown as { active: Map<string, { chunks: Map<string, unknown> }> }).active.get("guild")!;
    const failure = Promise.reject(new Error("stop failed"));
    void failure.catch(() => undefined);
    active.chunks.set("speaker", { stop() { active.chunks.delete("speaker"); }, finished: failure });
    await assert.rejects(manager.cancel("guild", "session-a"), (error: unknown) =>
      error instanceof CaptureClosureError && error.closureState === "failed");
    assert.equal(await readFile(wav, "utf8"), "fictional audio");
  });
});

describe("interrupted recording recovery", () => {
  it("stores the configured character for a speaker at capture time", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-speaker-name-"));
    temporaryDirectories.push(root);
    const speaking = new EventEmitter();
    const source = new PassThrough();
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Ready },
      receiver: { speaking, subscribe: () => source },
      destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; },
    });
    const manager = new VoiceCaptureManager(root, { info() {}, error() {}, warn() {} } as unknown as Logger, options, {
      connect: () => connection as unknown as VoiceConnection,
      decoder: () => new PassThrough() as unknown as prism.opus.Decoder,
    }, {
      listMembersByCampaignId: async () => [{ discordUserId: "speaker", playerName: "Jugadora", characterName: "Personaje" }],
    });
    const guild = { id: "guild", voiceAdapterCreator: {}, members: { cache: new Map([
      ["speaker", { displayName: "Apodo de Discord", user: { bot: false } }],
    ]) } } as unknown as Guild;
    await manager.start(guild, { id: "named", campaignId: "campaign", sequenceNumber: 1,
      voiceChannelId: "voice", startedAt: new Date() } as PersistedSession);
    speaking.emit("start", "speaker");
    source.write(Buffer.alloc(960));
    await manager.finish("guild");
    const manifest = JSON.parse(await readFile(join(root, "recordings", "named", "manifest.json"), "utf8"));
    assert.equal(manifest.chunks[0].speakerName, "Personaje");
  });

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
      const path = join(root, "recordings", "session", "manifest.json");
      if (failure === "writer") {
        const report = await manager.shutdown();
        assert.deepEqual(report.failedCaptures.map((capture) => capture.sessionId), ["session"]);
        assert.deepEqual(report.uncertainCaptures, []);
      } else {
        await manager.shutdown();
      }
      const interrupted = JSON.parse(await readFile(path, "utf8"));
      assert.equal(interrupted.status, failure === "writer" ? "recording" : "interrupted");
      if (failure === "disconnect") assert.match(interrupted.interruptionReason, /disconnected/iu);
      const endedAt = interrupted.endedAt;
      assert.deepEqual(await manager.recoverInterrupted(), failure === "writer" ? ["session"] : []);
      const recovered = JSON.parse(await readFile(path, "utf8"));
      assert.equal(recovered.status, "interrupted");
      if (endedAt === null) assert.ok(recovered.endedAt);
      else assert.equal(recovered.endedAt, endedAt);
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
    assert.equal(manifest.status, "interrupted");
    assert.equal(manifest.chunks.length, 1);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(40), pcm.length);
  });
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface ActiveCaptureForTest {
  closeState: string;
  manifest: {
    status: string;
    clips: Array<{ startTimestamp: string }>;
    chunks: unknown[];
  };
  chunks: Map<string, { finished: Promise<void> }>;
  manifestWrite: Promise<void>;
}

function managerInternals(manager: VoiceCaptureManager) {
  return manager as unknown as {
    active: Map<string, ActiveCaptureForTest>;
    scheduleRotation(recording: ActiveCaptureForTest): void;
    queueManifestWrite(recording: ActiveCaptureForTest): Promise<void>;
  };
}

async function closureFixture(
  test: { after(callback: () => Promise<void>): void },
  setup: {
    writer?: (path: string) => WavFileWriter;
    decoder?: () => prism.opus.Decoder;
    writerCloseTimeoutMs?: number;
    writeManifest?: (path: string, value: unknown) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "dotty-close-barrier-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const speaking = new EventEmitter();
  const subscriptions = new Map<string, PassThrough>();
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready },
    receiver: {
      speaking,
      subscribe: (userId: string) => {
        const subscription = new PassThrough();
        subscriptions.set(userId, subscription);
        return subscription;
      },
    },
    destroy() { this.state = { status: VoiceConnectionStatus.Destroyed }; },
  });
  const adapters = {
    connect: () => connection as unknown as VoiceConnection,
    decoder: setup.decoder ?? (() => new PassThrough() as unknown as prism.opus.Decoder),
    ...(setup.writer === undefined ? {} : { writer: setup.writer }),
    ...(setup.writeManifest === undefined ? {} : { writeManifest: setup.writeManifest }),
    writerCloseTimeoutMs: setup.writerCloseTimeoutMs ?? 1_000,
  };
  const manager = new VoiceCaptureManager(
    root,
    { info() {}, error() {}, warn() {} } as unknown as Logger,
    options,
    adapters,
  );
  const guild = { id: "guild", voiceAdapterCreator: {}, members: { cache: new Map() } } as unknown as Guild;
  await manager.start(guild, {
    id: "session",
    campaignId: "campaign",
    sequenceNumber: 1,
    voiceChannelId: "voice",
    startedAt: new Date(),
  } as PersistedSession);
  return {
    root,
    manager,
    connection,
    speaking,
    subscriptions,
    recording: () => managerInternals(manager).active.get("guild")!,
    internals: managerInternals(manager),
    startSpeaker(userId = "speaker") {
      speaking.emit("start", userId);
      return subscriptions.get(userId)!;
    },
    directory: join(root, "recordings", "session"),
  };
}

class HeldFinalWavWriter extends WavFileWriter {
  constructor(
    path: string,
    private readonly finalGate: Promise<void>,
    private readonly onFinalizing: () => void,
  ) {
    super(path);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.onFinalizing();
    void this.finalGate.then(
      () => super._final(callback),
      (error: unknown) => callback(error as Error),
    );
  }
}

describe("capture closure barrier", () => {
  it("preserves decoded PCM and continues after one invalid Opus packet", async (test) => {
    const f = await closureFixture(test, {
      decoder: () => new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 }),
    });
    const source = f.startSpeaker();
    source.write(Buffer.from([0xf8, 0xff, 0xfe]));
    source.write(Buffer.from([3]));
    let replacement = f.subscriptions.get("speaker");
    for (let attempt = 0; attempt < 40 && replacement === source; attempt++) {
      await new Promise((done) => setTimeout(done, 10));
      replacement = f.subscriptions.get("speaker");
    }
    assert.notEqual(replacement, source);
    replacement!.write(Buffer.from([0xf8, 0xff, 0xfe]));
    await f.manager.finish("guild");
    const manifest = JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "completed");
    assert.ok(manifest.chunks[0].bytes > 44);
    assert.ok(manifest.chunks[1].bytes > 44);
  });

  it("interrupts when invalid Opus packets continue", async (test) => {
    const f = await closureFixture(test, {
      decoder: () => new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 }),
    });
    for (let failure = 0; failure < 3; failure++) {
      const source = failure === 0 ? f.startSpeaker() : f.subscriptions.get("speaker")!;
      source.write(Buffer.from([3]));
      if (failure < 2) {
        for (let attempt = 0; attempt < 40 && f.subscriptions.get("speaker") === source; attempt++) {
          await new Promise((done) => setTimeout(done, 10));
        }
        assert.notEqual(f.subscriptions.get("speaker"), source);
      }
    }
    await new Promise((done) => setTimeout(done, 50));
    await f.manager.shutdown();
    const manifest = JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "interrupted");
    assert.match(manifest.interruptionReason, /Invalid packet/u);
  });

  it("reports absence or drains only the matching active capture", async (test) => {
    const f = await closureFixture(test);
    assert.equal(await f.manager.cancelIfActive("other-guild", "session"), false);
    f.startSpeaker().write(Buffer.alloc(960, 1));
    assert.equal(await f.manager.cancelIfActive("guild", "session"), true);
    assert.equal(managerInternals(f.manager).active.has("guild"), false);
    await assert.rejects(access(f.directory));
  });

  it("pauses with no writers while keeping the connection available for resume", async (test) => {
    const f = await closureFixture(test);
    f.startSpeaker("before-pause").write(Buffer.alloc(960, 2));
    await f.manager.pause("guild");
    assert.equal(f.connection.state.status, VoiceConnectionStatus.Ready);
    assert.equal(f.recording().closeState, "closed");
    assert.equal(JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8")).status, "paused");
    f.speaking.emit("start", "while-paused");
    assert.equal(f.subscriptions.has("while-paused"), false);

    await f.manager.resume("guild");
    f.startSpeaker("after-resume").write(Buffer.alloc(960, 3));
    await f.manager.finish("guild");
    const manifest = JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.clips.length, 2);
    assert.equal(manifest.chunks.length, 2);
  });

  it("cancels normally only after active WAV writers finish", async (test) => {
    const f = await closureFixture(test);
    const recording = f.recording();
    const source = f.startSpeaker();
    source.write(Buffer.alloc(960, 3));
    await f.manager.cancel("guild", "session");
    await assert.rejects(access(f.directory));
    assert.equal(recording.closeState, "closed");
  });

  it("keeps finish pending until a delayed WAV writer has finalized", async (test) => {
    const release = deferred();
    const finalizing = deferred();
    const f = await closureFixture(test, {
      writer: (path) => new HeldFinalWavWriter(path, release.promise, finalizing.release),
    });
    f.startSpeaker().write(Buffer.alloc(960, 4));
    let completed = false;
    const finishing = f.manager.finish("guild").then(() => { completed = true; });
    await finalizing.promise;
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(completed, false);
    assert.equal(f.recording().closeState, "closing");
    release.release();
    await finishing;
    assert.equal(completed, true);
    assert.equal(JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8")).status, "completed");
  });

  it("waits for an in-flight rotation before finalizing the next clip", async (test) => {
    const release = deferred();
    const finalizing = deferred();
    let writerCount = 0;
    const f = await closureFixture(test, {
      writer: (path) => {
        writerCount += 1;
        return new HeldFinalWavWriter(path, release.promise, finalizing.release);
      },
    });
    f.startSpeaker().write(Buffer.alloc(960, 5));
    const startMs = Date.parse(f.recording().manifest.clips[0]!.startTimestamp);
    test.mock.method(Date, "now", () => startMs + options.maxMs);
    f.internals.scheduleRotation(f.recording());
    await finalizing.promise;
    let completed = false;
    const finishing = f.manager.finish("guild").then(() => { completed = true; });
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(completed, false);
    assert.equal(writerCount, 2);
    release.release();
    await finishing;
    const manifest = JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.clips.length, 2);
    assert.equal(manifest.chunks.length, 2);
  });

  it("times out as uncertain and preserves WAV data and the session directory", async (test) => {
    const release = deferred();
    const finalizing = deferred();
    let wavPath = "";
    const f = await closureFixture(test, {
      writerCloseTimeoutMs: 35,
      writer: (path) => {
        wavPath = path;
        return new HeldFinalWavWriter(path, release.promise, finalizing.release);
      },
    });
    f.startSpeaker().write(Buffer.alloc(960, 6));
    const closing = f.manager.cancel("guild", "session");
    await finalizing.promise;
    await assert.rejects(closing, (error: unknown) =>
      error instanceof CaptureClosureError && error.closureState === "uncertain");
    assert.equal(f.recording().closeState, "uncertain");
    await access(f.directory);
    await access(wavPath);
    const writerFinished = f.recording().chunks.get("speaker")?.finished;
    release.release();
    await writerFinished?.catch(() => undefined);
    await access(wavPath);
  });

  it("continues closing later captures when one writer times out", async (test) => {
    const release = deferred();
    const finalizing = deferred();
    let wavPath = "";
    const f = await closureFixture(test, {
      writerCloseTimeoutMs: 35,
      writer: (path) => {
        wavPath = path;
        return new HeldFinalWavWriter(path, release.promise, finalizing.release);
      },
    });
    f.startSpeaker().write(Buffer.alloc(960, 9));
    await f.manager.start({ id: "guild-two", voiceAdapterCreator: {}, members: { cache: new Map() } } as unknown as Guild, {
      id: "session-two",
      campaignId: "campaign",
      sequenceNumber: 2,
      voiceChannelId: "voice",
      startedAt: new Date(),
    } as PersistedSession);

    const report = await f.manager.shutdown();
    assert.deepEqual(report.closedSessionIds, ["session-two"]);
    assert.deepEqual(report.failedCaptures, []);
    assert.deepEqual(report.uncertainCaptures.map((capture) => capture.sessionId), ["session"]);
    assert.equal(f.recording().closeState, "uncertain");
    await access(f.directory);
    await access(join(f.root, "recordings", "session-two", "manifest.json"));
    assert.equal(JSON.parse(await readFile(join(f.root, "recordings", "session-two", "manifest.json"), "utf8")).status, "interrupted");
    const writerFinished = f.recording().chunks.get("speaker")?.finished;
    release.release();
    await writerFinished?.catch(() => undefined);
    await access(wavPath);
  });

  it("waits for an already queued manifest write before removing the directory", async (test) => {
    const f = await closureFixture(test);
    const pendingWrite = deferred();
    f.recording().manifestWrite = pendingWrite.promise;
    let completed = false;
    const cancelling = f.manager.cancel("guild", "session").then(() => { completed = true; });
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(completed, false);
    await access(join(f.directory, "manifest.json"));
    pendingWrite.release();
    await cancelling;
    await assert.rejects(access(f.directory));
  });

  it("drains active writers during shutdown before writing interrupted status", async (test) => {
    const release = deferred();
    const finalizing = deferred();
    const f = await closureFixture(test, {
      writer: (path) => new HeldFinalWavWriter(path, release.promise, finalizing.release),
    });
    f.startSpeaker().write(Buffer.alloc(960, 7));
    let completed = false;
    const shuttingDown = f.manager.shutdown().then(() => { completed = true; });
    await finalizing.promise;
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(completed, false);
    release.release();
    await shuttingDown;
    assert.equal(JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8")).status, "interrupted");
    assert.equal(managerInternals(f.manager).active.size, 0);
  });

  it("runs shutdown closure while holding the supplied session lock", async (test) => {
    const f = await closureFixture(test);
    const coordinator = new SessionFileCoordinator(join(f.root, "session-locks"));
    let lockHeld = false;
    await f.manager.shutdown((sessionId, action) => coordinator.runExclusive(sessionId, async () => {
      lockHeld = true;
      return action();
    }));
    assert.equal(lockHeld, true);
    assert.equal(managerInternals(f.manager).active.size, 0);
  });

  it("reports a manifest write failure and preserves the session files", async (test) => {
    const f = await closureFixture(test, {
      writeManifest: async () => { throw new Error("manifest disk failure"); },
    });
    const report = await f.manager.shutdown();
    assert.deepEqual(report.closedSessionIds, []);
    assert.deepEqual(report.failedCaptures.map((capture) => capture.sessionId), ["session"]);
    assert.deepEqual(report.uncertainCaptures, []);
    assert.equal(f.recording().closeState, "failed");
    await access(f.directory);
    assert.equal(JSON.parse(await readFile(join(f.directory, "manifest.json"), "utf8")).status, "recording");
  });

  it("rejects new speaker writers, rotations, and manifest writes after closure", async (test) => {
    const release = deferred();
    const finalizing = deferred();
    let writerCount = 0;
    const f = await closureFixture(test, {
      writer: (path) => {
        writerCount += 1;
        return new HeldFinalWavWriter(path, release.promise, finalizing.release);
      },
    });
    f.startSpeaker("first").write(Buffer.alloc(960, 8));
    const finishing = f.manager.finish("guild");
    await finalizing.promise;
    f.speaking.emit("start", "late");
    f.internals.scheduleRotation(f.recording());
    const newWrite = f.internals.queueManifestWrite(f.recording()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.equal(writerCount, 1);
    assert.equal(f.recording().chunks.has("late"), false);
    release.release();
    await finishing;
    assert.ok(await newWrite instanceof CaptureClosureError);
    assert.equal(writerCount, 1);
  });
});
