import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import type { ManagedSession, PersistedSession } from "./session-repository.ts";
import type { SessionService } from "./session-service.ts";

/**
 * Coordinates the database lifecycle with capture finalization. Capture errors
 * become an explicit failed session, while a transient final database write is
 * recovered idempotently from the already completed audio manifest.
 */
export async function finalizeSessionSafely(
  sessions: SessionService,
  recordings: Pick<VoiceCaptureManager, "finish">,
  discordGuildId: string,
  campaignName: string,
  occurredAt = new Date(),
): Promise<PersistedSession | ManagedSession> {
  const finalizing = await sessions.finish(discordGuildId, campaignName, occurredAt);
  try {
    await recordings.finish(discordGuildId);
  } catch (error) {
    await sessions.fail(discordGuildId, campaignName, new Date()).catch(() => undefined);
    throw error;
  }

  try {
    return await sessions.complete(discordGuildId, campaignName);
  } catch (error) {
    const recovered = await sessions.recoverInterrupted([finalizing.id], new Date());
    if (recovered === 1) {
      const session = await sessions.findById(finalizing.id);
      if (session !== null) return session;
    }
    throw error;
  }
}
