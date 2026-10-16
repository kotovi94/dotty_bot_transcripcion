import type { SessionEvent } from "../domain/session.ts";
import type {
  PersistedSession,
  SessionRepository,
  StartSessionInput,
} from "./session-repository.ts";
import { CampaignNotFoundError } from "./session-repository.ts";
import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { CampaignFileCoordinator } from "./campaign-file-coordinator.ts";
import type { SessionFileCoordinator } from "./session-file-coordinator.ts";

export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly campaigns: Pick<CampaignService, "findByGuildAndName">,
    private readonly campaignCoordinator: CampaignFileCoordinator,
    private readonly sessionCoordinator: SessionFileCoordinator,
  ) {}

  async start(input: StartSessionInput): Promise<PersistedSession> {
    return this.startWithCapture(input, async () => {});
  }

  async startWithCapture(
    input: StartSessionInput,
    startCapture: (session: PersistedSession) => Promise<void>,
  ): Promise<PersistedSession> {
    const campaign = await this.campaigns.findByGuildAndName(
      input.discordGuildId,
      input.campaignName,
    );
    if (campaign === null) throw new CampaignNotFoundError(input.campaignName);

    return this.campaignCoordinator.runExclusive(campaign.id, async () => {
      const current = await this.campaigns.findByGuildAndName(
        input.discordGuildId,
        input.campaignName,
      );
      if (current === null || current.id !== campaign.id) {
        throw new CampaignNotFoundError(input.campaignName);
      }
      const session = await this.sessions.start(input);
      return this.sessionCoordinator.runExclusive(session.id, async () => {
        const persisted = await this.sessions.findById(session.id);
        if (
          persisted === null || persisted.id !== session.id ||
          persisted.discordGuildId !== input.discordGuildId ||
          persisted.campaignName !== campaign.name ||
          persisted.sequenceNumber !== session.sequenceNumber ||
          persisted.status !== session.status
        ) {
          throw new Error("Session changed before capture startup; retry the command.");
        }
        try {
          await startCapture(session);
        } catch (captureError) {
          try {
            await this.sessions.transition({
              discordGuildId: input.discordGuildId,
              campaignName: input.campaignName,
              event: { type: "fail", occurredAt: new Date() },
            });
          } catch (databaseError) {
            throw new AggregateError(
              [captureError, databaseError],
              "Capture startup failed and the session failure state could not be recorded.",
              { cause: captureError },
            );
          }
          throw captureError;
        }
        return session;
      });
    });
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

  findActive(discordGuildId: string, campaignName: string) {
    return this.sessions.findActive(discordGuildId, campaignName);
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
