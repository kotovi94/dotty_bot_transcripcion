import type { SessionEvent } from "../domain/session.ts";
import type {
  PersistedSession,
  SessionRepository,
  StartSessionInput,
} from "./session-repository.ts";

export class SessionService {
  constructor(private readonly sessions: SessionRepository) {}

  start(input: StartSessionInput): Promise<PersistedSession> {
    return this.sessions.start(input);
  }

  pause(discordGuildId: string, campaignName: string): Promise<PersistedSession> {
    return this.transition(discordGuildId, campaignName, { type: "pause" });
  }

  resume(discordGuildId: string, campaignName: string): Promise<PersistedSession> {
    return this.transition(discordGuildId, campaignName, { type: "resume" });
  }

  finish(
    discordGuildId: string,
    campaignName: string,
    occurredAt: Date,
  ): Promise<PersistedSession> {
    return this.transition(discordGuildId, campaignName, {
      type: "finish",
      occurredAt,
    });
  }

  complete(discordGuildId: string, campaignName: string): Promise<PersistedSession> {
    return this.transition(discordGuildId, campaignName, { type: "complete" });
  }

  fail(
    discordGuildId: string,
    campaignName: string,
    occurredAt: Date,
  ): Promise<PersistedSession> {
    return this.transition(discordGuildId, campaignName, {
      type: "fail",
      occurredAt,
    });
  }

  failInterrupted(sessionIds: readonly string[], occurredAt: Date): Promise<number> {
    return this.sessions.failInterrupted(sessionIds, occurredAt);
  }

  recoverInterrupted(sessionIds: readonly string[], occurredAt: Date): Promise<number> {
    return this.sessions.recoverInterrupted(sessionIds, occurredAt);
  }

  recoverFailed(sessionId: string, occurredAt: Date): Promise<boolean> {
    return this.sessions.recoverFailed(sessionId, occurredAt);
  }

  listRecent(discordGuildId: string, campaignName: string, limit = 10) {
    return this.sessions.listRecent(discordGuildId, campaignName, limit);
  }

  findBySequence(
    discordGuildId: string,
    campaignName: string,
    sequenceNumber: number,
  ) {
    return this.sessions.findBySequence(discordGuildId, campaignName, sequenceNumber);
  }

  findById(sessionId: string) {
    return this.sessions.findById(sessionId);
  }

  deleteById(sessionId: string) {
    return this.sessions.deleteById(sessionId);
  }

  listByCampaignId(campaignId: string) {
    return this.sessions.listByCampaignId(campaignId);
  }

  private transition(
    discordGuildId: string,
    campaignName: string,
    event: SessionEvent,
  ): Promise<PersistedSession> {
    return this.sessions.transition({ discordGuildId, campaignName, event });
  }
}
