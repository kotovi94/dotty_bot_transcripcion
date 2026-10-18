import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { RecordingManifest } from "../recording/voice-capture-manager.ts";
import { ReprocessIntentStore } from "../sessions/reprocess-intent-store.ts";
import { SessionFileCoordinator } from "../sessions/session-file-coordinator.ts";

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
    private readonly intents: ReprocessIntentStore,
    private readonly coordinator: SessionFileCoordinator,
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
        await isEligibleForCleanup(manifest, campaign?.audioRetentionDays, entry.directory)
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
        try {
          const manifest = await readManifest(entry.directory);
          if (manifest?.status !== "completed" || manifest.endedAt === null) continue;
          const campaign = await this.campaigns.findById(manifest.campaignId);
          if (!(await isEligibleForCleanup(manifest, campaign?.audioRetentionDays, entry.directory))) continue;
          await this.coordinator.runExclusive(manifest.sessionId, async () => {
            // Recheck all deletion gates under the same lock as dispatch and intent creation.
            const current = await readManifest(entry.directory);
            if (current === null || !(await isEligibleForCleanup(current, campaign?.audioRetentionDays, entry.directory))) return;
            if (await this.intents.hasPending(current.sessionId)) return;
            if (await hasUncertainDispatch(entry.directory)) return;
            const files = await findWavFiles(entry.directory);
            let removed = 0;
            for (const file of files) {
              removed += (await fs.stat(file)).size;
              await fs.rm(file, { force: true });
            }
            if (removed === 0) return;
            await fs.writeFile(join(entry.directory, ".audio-purged"), `${new Date().toISOString()}\n`, "utf8");
            cleaned += 1;
            this.logger.info(
              { sessionId: current.sessionId, removedBytes: removed },
              "Audio antiguo eliminado segun la politica de conservacion",
            );
          });
        } catch (error) {
          this.logger.error({ error, directory: entry.directory }, "Fallo al aplicar la conservacion de audio a una sesion");
        }
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
  const entries = await fs.readdir(directory, { withFileTypes: true });
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

async function hasUncertainDispatch(directory: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(join(directory, ".transcription-jobs"));
    return entries.some((entry) => entry.endsWith(".posting"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isEligibleForCleanup(
  manifest: RecordingManifest,
  retentionDays: number | null | undefined,
  directory: string,
): Promise<boolean> {
  // Prepared transcripts still need their source audio for human review.
  return manifest.status === "completed"
    && retentionDays !== null
    && retentionDays !== undefined
    && isExpired(manifest, retentionDays)
    && await exists(join(directory, ".transcription-published"));
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
