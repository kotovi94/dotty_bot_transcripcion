import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { SessionService } from "./session-service.ts";

export class ReprocessIntentEligibilityError extends Error {}

// Called only while the per-session coordinator is held. Read-only: neither
// the database nor the recording is changed by this check.
export class ReprocessIntentEligibility {
  constructor(
    private readonly sessions: Pick<SessionService, "findById">,
    private readonly recordingsRoot: string,
  ) {}

  async assertEligible(sessionId: string): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    if (session === null || session.id !== sessionId ||
      (session.status !== "completed" && session.status !== "failed")) {
      throw new ReprocessIntentEligibilityError("Session is missing or cannot be reprocessed");
    }

    const directory = resolve(this.recordingsRoot, sessionId);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await fs.readFile(join(directory, "manifest.json"), "utf8"));
    } catch (error) {
      throw new ReprocessIntentEligibilityError("Recording manifest is missing or unreadable", { cause: error });
    }
    if (!isManifest(manifest) || manifest.sessionId !== sessionId ||
      manifest.discordGuildId !== session.discordGuildId ||
      (manifest.status !== "completed" && manifest.status !== "interrupted") ||
      manifest.chunks.length === 0) {
      throw new ReprocessIntentEligibilityError("Recording manifest is incomplete or inconsistent");
    }

    // If the marker exists, the recording has already been purged, even if a
    // partial WAV remains after an interrupted cleanup.
    const marker = await fs.stat(join(directory, ".audio-purged")).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (marker) throw new ReprocessIntentEligibilityError("Original audio was purged");

    for (const chunk of manifest.chunks) {
      if (typeof chunk.file !== "string" || !chunk.file.toLowerCase().endsWith(".wav")) {
        throw new ReprocessIntentEligibilityError("Recording chunk path is invalid");
      }
      const file = resolve(directory, chunk.file);
      const within = relative(directory, file);
      if (!within || within === ".." || within.startsWith(`..\\`) || within.startsWith("../") || isAbsolute(within)) {
        throw new ReprocessIntentEligibilityError("Recording chunk escapes its session directory");
      }
      let info;
      try { info = await fs.lstat(file); }
      catch (error) { throw new ReprocessIntentEligibilityError("Original WAV is missing or unreadable", { cause: error }); }
      if (!info.isFile() || info.size <= 44) {
        throw new ReprocessIntentEligibilityError("Original WAV is incomplete");
      }
    }
  }
}

function isManifest(value: unknown): value is {
  version: 1 | 2;
  sessionId: string;
  discordGuildId: string;
  status: string;
  chunks: Array<{ file: unknown }>;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.version === 1 || item.version === 2) &&
    typeof item.sessionId === "string" && typeof item.discordGuildId === "string" &&
    typeof item.status === "string" && Array.isArray(item.chunks) &&
    item.chunks.every((chunk) => typeof chunk === "object" && chunk !== null && !Array.isArray(chunk));
}
