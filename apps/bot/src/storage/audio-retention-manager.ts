import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { RecordingManifest } from "../recording/voice-capture-manager.ts";

export interface CampaignStorageReport {
  readonly audioBytes: number;
  readonly exportBytes: number;
  readonly sessionsWithAudio: number;
  readonly sessionsWithoutAudio: number;
  readonly retentionDays: number | null;
  readonly eligibleForCleanup: number;
}

export class AudioRetentionManager {
  private timer: NodeJS.Timeout | null = null;
  private cleaning = false;

  constructor(
    private readonly campaigns: CampaignService,
    private readonly recordingsRoot: string,
    private readonly exportsRoot: string,
    private readonly logger: Logger,
  ) {}

  start(): void {
    void this.cleanupExpired();
    this.timer = setInterval(() => void this.cleanupExpired(), 60 * 60 * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async report(campaignId: string): Promise<CampaignStorageReport> {
    const campaign = await this.campaigns.findById(campaignId);
    const entries = await this.recordingEntries();
    let audioBytes = 0;
    let exportBytes = 0;
    let sessionsWithAudio = 0;
    let sessionsWithoutAudio = 0;
    let eligibleForCleanup = 0;
    for (const entry of entries) {
      const manifest = await readManifest(entry.directory);
      if (manifest?.campaignId !== campaignId) continue;
      const wavFiles = await findWavFiles(entry.directory);
      if (wavFiles.length === 0) {
        sessionsWithoutAudio += 1;
      } else {
        sessionsWithAudio += 1;
        for (const file of wavFiles) audioBytes += (await fs.stat(file)).size;
      }
      exportBytes += await directorySize(join(this.exportsRoot, manifest.sessionId));
      if (
        wavFiles.length > 0 &&
        campaign?.audioRetentionDays !== null &&
        campaign?.audioRetentionDays !== undefined &&
        isExpired(manifest, campaign.audioRetentionDays) &&
        (await exists(join(entry.directory, ".transcription-published")))
      ) {
        eligibleForCleanup += 1;
      }
    }
    return {
      audioBytes,
      exportBytes,
      sessionsWithAudio,
      sessionsWithoutAudio,
      retentionDays: campaign?.audioRetentionDays ?? null,
      eligibleForCleanup,
    };
  }

  async cleanupExpired(): Promise<number> {
    if (this.cleaning) return 0;
    this.cleaning = true;
    let cleaned = 0;
    try {
      for (const entry of await this.recordingEntries()) {
        const manifest = await readManifest(entry.directory);
        if (manifest?.status !== "completed" || manifest.endedAt === null) continue;
        const campaign = await this.campaigns.findById(manifest.campaignId);
        if (
          campaign?.audioRetentionDays === null ||
          campaign?.audioRetentionDays === undefined ||
          !isExpired(manifest, campaign.audioRetentionDays) ||
          !(await exists(join(entry.directory, ".transcription-published")))
        ) continue;
        const files = await findWavFiles(entry.directory);
        let removed = 0;
        for (const file of files) {
          removed += (await fs.stat(file)).size;
          await fs.rm(file, { force: true });
        }
        if (removed === 0) continue;
        await fs.writeFile(
          join(entry.directory, ".audio-purged"),
          `${new Date().toISOString()}\n`,
          "utf8",
        );
        cleaned += 1;
        this.logger.info(
          { sessionId: manifest.sessionId, removedBytes: removed },
          "Audio antiguo eliminado segun la politica de conservacion",
        );
      }
      return cleaned;
    } catch (error) {
      this.logger.error({ error }, "Fallo al aplicar la conservacion de audio");
      return cleaned;
    } finally {
      this.cleaning = false;
    }
  }

  private async recordingEntries(): Promise<readonly { directory: string }[]> {
    try {
      const entries = await fs.readdir(this.recordingsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ directory: join(this.recordingsRoot, entry.name) }));
    } catch {
      return [];
    }
  }
}

async function findWavFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findWavFiles(path));
    else if (entry.isFile() && entry.name.toLocaleLowerCase("es").endsWith(".wav")) {
      files.push(path);
    }
  }
  return files;
}

function isExpired(manifest: RecordingManifest, retentionDays: number): boolean {
  if (manifest.endedAt === null) return false;
  return Date.now() - new Date(manifest.endedAt).getTime() >= retentionDays * 86_400_000;
}

async function readManifest(directory: string): Promise<RecordingManifest | null> {
  try {
    return JSON.parse(
      await fs.readFile(join(directory, "manifest.json"), "utf8"),
    ) as RecordingManifest;
  } catch {
    return null;
  }
}

async function directorySize(directory: string): Promise<number> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const path = join(directory, entry.name);
      total += entry.isDirectory() ? await directorySize(path) : (await fs.stat(path)).size;
    }
    return total;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
