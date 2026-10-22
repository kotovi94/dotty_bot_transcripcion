import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { SessionFileCoordinator } from "./session-file-coordinator.ts";
import type { ManagedSession } from "./session-repository.ts";
import type { SessionService } from "./session-service.ts";

type RecoverySessions = Pick<SessionService, "listActive" | "findById" | "failInterrupted" | "recoverInterrupted">;

interface ClosedManifest {
  sessionId?: unknown;
  discordGuildId?: unknown;
  voiceChannelId?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  status?: unknown;
}

export interface ClosedRecordingRecoveryResult {
  readonly recovered: readonly string[];
  readonly skipped: readonly string[];
}

// A capture can write "interrupted" before its database row is changed. A
// later restart must reconcile that closed manifest as well as open manifests
// handled by VoiceCaptureManager.recoverInterrupted(). Keep session locks and
// all recording material intact, including on errors.
export async function recoverClosedRecordings(
  sessions: RecoverySessions,
  coordinator: SessionFileCoordinator,
  recordingsRoot: string,
): Promise<ClosedRecordingRecoveryResult> {
  const recovered: string[] = [];
  const skipped: string[] = [];
  for (const candidate of await sessions.listActive()) {
    try {
      await coordinator.runExclusive(candidate.id, async () => {
        const current = await sessions.findById(candidate.id);
        if (current === null || !isSameActiveSession(candidate, current)) return;
        const manifest = await readManifest(join(recordingsRoot, candidate.id, "manifest.json"));
        if (!matchesClosedManifest(current, manifest)) return;
        const endedAt = new Date(manifest.endedAt as string);
        const count = manifest.status === "interrupted"
          ? await sessions.failInterrupted([current.id], endedAt)
          : await sessions.recoverInterrupted([current.id], endedAt);
        if (count === 1) recovered.push(current.id);
      });
    } catch {
      // A surviving lock, unreadable manifest or database failure needs review.
      skipped.push(candidate.id);
    }
  }
  return { recovered, skipped };
}

function isSameActiveSession(candidate: ManagedSession, current: ManagedSession): boolean {
  return candidate.id === current.id && candidate.status === current.status &&
    candidate.discordGuildId === current.discordGuildId &&
    candidate.voiceChannelId === current.voiceChannelId &&
    candidate.startedAt?.getTime() === current.startedAt?.getTime() &&
    ["recording", "paused", "finalizing"].includes(current.status);
}

async function readManifest(path: string): Promise<ClosedManifest | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    return value !== null && typeof value === "object" ? value as ClosedManifest : null;
  } catch {
    return null;
  }
}

function matchesClosedManifest(session: ManagedSession, manifest: ClosedManifest | null): manifest is ClosedManifest & {
  status: "completed" | "interrupted";
  endedAt: string;
} {
  if (session.startedAt === null) return false;
  if (manifest === null || !["completed", "interrupted"].includes(String(manifest.status))) return false;
  if (manifest.sessionId !== session.id || manifest.discordGuildId !== session.discordGuildId ||
    manifest.voiceChannelId !== session.voiceChannelId ||
    manifest.startedAt !== session.startedAt?.toISOString()) return false;
  if (typeof manifest.endedAt !== "string" || !Number.isFinite(Date.parse(manifest.endedAt)) ||
    Date.parse(manifest.endedAt) < session.startedAt.getTime()) return false;
  return true;
}
