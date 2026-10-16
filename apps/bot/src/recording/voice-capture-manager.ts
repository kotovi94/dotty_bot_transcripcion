import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, promises as fs } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";

import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Guild } from "discord.js";
import prism from "prism-media";
import type { Logger } from "pino";

import type { PersistedSession } from "../sessions/session-repository.ts";
import { writeJsonAtomically } from "./atomic-json-file.ts";
import { createWavHeader, WavFileWriter } from "./wav-writer.ts";

export interface RecordingClip {
  readonly clipIndex: number;
  readonly sessionStartOffsetMs: number;
  readonly startTimestamp: string;
  endTimestamp: string | null;
  durationSeconds: number | null;
  readonly audioDirectory: string;
  transcriptionStatus: "recording" | "pending" | "processing" | "completed" | "failed";
}

export interface AudioChunkManifest {
  readonly id: string;
  readonly clipIndex: number;
  readonly speakerUserId: string;
  readonly speakerName: string;
  readonly file: string;
  readonly startedOffsetMs: number;
  readonly endedOffsetMs: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly overlapMs: number;
  readonly pcmDurationMs?: number;
  readonly timingSource?: "receive_clock" | "file_birthtime_estimate";
}

export interface RecordingManifest {
  readonly version: 2;
  readonly sessionId: string;
  readonly campaignId: string;
  readonly sequenceNumber: number;
  readonly discordGuildId: string;
  readonly voiceChannelId: string;
  readonly logChannelId?: string | null;
  readonly campaignName?: string;
  readonly startedAt: string;
  status: "recording" | "paused" | "finalizing" | "completed" | "interrupted";
  endedAt: string | null;
  interruptionReason?: string;
  recoveredAt?: string;
  clips: RecordingClip[];
  chunks: AudioChunkManifest[];
  publication?: {
    readonly channelId: string;
    readonly threadId?: string;
    readonly starterMessageId?: string;
    readonly messageIds: readonly string[];
  };
}

export interface ClipRotationOptions {
  readonly targetMs: number;
  readonly searchStartMs: number;
  readonly maxMs: number;
  readonly overlapMs: number;
}

interface ActiveChunk {
  stop(): void;
  rotate(clip: RecordingClip, boundaryOffsetMs: number): Promise<void>;
  readonly finished: Promise<void>;
}

interface ActiveRecording {
  readonly connection: VoiceConnection;
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifest: RecordingManifest;
  readonly chunks: Map<string, ActiveChunk>;
  acceptingAudio: boolean;
  currentClip: RecordingClip | null;
  rotationInProgress: boolean;
  closeState: CaptureClosureState;
  closeMode: CaptureCloseMode | undefined;
  closeTask: Promise<void> | undefined;
  closeError: CaptureClosureError | undefined;
  rotationTask: Promise<void> | undefined;
  manifestWrite: Promise<void>;
  manifestWriteFailure?: unknown;
  rotationTimer: NodeJS.Timeout;
  failure?: Error;
  interruption?: Promise<void>;
}

type CaptureClosureState = "open" | "closing" | "closed" | "failed" | "uncertain";
type CaptureCloseMode = "pause" | "finish" | "cancel" | "shutdown" | "interrupt";

