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
  manifestWrite: Promise<void>;
  rotationTimer: NodeJS.Timeout;
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
      if (!["recording", "paused", "finalizing"].includes(manifest.status)) continue;

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
          });
        }
      }
      const now = new Date().toISOString();
      for (const clip of manifest.clips ?? []) {
        if (clip.transcriptionStatus === "recording") clip.transcriptionStatus = "pending";
        clip.endTimestamp ??= now;
        clip.durationSeconds ??= Math.max(0, (Date.parse(clip.endTimestamp) - Date.parse(clip.startTimestamp)) / 1_000);
      }
      manifest.status = "completed";
      manifest.endedAt = now;
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

    const connection = joinVoiceChannel({
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
      manifestWrite: Promise.resolve(),
      rotationTimer: setInterval(() => void this.maybeRotate(recording), 1_000),
    });
    recording.rotationTimer.unref();
    this.active.set(guild.id, recording);
    connection.receiver.speaking.on("start", (userId) => {
      if (!recording.acceptingAudio || recording.chunks.has(userId)) return;
      const member = guild.members.cache.get(userId);
      if (member?.user.bot === true) return;
      this.logger.info({ userId }, "[Voice] User speaking started");
      try {
        this.startChunk(recording, userId, member?.displayName ?? userId);
      } catch (error) {
        this.logger.error({ error, userId }, "No se pudo iniciar el flujo de audio");
      }
    });
    connection.receiver.speaking.on("end", (userId) => {
      this.logger.info({ userId }, "[Voice] User speaking ended");
    });
    this.logger.info({ sessionId: session.id }, "[Recording] Session started; clip_001 started");
  }

  async pause(discordGuildId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    recording.acceptingAudio = false;
    await this.stopChunks(recording);
    await this.closeCurrentClip(recording);
    recording.manifest.status = "paused";
    await this.queueManifestWrite(recording);
  }

  async resume(discordGuildId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    this.openNextClip(recording, Date.now());
    recording.acceptingAudio = true;
    recording.manifest.status = "recording";
    await this.queueManifestWrite(recording);
  }

  async finish(discordGuildId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    this.logger.info({ sessionId: recording.manifest.sessionId }, "[Session] Finalizing");
    recording.acceptingAudio = false;
    clearInterval(recording.rotationTimer);
    recording.manifest.status = "finalizing";
    recording.manifest.endedAt = new Date().toISOString();
    const finalizingWrite = this.queueManifestWrite(recording);
    // Leave Discord before waiting on decoder/file finalization. A decoder that
    // fails to emit `end` must never leave Dotty visibly connected forever.
    recording.connection.destroy();
    await finalizingWrite;
    await this.stopChunks(recording);
    await this.closeCurrentClip(recording);
    recording.manifest.status = "completed";
    await this.queueManifestWrite(recording);
    this.active.delete(discordGuildId);
  }

  async cancel(discordGuildId: string): Promise<void> {
    const recording = this.requireActive(discordGuildId);
    recording.acceptingAudio = false;
    clearInterval(recording.rotationTimer);
    recording.connection.destroy();
    await this.stopChunks(recording);
    this.active.delete(discordGuildId);
    await fs.rm(recording.directory, { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map(async (guildId) => {
      const recording = this.requireActive(guildId);
      recording.acceptingAudio = false;
      clearInterval(recording.rotationTimer);
      recording.connection.destroy();
      try {
        await this.stopChunks(recording);
      } catch (error) {
        this.logger.error({ error, sessionId: recording.manifest.sessionId }, "Cierre incompleto; se recuperará al iniciar");
      }
      await this.closeCurrentClip(recording);
      recording.manifest.status = "interrupted";
      recording.manifest.endedAt = new Date().toISOString();
      await this.queueManifestWrite(recording);
      this.active.delete(guildId);
    }));
  }

  private startChunk(recording: ActiveRecording, userId: string, speakerName: string): void {
    const clip = recording.currentClip;
    if (clip === null) return;
    const subscription = recording.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1_000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 });
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
        });
        await this.queueManifestWrite(recording);
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
    subscription.on("error", (error) => this.logger.warn({ error, userId }, "Fallo en flujo de voz de Discord"));
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
        resolveFinished();
      }).catch((error) => {
        this.logger.error({ error, userId }, "No se pudo cerrar un fragmento de audio");
        rejectFinished(error);
      }).finally(() => {
        recording.chunks.delete(userId);
        void this.maybeRotate(recording);
      });
    };
    decoder.once("end", closeChunk);
    decoder.once("finish", closeChunk);
    decoder.once("close", closeChunk);
    decoder.on("error", (error) => {
      this.logger.warn({ error, userId }, "Fallo al decodificar audio Opus");
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
    return {
      id,
      clipIndex: clip.clipIndex,
      filePath,
      startedOffsetMs,
      overlapMs,
      writer: new WavFileWriter(filePath),
      endedOffsetMs: startedOffsetMs,
    };
  }

  private async maybeRotate(recording: ActiveRecording): Promise<void> {
    const clip = recording.currentClip;
    if (!recording.acceptingAudio || clip === null || recording.rotationInProgress) return;
    const elapsed = Date.now() - Date.parse(clip.startTimestamp);
    const decision = clipRotationDecision(elapsed, recording.chunks.size, this.rotation);
    if (decision === "none") return;
    if (decision === "silence") this.logger.info({ clipIndex: clip.clipIndex }, "[Recording] silence detected near rotation threshold");
    await this.rotate(recording, decision === "forced" ? "maximum duration" : "silence");
  }

  private async rotate(recording: ActiveRecording, reason: string): Promise<void> {
    const oldClip = recording.currentClip;
    if (oldClip === null || recording.rotationInProgress) return;
    recording.rotationInProgress = true;
    const boundaryMs = Date.now();
    const boundaryOffsetMs = this.sessionOffset(recording, boundaryMs);
    const nextClip = this.openNextClip(recording, boundaryMs);
    try {
      await Promise.all([...recording.chunks.values()].map((chunk) => chunk.rotate(nextClip, boundaryOffsetMs)));
      closeClip(oldClip, boundaryMs);
      await this.queueManifestWrite(recording);
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

  private async closeCurrentClip(recording: ActiveRecording): Promise<void> {
    if (recording.currentClip === null) return;
    closeClip(recording.currentClip, Date.now());
    recording.currentClip = null;
    await this.queueManifestWrite(recording);
  }

  private async stopChunks(recording: ActiveRecording): Promise<void> {
    const chunks = [...recording.chunks.values()];
    for (const chunk of chunks) chunk.stop();
    if (chunks.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(chunks.map((chunk) => chunk.finished)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("La finalización de los fragmentos de audio superó 30 segundos.")),
            CHUNK_FINALIZATION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private sessionOffset(recording: ActiveRecording, now = Date.now()): number {
    return Math.max(0, now - Date.parse(recording.manifest.startedAt));
  }

  private queueManifestWrite(recording: ActiveRecording): Promise<void> {
    const snapshot = structuredClone(recording.manifest);
    recording.manifestWrite = recording.manifestWrite.catch(() => undefined).then(() =>
      writeJsonAtomically(recording.manifestPath, snapshot),
    );
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
