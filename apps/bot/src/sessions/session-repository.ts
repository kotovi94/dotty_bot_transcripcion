import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  applySessionEvent,
  type SessionEvent,
  type SessionState,
  type SessionStatus,
} from "../domain/session.ts";
import { normalizeCampaignName } from "../campaigns/campaign-repository.ts";

const activeStatuses: readonly SessionStatus[] = [
  "recording",
  "paused",
  "finalizing",
];

export class CampaignNotFoundError extends Error {
  constructor(campaignName: string) {
    super(`Campaign '${campaignName}' was not found in this Discord server.`);
    this.name = "CampaignNotFoundError";
  }
}

export class ActiveSessionExistsError extends Error {
  constructor() {
    super("This Discord server already has an active session.");
    this.name = "ActiveSessionExistsError";
  }
}

export class ActiveSessionNotFoundError extends Error {
  constructor(campaignName: string) {
    super(`Campaign '${campaignName}' has no active session.`);
    this.name = "ActiveSessionNotFoundError";
  }
}

export interface StartSessionInput {
  readonly discordGuildId: string;
  readonly campaignName: string;
  readonly voiceChannelId: string;
  readonly logChannelId: string | null;
  readonly occurredAt: Date;
}

export interface TransitionSessionInput {
  readonly discordGuildId: string;
  readonly campaignName: string;
  readonly event: SessionEvent;
}

export interface PersistedSession extends SessionState {
  readonly campaignName: string;
  readonly voiceChannelId: string | null;
  readonly logChannelId: string | null;
}

export interface ManagedSession {
  readonly id: string;
  readonly discordGuildId: string;
  readonly campaignName: string;
  readonly sequenceNumber: number;
  readonly status: SessionStatus;
  readonly voiceChannelId: string | null;
  readonly logChannelId: string | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

export interface SessionRepository {
  start(input: StartSessionInput): Promise<PersistedSession>;
  transition(input: TransitionSessionInput): Promise<PersistedSession>;
  failInterrupted(sessionIds: readonly string[], occurredAt: Date): Promise<number>;
  recoverInterrupted(sessionIds: readonly string[], occurredAt: Date): Promise<number>;
  recoverFailed(sessionId: string, occurredAt: Date): Promise<boolean>;
  listRecent(
    discordGuildId: string,
    campaignName: string,
    limit: number,
  ): Promise<readonly ManagedSession[]>;
  findBySequence(
    discordGuildId: string,
    campaignName: string,
    sequenceNumber: number,
  ): Promise<ManagedSession | null>;
  findById(sessionId: string): Promise<ManagedSession | null>;
  deleteById(sessionId: string): Promise<void>;
  listByCampaignId(campaignId: string): Promise<readonly ManagedSession[]>;
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly database: PrismaClient) {}

  async start(input: StartSessionInput): Promise<PersistedSession> {
    return this.database.$transaction(async (transaction) => {
      const campaign = await transaction.campaign.findFirst({
        where: {
          normalizedName: normalizeCampaignName(input.campaignName),
          server: { discordGuildId: input.discordGuildId },
        },
        select: { id: true, name: true, nextSessionNumber: true },
      });
      if (campaign === null) throw new CampaignNotFoundError(input.campaignName);

      const active = await transaction.session.findFirst({
        where: {
          campaign: { server: { discordGuildId: input.discordGuildId } },
          status: { in: [...activeStatuses] },
        },
        select: { id: true },
      });
      if (active !== null) throw new ActiveSessionExistsError();

      const previous = await transaction.session.findFirst({
        where: { campaignId: campaign.id },
        orderBy: { sequenceNumber: "desc" },
        select: { sequenceNumber: true },
      });
      const session = await transaction.session.create({
        data: {
          campaignId: campaign.id,
          sequenceNumber: Math.max(
            (previous?.sequenceNumber ?? 0) + 1,
            campaign.nextSessionNumber,
          ),
          status: "recording",
          voiceChannelId: input.voiceChannelId,
          logChannelId: input.logChannelId,
          startedAt: input.occurredAt,
        },
      });
      return toPersistedSession(session, campaign.name);
    });
  }