export class CaptureClosureError extends Error {
  constructor(
    readonly closureState: "failed" | "uncertain",
    readonly sessionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Capture ${sessionId} closure ${closureState}: ${message}`, options);
    this.name = "CaptureClosureError";
  }
}

export interface CaptureShutdownIssue {
  readonly sessionId: string;
  readonly message: string;
}

export interface CaptureShutdownReport {
  readonly closedSessionIds: readonly string[];
  readonly failedCaptures: readonly CaptureShutdownIssue[];
  readonly uncertainCaptures: readonly CaptureShutdownIssue[];
}

interface SegmentWriter {
  readonly id: string;
  readonly clipIndex: number;
  readonly filePath: string;
  readonly startedOffsetMs: number;
  readonly overlapMs: number;
  readonly writer: WavFileWriter;
  endedOffsetMs: number;
}

const PCM_BYTES_PER_MS = 48_000 * 2 / 1_000;
const CHUNK_FINALIZATION_TIMEOUT_MS = 30_000;

export class VoiceCaptureManager {
  private readonly active = new Map<string, ActiveRecording>();
  private readonly recordingsRoot: string;

  constructor(
    dataDirectory: string,
    private readonly logger: Logger,
    private readonly rotation: ClipRotationOptions = {
      targetMs: 60 * 60_000,
      searchStartMs: 55 * 60_000,
      maxMs: 65 * 60_000,
      overlapMs: 1_500,
    },
    private readonly adapters: {
      connect?: typeof joinVoiceChannel;
      decoder?: () => prism.opus.Decoder;
      writer?: (path: string) => WavFileWriter;
      writerCloseTimeoutMs?: number;
      writeManifest?: typeof writeJsonAtomically;
    } = {},
  ) {
    if (!(rotation.searchStartMs <= rotation.targetMs && rotation.targetMs <= rotation.maxMs)) {
      throw new Error("Recording clip thresholds must satisfy searchStart <= target <= max.");
    }
    this.recordingsRoot = resolve(dataDirectory, "recordings");
    mkdirSync(this.recordingsRoot, { recursive: true });
    assertOpusDecoderAvailable();
  }

  async recoverInterrupted(): Promise<readonly string[]> {
    const entries = await fs.readdir(this.recordingsRoot, { withFileTypes: true });
    const recovered: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.recordingsRoot, entry.name);
      const manifestPath = join(directory, "manifest.json");
      let manifest: RecordingManifest;
      try {
        manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RecordingManifest;
      } catch {
        continue;
      }
      if (!["recording", "paused", "finalizing", "interrupted"].includes(manifest.status)) continue;

      for (const filePath of await findWavFiles(directory)) {
        const stats = await fs.stat(filePath);
        const dataBytes = Math.max(0, stats.size - 44);
        const expectedHeader = createWavHeader(dataBytes);
        const handle = await fs.open(filePath, "r+");
        try {
          const currentHeader = Buffer.alloc(44);
          const { bytesRead } = await handle.read(currentHeader, 0, 44, 0);
          if (bytesRead !== 44 || !currentHeader.equals(expectedHeader)) {
            await handle.write(expectedHeader, 0, 44, 0);
            await handle.sync();
          }
        } finally {
          await handle.close();
        }
        const file = relative(directory, filePath);
        if (!manifest.chunks.some((chunk) => chunk.file === file)) {
          const clipMatch = file.match(/clip_(\d+)/u);
          const speakerUserId = file.split(/[\\/]/u).at(-1)?.split("-")[0] ?? "unknown";
          const durationMs = Math.round(dataBytes / PCM_BYTES_PER_MS);
          const recoveredOffsets = inferRecoveredChunkOffsets(
            manifest.startedAt,
            stats.birthtimeMs,
            durationMs,
          );
          manifest.chunks.push({
            id: `recovered-${randomUUID()}`,
            clipIndex: Number(clipMatch?.[1] ?? 1),
            speakerUserId,
            speakerName: speakerUserId,
            file,
            startedOffsetMs: recoveredOffsets.startedOffsetMs,
            endedOffsetMs: recoveredOffsets.endedOffsetMs,
            bytes: stats.size,
            sha256: await hashFile(filePath),
            overlapMs: 0,
            pcmDurationMs: durationMs,
            timingSource: "file_birthtime_estimate",
          });
        }
      }
      const now = new Date().toISOString();
      const endedAt = manifest.endedAt ?? now;
      for (const clip of manifest.clips ?? []) {
        if (clip.transcriptionStatus === "recording") clip.transcriptionStatus = "pending";
        clip.endTimestamp ??= endedAt;
        clip.durationSeconds ??= Math.max(0, (Date.parse(clip.endTimestamp) - Date.parse(clip.startTimestamp)) / 1_000);
      }
      manifest.status = "completed";
      manifest.endedAt = endedAt;
      manifest.interruptionReason ??= "Recording interrupted before normal finalization";
      manifest.recoveredAt = now;
      await writeJsonAtomically(manifestPath, manifest);
      recovered.push(manifest.sessionId);
    }
    return recovered;
  }

  async start(guild: Guild, session: PersistedSession): Promise<void> {
    if (session.voiceChannelId === null) throw new Error("The session has no voice channel.");
    if (this.active.has(guild.id)) throw new Error("A voice capture is already active for this server.");

    const directory = join(this.recordingsRoot, session.id);
    mkdirSync(join(directory, "audio"), { recursive: true });
    mkdirSync(join(directory, "transcripts"), { recursive: true });
    const manifestPath = join(directory, "manifest.json");
    const startedAt = (session.startedAt ?? new Date()).toISOString();
    const firstClip = createClip(1, 0, startedAt);
    mkdirSync(join(directory, firstClip.audioDirectory), { recursive: true });
    const manifest: RecordingManifest = {
      version: 2,
      sessionId: session.id,
      campaignId: session.campaignId,
      sequenceNumber: session.sequenceNumber,
      discordGuildId: guild.id,
      voiceChannelId: session.voiceChannelId,
      logChannelId: session.logChannelId,
      campaignName: session.campaignName,
      startedAt,
      status: "recording",
      endedAt: null,
      clips: [firstClip],
      chunks: [],
    };
    await writeJsonAtomically(manifestPath, manifest);

    const connection = (this.adapters.connect ?? joinVoiceChannel)({
      channelId: session.voiceChannelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      connection.destroy();
      manifest.status = "interrupted";
      manifest.endedAt = new Date().toISOString();
      await writeJsonAtomically(manifestPath, manifest);
      throw error;
    }

    const recording = {} as ActiveRecording;
    Object.assign(recording, {
      connection,
      directory,
      manifestPath,
      manifest,
      chunks: new Map<string, ActiveChunk>(),
      acceptingAudio: true,
      currentClip: firstClip,
      rotationInProgress: false,
      closeState: "open",
      closeMode: undefined,
      closeTask: undefined,
      closeError: undefined,
      rotationTask: undefined,
      manifestWrite: Promise.resolve(),
      rotationTimer: setInterval(() => this.scheduleRotation(recording), 1_000),
    });
    recording.rotationTimer.unref();
    this.active.set(guild.id, recording);
    connection.on("error", (error) => this.interrupt(recording, error));
    connection.on("stateChange", (_previous, next) => {
      if (recording.closeState !== "open") return;
      if (next.status === VoiceConnectionStatus.Disconnected || next.status === VoiceConnectionStatus.Destroyed) {
        // Stop conservatively: automatic reconnection cannot restore missing audio.
        this.interrupt(recording, new Error(`Voice connection ${next.status}; recording interrupted`));
      }
    });
    connection.receiver.speaking.on("start", (userId) => {
      if (!recording.acceptingAudio || recording.chunks.has(userId)) return;
      const member = guild.members.cache.get(userId);
      if (member?.user.bot === true) return;
      this.logger.info({ userId }, "[Voice] User speaking started");
      try {
        this.startChunk(recording, userId, member?.displayName ?? userId);
      } catch (error) {
        this.logger.error({ error, userId }, "No se pudo iniciar el flujo de audio");
        this.interrupt(recording, error);
      }
    });
    connection.receiver.speaking.on("end", (userId) => {
      this.logger.info({ userId }, "[Voice] User speaking ended");
    });
    this.logger.info({ sessionId: session.id }, "[Recording] Session started; clip_001 started");
  }

  async pause(discordGuildId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    if (recording.failure) throw recording.failure;
    await this.closeCapture(recording, "pause");
    if (recording.failure) throw recording.failure;
  }

  async resume(discordGuildId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    if (recording.failure) throw recording.failure;
    if (recording.closeState !== "closed" || recording.closeMode !== "pause") {
      throw new CaptureClosureError("failed", recording.manifest.sessionId, "capture is not safely paused");
    }
    recording.closeState = "open";
    recording.closeMode = undefined;
    recording.closeTask = undefined;
    recording.closeError = undefined;
    recording.acceptingAudio = false;
    this.openNextClip(recording, Date.now());
    recording.manifest.status = "recording";
    try {
      await this.queueManifestWrite(recording);
    } catch (error) {
      throw this.failClosure(recording, error, "manifest write failed while resuming");
    }
    recording.rotationTimer = setInterval(() => this.scheduleRotation(recording), 1_000);
    recording.rotationTimer.unref();
    recording.acceptingAudio = true;
  }

  async finish(discordGuildId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    await this.closeCapture(recording, "finish");
    this.active.delete(discordGuildId);
    if (recording.failure) throw recording.failure;
  }

  async cancel(discordGuildId: string, sessionId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    if (recording.manifest.sessionId !== sessionId ||
      resolve(recording.directory) !== join(this.recordingsRoot, sessionId)) {
      throw new Error("Active voice capture does not match the requested session.");
    }
    await this.closeCapture(recording, "cancel");
    this.active.delete(discordGuildId);
    await fs.rm(recording.directory, { recursive: true, force: true });
  }

  async cancelIfActive(discordGuildId: string, sessionId: string): Promise<boolean> {
    if (!this.active.has(discordGuildId)) return false;
    await this.cancel(discordGuildId, sessionId);
    return true;
  }

  assertTransitionAllowed(
    discordGuildId: string,
    sessionId: string,
    transition: "pause" | "resume" | "finish",
  ): void {
    const recording = this.active.get(discordGuildId);
    if (recording === undefined || recording.manifest.sessionId !== sessionId) {
      throw new CaptureClosureError("uncertain", sessionId, "no matching active capture is available");
    }
    if (recording.closeState === "failed" || recording.closeState === "uncertain" || recording.closeState === "closing") {
      throw recording.closeError ?? new CaptureClosureError(
        recording.closeState === "uncertain" ? "uncertain" : "failed",
        sessionId,
        `cannot ${transition} while capture closure is ${recording.closeState}`,
      );
    }
    if (recording.failure !== undefined) throw recording.failure;
    const safelyPaused = recording.closeState === "closed" && recording.closeMode === "pause";
    if (
      (transition === "pause" && recording.closeState !== "open" && !safelyPaused) ||
      (transition === "resume" && !safelyPaused) ||
      (transition === "finish" && recording.closeState !== "open" && !safelyPaused)
    ) {
      throw new CaptureClosureError("failed", sessionId, `capture state does not allow ${transition}`);
    }
  }

  async shutdown(
    runExclusive?: <T>(sessionId: string, action: () => Promise<T>) => Promise<T>,
  ): Promise<CaptureShutdownReport> {
    const entries = [...this.active.entries()]
      .sort((left, right) => left[1].manifest.sessionId < right[1].manifest.sessionId ? -1 : 1);
    const closedSessionIds: string[] = [];
    const failedCaptures: CaptureShutdownIssue[] = [];
    const uncertainCaptures: CaptureShutdownIssue[] = [];
    for (const [guildId, recording] of entries) {
      const close = async () => {
        if (this.active.get(guildId) !== recording) return;
        await this.closeCapture(recording, "shutdown");
        if (this.active.get(guildId) === recording) this.active.delete(guildId);
      };
      try {
        if (runExclusive === undefined) await close();
        else await runExclusive(recording.manifest.sessionId, close);
        closedSessionIds.push(recording.manifest.sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof CaptureClosureError && error.closureState === "failed") {
          failedCaptures.push({ sessionId: recording.manifest.sessionId, message });
        } else {
          this.markUncertain(recording, error);
          uncertainCaptures.push({ sessionId: recording.manifest.sessionId, message });
        }
      }
    }
    return { closedSessionIds, failedCaptures, uncertainCaptures };
  }

  private markUncertain(recording: ActiveRecording, cause: unknown): void {
    if (recording.closeState === "failed" || recording.closeState === "uncertain") return;
    const error = new CaptureClosureError(
      "uncertain",
      recording.manifest.sessionId,
      "shutdown could not verify exclusive closure; audio was preserved",
      { cause },
    );
    recording.closeState = "uncertain";
    recording.closeError = error;
    recording.acceptingAudio = false;
    clearInterval(recording.rotationTimer);
  }

  private startChunk(recording: ActiveRecording, userId: string, speakerName: string): void {
    if (recording.closeState !== "open" || !recording.acceptingAudio) return;
    const clip = recording.currentClip;
    if (clip === null) return;
    const subscription = recording.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 },
    });
    const decoder = this.adapters.decoder?.() ?? new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 });
    const pending: Promise<void>[] = [];
    const tail: Buffer[] = [];
    let tailBytes = 0;
    let current = this.createSegment(recording, clip, userId, this.sessionOffset(recording), 0);

    const finalize = (segment: SegmentWriter): Promise<void> => {
      segment.writer.end();
      const work = finished(segment.writer).then(async () => {
        const stats = await fs.stat(segment.filePath);
        recording.manifest.chunks.push({
          id: segment.id,
          clipIndex: segment.clipIndex,
          speakerUserId: userId,
          speakerName,
          file: relative(recording.directory, segment.filePath),
          startedOffsetMs: segment.startedOffsetMs,
          endedOffsetMs: segment.endedOffsetMs,
          bytes: stats.size,
          sha256: await hashFile(segment.filePath),
          overlapMs: segment.overlapMs,
          pcmDurationMs: Math.round(Math.max(0, stats.size - 44) / PCM_BYTES_PER_MS),
          timingSource: "receive_clock",
        });
        await this.queueManifestWrite(recording, true);
      });
      pending.push(work);
      return work;
    };

    decoder.on("data", (data: Buffer) => {
      current.writer.write(data);
      current.endedOffsetMs = this.sessionOffset(recording);
      if (this.rotation.overlapMs > 0) {
        const copy = Buffer.from(data);
        tail.push(copy);
        tailBytes += copy.length;
        const maximum = Math.ceil(this.rotation.overlapMs * PCM_BYTES_PER_MS);
        while (tailBytes > maximum && tail.length > 0) tailBytes -= tail.shift()?.length ?? 0;
      }
    });
    subscription.on("error", (error) => this.interrupt(recording, error));
    subscription.pipe(decoder);

    let resolveFinished!: () => void;
    let rejectFinished!: (error: unknown) => void;
    const chunkFinished = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveFinished = resolvePromise;
      rejectFinished = rejectPromise;
    });
    // A decoder can fail long before pause/finish starts awaiting this promise.
    // Attach a handler immediately while preserving rejection for Promise.all.
    void chunkFinished.catch(() => undefined);
    let closing = false;
    const closeChunk = (): void => {
      if (closing) return;
      closing = true;
      current.endedOffsetMs = this.sessionOffset(recording);
      void finalize(current).then(() => Promise.all(pending)).then(() => {
        recording.chunks.delete(userId);
        this.scheduleRotation(recording);
        resolveFinished();
      }).catch((error) => {
        this.logger.error({ error, userId }, "No se pudo cerrar un fragmento de audio");
        recording.chunks.delete(userId);
        this.scheduleRotation(recording);
        rejectFinished(error);
      });
    };
    decoder.once("end", closeChunk);
    decoder.once("finish", closeChunk);
    decoder.once("close", closeChunk);
    decoder.on("error", (error) => {
      this.logger.warn({ error, userId }, "Fallo al decodificar audio Opus");
      this.interrupt(recording, error);
      closeChunk();
    });

    const chunk: ActiveChunk = {
      stop: () => {
        subscription.unpipe(decoder);
        subscription.destroy();
        decoder.end();
      },
      rotate: (nextClip, boundaryOffsetMs) => {
        const previous = current;
        const overlapBytes = Buffer.concat(tail);
        const actualOverlapMs = Math.round(overlapBytes.length / PCM_BYTES_PER_MS);
        current = this.createSegment(
          recording,
          nextClip,
          userId,
          Math.max(previous.startedOffsetMs, boundaryOffsetMs - actualOverlapMs),
          actualOverlapMs,
        );
        if (overlapBytes.length > 0) current.writer.write(overlapBytes);
        current.endedOffsetMs = boundaryOffsetMs;
        return finalize(previous);
      },
      finished: chunkFinished,
    };
    recording.chunks.set(userId, chunk);
  }

  private createSegment(
    recording: ActiveRecording,
    clip: RecordingClip,
    userId: string,
    startedOffsetMs: number,
    overlapMs: number,
  ): SegmentWriter {
    const id = randomUUID();
    const directory = join(recording.directory, clip.audioDirectory);
    mkdirSync(directory, { recursive: true });
    const filePath = join(directory, `${userId}-${id}.wav`);
    const writer = this.adapters.writer?.(filePath) ?? new WavFileWriter(filePath);
    writer.on("error", (error) => this.interrupt(recording, error));
    return {
      id,
      clipIndex: clip.clipIndex,
      filePath,
      startedOffsetMs,
      overlapMs,
      writer,
      endedOffsetMs: startedOffsetMs,
    };
  }

  private async maybeRotate(recording: ActiveRecording): Promise<void> {
    const clip = recording.currentClip;
    if (recording.closeState !== "open" || !recording.acceptingAudio || clip === null || recording.rotationInProgress) return;
    const elapsed = Date.now() - Date.parse(clip.startTimestamp);
    const decision = clipRotationDecision(elapsed, recording.chunks.size, this.rotation);
    if (decision === "none") return;
    if (decision === "silence") this.logger.info({ clipIndex: clip.clipIndex }, "[Recording] silence detected near rotation threshold");
    await this.rotate(recording, decision === "forced" ? "maximum duration" : "silence");
  }

  private scheduleRotation(recording: ActiveRecording): void {
    if (recording.closeState !== "open" || recording.rotationTask !== undefined) return;
    const rotation = this.maybeRotate(recording);
    recording.rotationTask = rotation;
    void rotation.catch((error) => this.interrupt(recording, error)).finally(() => {
      if (recording.rotationTask === rotation) recording.rotationTask = undefined;
    });
  }

  private interrupt(recording: ActiveRecording, cause: unknown): void {
    if (recording.closeState === "closing") {
      recording.failure ??= cause instanceof Error ? cause : new Error(String(cause));
      return;
    }
    if (recording.closeState !== "open" || recording.failure) return;
    recording.failure = cause instanceof Error ? cause : new Error(String(cause));
    recording.acceptingAudio = false;
    recording.manifest.status = "interrupted";
    recording.manifest.endedAt = new Date().toISOString();
    recording.manifest.interruptionReason = recording.failure.message;
    this.logger.error({ error: recording.failure, sessionId: recording.manifest.sessionId }, "Captura interrumpida; se conserva el audio para recuperación");
    recording.interruption = this.closeCapture(recording, "interrupt");
    void recording.interruption.catch((error) => this.logger.error({ error }, "No se pudo persistir la interrupción de captura"));
  }

  private async rotate(recording: ActiveRecording, reason: string): Promise<void> {
    if (recording.closeState !== "open" || !recording.acceptingAudio) return;
    const oldClip = recording.currentClip;
    if (oldClip === null || recording.rotationInProgress) return;
    recording.rotationInProgress = true;
    const boundaryMs = Date.now();
    const boundaryOffsetMs = this.sessionOffset(recording, boundaryMs);
    const nextClip = this.openNextClip(recording, boundaryMs);
    try {
      await Promise.all([...recording.chunks.values()].map((chunk) => chunk.rotate(nextClip, boundaryOffsetMs)));
      closeClip(oldClip, boundaryMs);
      await this.queueManifestWrite(recording, true);
      this.logger.info(
        { clipIndex: oldClip.clipIndex, durationSeconds: oldClip.durationSeconds, reason },
        `[Recording] clip_${String(oldClip.clipIndex).padStart(3, "0")} closed; clip_${String(nextClip.clipIndex).padStart(3, "0")} started`,
      );
    } finally {
      recording.rotationInProgress = false;
    }
  }

  private openNextClip(recording: ActiveRecording, timestampMs: number): RecordingClip {
    const clip = createClip(
      (recording.manifest.clips.at(-1)?.clipIndex ?? 0) + 1,
      this.sessionOffset(recording, timestampMs),
      new Date(timestampMs).toISOString(),
    );
    mkdirSync(join(recording.directory, clip.audioDirectory), { recursive: true });
    recording.manifest.clips.push(clip);
    recording.currentClip = clip;
    return clip;
  }

  private closeCurrentClip(recording: ActiveRecording): void {
    if (recording.currentClip === null) return;
    closeClip(recording.currentClip, Date.now());
    recording.currentClip = null;
    void this.queueManifestWrite(recording, true).catch(() => undefined);
  }

  private async stopChunks(recording: ActiveRecording, deadline: number): Promise<void> {
    const chunks = [...recording.chunks.values()];
    const failures: unknown[] = [];
    for (const chunk of chunks) {
      try {
        chunk.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    const results = await this.waitForClosure(
      recording,
      Promise.allSettled(chunks.map((chunk) => chunk.finished)),
      deadline,
      "WAV writers",
    );
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    if (recording.chunks.size !== 0) {
      throw new CaptureClosureError("uncertain", recording.manifest.sessionId, "WAV writers did not leave the active set");
    }
    if (failures.length > 0) throw new AggregateError(failures, "One or more WAV writers failed to close cleanly.");
  }

  private async closeCapture(recording: ActiveRecording, mode: CaptureCloseMode): Promise<void> {
    if (recording.closeState === "closing" && recording.closeTask !== undefined) {
      await recording.closeTask;
      return this.closeCapture(recording, mode);
    }
    if (recording.closeState === "failed" || recording.closeState === "uncertain") {
      throw recording.closeError ?? new CaptureClosureError(
        recording.closeState,
        recording.manifest.sessionId,
        "a previous closure attempt did not confirm completion",
      );
    }
    if (recording.closeState === "closed") {
      if (recording.closeMode === "pause" && (mode === "finish" || mode === "shutdown")) {
        recording.closeState = "open";
        recording.closeMode = undefined;
        recording.closeTask = undefined;
      } else if (
        mode === "cancel" || mode === "shutdown" || mode === recording.closeMode ||
        (recording.closeMode === "interrupt" && mode === "finish")
      ) {
        return;
      } else {
        throw new CaptureClosureError("failed", recording.manifest.sessionId, `capture already closed as ${recording.closeMode}`);
      }
    }

    recording.closeState = "closing";
    recording.closeMode = mode;
    recording.acceptingAudio = false;
    clearInterval(recording.rotationTimer);
    const task = this.performClosure(recording, mode);
    recording.closeTask = task;
    try {
      await task;
      recording.closeState = "closed";
    } catch (error) {
      const closureError = error instanceof CaptureClosureError
        ? error
        : new CaptureClosureError("failed", recording.manifest.sessionId, "closure work failed", { cause: error });
      recording.closeState = closureError.closureState;
      recording.closeError = closureError;
      throw closureError;
    }
  }

  private async performClosure(recording: ActiveRecording, mode: CaptureCloseMode): Promise<void> {
    const timeoutMs = this.adapters.writerCloseTimeoutMs ?? CHUNK_FINALIZATION_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new CaptureClosureError("failed", recording.manifest.sessionId, "invalid writer close timeout");
    }
    const deadline = Date.now() + timeoutMs;
    if (mode === "finish" || mode === "shutdown") {
      recording.manifest.status = "finalizing";
      recording.manifest.endedAt = new Date().toISOString();
      void this.queueManifestWrite(recording, true).catch(() => undefined);
    } else if (mode === "interrupt") {
      recording.manifest.status = "interrupted";
      recording.manifest.endedAt ??= new Date().toISOString();
      recording.manifest.interruptionReason ??= recording.failure?.message ?? "Capture interrupted";
    }

    if (mode !== "pause" && recording.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      recording.connection.destroy();
    }

    const failures: unknown[] = [];
    const rotation = recording.rotationTask;
    if (rotation !== undefined) {
      try {
        await this.waitForClosure(recording, rotation, deadline, "clip rotation");
      } catch (error) {
        if (error instanceof CaptureClosureError && error.closureState === "uncertain") throw error;
        failures.push(error);
      } finally {
        if (recording.rotationTask === rotation && !recording.rotationInProgress) {
          recording.rotationTask = undefined;
        }
      }
    }
    try {
      await this.stopChunks(recording, deadline);
    } catch (error) {
      if (error instanceof CaptureClosureError && error.closureState === "uncertain") throw error;
      failures.push(error);
    }
    try {
      await this.waitForClosure(recording, recording.manifestWrite, deadline, "manifest writes");
    } catch (error) {
      if (error instanceof CaptureClosureError && error.closureState === "uncertain") throw error;
      failures.push(error);
    }
    if (recording.manifestWriteFailure !== undefined) failures.push(recording.manifestWriteFailure);
    if (failures.length > 0) {
      throw new CaptureClosureError(
        "failed",
        recording.manifest.sessionId,
        "one or more writers, rotations, or manifest writes failed",
        { cause: new AggregateError(failures) },
      );
    }

    if (mode === "cancel") return;
    this.closeCurrentClip(recording);
    if (mode === "pause" && recording.failure === undefined) {
      recording.manifest.status = "paused";
    } else if (mode === "finish" && recording.failure === undefined) {
      recording.manifest.status = "completed";
    } else {
      recording.manifest.status = "interrupted";
      recording.manifest.endedAt ??= new Date().toISOString();
      if (recording.failure !== undefined) recording.manifest.interruptionReason = recording.failure.message;
    }
    void this.queueManifestWrite(recording, true).catch(() => undefined);
    await this.waitForClosure(recording, recording.manifestWrite, deadline, "final manifest write");
    if (recording.manifestWriteFailure !== undefined) {
      throw new CaptureClosureError("failed", recording.manifest.sessionId, "manifest write failed", {
        cause: recording.manifestWriteFailure,
      });
    }
    if (recording.chunks.size !== 0 || recording.rotationTask !== undefined) {
      throw new CaptureClosureError("uncertain", recording.manifest.sessionId, "capture tasks remained active after closure");
    }
  }

  private async waitForClosure<T>(
    recording: ActiveRecording,
    task: Promise<T>,
    deadline: number,
    description: string,
  ): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CaptureClosureError("uncertain", recording.manifest.sessionId, `timed out waiting for ${description}`);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new CaptureClosureError(
            "uncertain",
            recording.manifest.sessionId,
            `timed out waiting for ${description}`,
          )), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private failClosure(recording: ActiveRecording, cause: unknown, message: string): CaptureClosureError {
    const error = cause instanceof CaptureClosureError
      ? cause
      : new CaptureClosureError("failed", recording.manifest.sessionId, message, { cause });
    recording.closeState = error.closureState;
    recording.closeError = error;
    recording.acceptingAudio = false;
    clearInterval(recording.rotationTimer);
    return error;
  }

  private sessionOffset(recording: ActiveRecording, now = Date.now()): number {
    return Math.max(0, now - Date.parse(recording.manifest.startedAt));
  }

  private queueManifestWrite(recording: ActiveRecording, closeWork = false): Promise<void> {
    if (recording.closeState === "closing" && !closeWork) {
      return Promise.reject(new CaptureClosureError(
        "failed",
        recording.manifest.sessionId,
        "new manifest writes are rejected while capture is closing",
      ));
    }
    if (recording.closeState === "closed" || recording.closeState === "failed" || recording.closeState === "uncertain") {
      return Promise.reject(recording.closeError ?? new CaptureClosureError(
        recording.closeState === "closed" ? "failed" : recording.closeState,
        recording.manifest.sessionId,
        "manifest writes are not accepted after capture closure",
      ));
    }
    const snapshot = structuredClone(recording.manifest);
    recording.manifestWrite = recording.manifestWrite.catch(() => undefined).then(() =>
      (this.adapters.writeManifest ?? writeJsonAtomically)(recording.manifestPath, snapshot),
    );
    void recording.manifestWrite.catch((error) => { recording.manifestWriteFailure ??= error; });
    return recording.manifestWrite;
  }

  private requireActive(discordGuildId: string): ActiveRecording {
    const recording = this.active.get(discordGuildId);
    if (recording === undefined) throw new Error("No active voice capture exists for this server.");
    return recording;
  }
}

export function clipRotationDecision(
  elapsedMs: number,
  activeSpeakers: number,
  options: ClipRotationOptions,
): "none" | "silence" | "forced" {
  if (elapsedMs >= options.maxMs) return "forced";
  if (elapsedMs >= options.searchStartMs && activeSpeakers === 0) return "silence";
  return "none";
}

export function inferRecoveredChunkOffsets(
  sessionStartedAt: string,
  fileBirthtimeMs: number,
  durationMs: number,
): { startedOffsetMs: number; endedOffsetMs: number } {
  const sessionStartMs = Date.parse(sessionStartedAt);
  const validBirthtime = Number.isFinite(fileBirthtimeMs) && fileBirthtimeMs >= sessionStartMs;
  const startedOffsetMs = validBirthtime
    ? Math.max(0, Math.round(fileBirthtimeMs - sessionStartMs))
    : 0;
  return {
    startedOffsetMs,
    endedOffsetMs: startedOffsetMs + Math.max(0, Math.round(durationMs)),
  };
}

function createClip(index: number, offsetMs: number, timestamp: string): RecordingClip {
  return {
    clipIndex: index,
    sessionStartOffsetMs: offsetMs,
    startTimestamp: timestamp,
    endTimestamp: null,
    durationSeconds: null,
    audioDirectory: `audio/clip_${String(index).padStart(3, "0")}`,
    transcriptionStatus: "recording",
  };
}

function closeClip(clip: RecordingClip, endedMs: number): void {
  clip.endTimestamp = new Date(endedMs).toISOString();
  clip.durationSeconds = Math.max(0, (endedMs - Date.parse(clip.startTimestamp)) / 1_000);
  clip.transcriptionStatus = "pending";
}

async function findWavFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await findWavFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".wav")) result.push(path);
  }
  return result;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function assertOpusDecoderAvailable(): void {
  try {
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 });
    decoder.destroy();
  } catch (error) {
    throw new Error("Dotty cannot decode Discord audio because no Opus decoder is available.", { cause: error });
  }
}