  async transition(input: TransitionSessionInput): Promise<PersistedSession> {
    return this.database.$transaction(async (transaction) => {
      const session = await transaction.session.findFirst({
        where: {
          campaign: {
            normalizedName: normalizeCampaignName(input.campaignName),
            server: { discordGuildId: input.discordGuildId },
          },
          status: { in: [...activeStatuses] },
        },
        include: { campaign: { select: { name: true } } },
        orderBy: { sequenceNumber: "desc" },
      });
      if (session === null) {
        throw new ActiveSessionNotFoundError(input.campaignName);
      }

      const next = applySessionEvent(
        {
          id: session.id,
          campaignId: session.campaignId,
          sequenceNumber: session.sequenceNumber,
          status: session.status as SessionStatus,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
        },
        input.event,
      );
      const result = await transaction.session.updateMany({
        where: { id: session.id, status: session.status },
        data: {
          status: next.status,
          startedAt: next.startedAt,
          endedAt: next.endedAt,
        },
      });
      if (result.count !== 1) {
        throw new Error("Session changed concurrently; retry the command.");
      }
      return {
        ...next,
        campaignName: session.campaign.name,
        voiceChannelId: session.voiceChannelId,
        logChannelId: session.logChannelId,
      };
    });
  }

  async failInterrupted(
    sessionIds: readonly string[],
    occurredAt: Date,
  ): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const result = await this.database.session.updateMany({
      where: {
        id: { in: [...sessionIds] },
        status: { in: [...activeStatuses] },
      },
      data: { status: "failed", endedAt: occurredAt },
    });
    return result.count;
  }

  async recoverInterrupted(
    sessionIds: readonly string[],
    occurredAt: Date,
  ): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const result = await this.database.session.updateMany({
      where: {
        id: { in: [...sessionIds] },
        status: { in: [...activeStatuses] },
      },
      data: { status: "completed", endedAt: occurredAt },
    });
    return result.count;
  }

  async recoverFailed(sessionId: string, occurredAt: Date): Promise<boolean> {
    const result = await this.database.session.updateMany({
      where: { id: sessionId, status: "failed" },
      data: { status: "completed", endedAt: occurredAt },
    });
    return result.count === 1;
  }

  async listRecent(
    discordGuildId: string,
    campaignName: string,
    limit: number,
  ): Promise<readonly ManagedSession[]> {
    const rows = await this.database.session.findMany({
      where: {
        campaign: {
          normalizedName: normalizeCampaignName(campaignName),
          server: { discordGuildId },
        },
      },
      include: {
        campaign: { include: { server: { select: { discordGuildId: true } } } },
      },
      orderBy: { sequenceNumber: "desc" },
      take: limit,
    });
    return rows.map(toManagedSession);
  }

  async findBySequence(
    discordGuildId: string,
    campaignName: string,
    sequenceNumber: number,
  ): Promise<ManagedSession | null> {
    const row = await this.database.session.findFirst({
      where: {
        sequenceNumber,
        campaign: {
          normalizedName: normalizeCampaignName(campaignName),
          server: { discordGuildId },
        },
      },
      include: {
        campaign: { include: { server: { select: { discordGuildId: true } } } },
      },
    });
    return row === null ? null : toManagedSession(row);
  }

  async findById(sessionId: string): Promise<ManagedSession | null> {
    const row = await this.database.session.findUnique({
      where: { id: sessionId },
      include: {
        campaign: { include: { server: { select: { discordGuildId: true } } } },
      },
    });
    return row === null ? null : toManagedSession(row);
  }

  async deleteById(sessionId: string): Promise<void> {
    await this.database.session.delete({ where: { id: sessionId } });
  }

  async listByCampaignId(campaignId: string): Promise<readonly ManagedSession[]> {
    const rows = await this.database.session.findMany({
      where: { campaignId },
      include: {
        campaign: { include: { server: { select: { discordGuildId: true } } } },
      },
      orderBy: { sequenceNumber: "desc" },
    });
    return rows.map(toManagedSession);
  }
}

function toManagedSession(row: {
  id: string;
  sequenceNumber: number;
  status: string;
  voiceChannelId: string | null;
  logChannelId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  campaign: { name: string; server: { discordGuildId: string } };
}): ManagedSession {
  return {
    id: row.id,
    discordGuildId: row.campaign.server.discordGuildId,
    campaignName: row.campaign.name,
    sequenceNumber: row.sequenceNumber,
    status: row.status as SessionStatus,
    voiceChannelId: row.voiceChannelId,
    logChannelId: row.logChannelId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

function toPersistedSession(
  session: {
    id: string;
    campaignId: string;
    sequenceNumber: number;
    status: string;
    startedAt: Date | null;
    endedAt: Date | null;
    voiceChannelId: string | null;
    logChannelId: string | null;
  },
  campaignName: string,
): PersistedSession {
  return {
    ...session,
    status: session.status as SessionStatus,
    campaignName,
  };
}
