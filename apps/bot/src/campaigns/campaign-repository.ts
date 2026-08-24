import type { PrismaClient } from "../generated/prisma/client.ts";

export interface ConfigureCampaignInput {
  readonly discordGuildId: string;
  readonly guildName: string;
  readonly campaignName: string;
  readonly defaultVoiceChannelId?: string;
  readonly defaultLogChannelId?: string | null;
  readonly startingSessionNumber?: number;
  readonly transcriptionVocabulary?: string;
  readonly audioRetentionDays?: number | null;
}

export interface CampaignSummary {
  readonly id: string;
  readonly name: string;
  readonly memberCount: number;
  readonly sessionCount: number;
  readonly defaultVoiceChannelId: string | null;
  readonly defaultLogChannelId: string | null;
  readonly nextSessionNumber: number;
  readonly transcriptionVocabulary: string;
  readonly audioRetentionDays: number | null;
}

export interface ConfiguredCampaign {
  readonly id: string;
  readonly name: string;
  readonly defaultVoiceChannelId: string | null;
  readonly defaultLogChannelId: string | null;
  readonly nextSessionNumber: number;
  readonly transcriptionVocabulary: string;
  readonly audioRetentionDays: number | null;
}

export interface ConfigureCampaignMemberInput {
  readonly discordGuildId: string;
  readonly campaignName: string;
  readonly discordUserId: string;
  readonly playerName: string;
  readonly characterName: string;
}

export interface CampaignMemberSummary {
  readonly discordUserId: string;
  readonly playerName: string;
  readonly characterName: string | null;
}

export interface ManagedCampaign extends ConfiguredCampaign {
  readonly discordGuildId: string;
}

export class CampaignNotConfiguredError extends Error {
  constructor(campaignName: string) {
    super(`Campaign '${campaignName}' was not found in this Discord server.`);
    this.name = "CampaignNotConfiguredError";
  }
}

export class InvalidStartingSessionNumberError extends Error {
  constructor(readonly minimum: number) {
    super(`The next session number must be at least ${minimum}.`);
    this.name = "InvalidStartingSessionNumberError";
  }
}

export interface CampaignRepository {
  configure(input: ConfigureCampaignInput): Promise<ConfiguredCampaign>;
  listByGuild(discordGuildId: string): Promise<readonly CampaignSummary[]>;
  findByGuildAndName(
    discordGuildId: string,
    campaignName: string,
  ): Promise<ConfiguredCampaign | null>;
  configureMember(input: ConfigureCampaignMemberInput): Promise<CampaignMemberSummary>;
  listMembersByCampaignId(campaignId: string): Promise<readonly CampaignMemberSummary[]>;
  findById(campaignId: string): Promise<ManagedCampaign | null>;
  deleteMember(
    discordGuildId: string,
    campaignName: string,
    discordUserId: string,
  ): Promise<boolean>;
  deleteById(campaignId: string): Promise<void>;
  setVocabulary(
    discordGuildId: string,
    campaignName: string,
    vocabulary: string,
  ): Promise<ConfiguredCampaign>;
  setAudioRetention(
    discordGuildId: string,
    campaignName: string,
    days: number | null,
  ): Promise<ConfiguredCampaign>;
}

export class PrismaCampaignRepository implements CampaignRepository {
  constructor(private readonly database: PrismaClient) {}

  async configure(input: ConfigureCampaignInput): Promise<ConfiguredCampaign> {
    const normalizedName = normalizeCampaignName(input.campaignName);
    if (input.startingSessionNumber !== undefined && input.startingSessionNumber < 1) {
      throw new InvalidStartingSessionNumberError(1);
    }

    return this.database.$transaction(async (transaction) => {
      const server = await transaction.discordServer.upsert({
        where: { discordGuildId: input.discordGuildId },
        update: { name: input.guildName },
        create: {
          discordGuildId: input.discordGuildId,
          name: input.guildName,
        },
      });

      const existing = await transaction.campaign.findUnique({
        where: {
          serverId_normalizedName: {
            serverId: server.id,
            normalizedName,
          },
        },
        select: {
          sessions: {
            orderBy: { sequenceNumber: "desc" },
            take: 1,
            select: { sequenceNumber: true },
          },
        },
      });
      const minimumSessionNumber =
        (existing?.sessions[0]?.sequenceNumber ?? 0) + 1;
      if (
        input.startingSessionNumber !== undefined &&
        input.startingSessionNumber < minimumSessionNumber
      ) {
        throw new InvalidStartingSessionNumberError(minimumSessionNumber);
      }

      const configured = await transaction.campaign.upsert({
        where: {
          serverId_normalizedName: {
            serverId: server.id,
            normalizedName,
          },
        },
        update: {
          name: input.campaignName.trim(),
          ...(input.defaultVoiceChannelId !== undefined
            ? { defaultVoiceChannelId: input.defaultVoiceChannelId }
            : {}),
          ...(input.defaultLogChannelId !== undefined
            ? { defaultLogChannelId: input.defaultLogChannelId }
            : {}),
          ...(input.startingSessionNumber !== undefined
            ? { nextSessionNumber: input.startingSessionNumber }
            : {}),
          ...(input.transcriptionVocabulary !== undefined
            ? { transcriptionVocabulary: input.transcriptionVocabulary.trim() }
            : {}),
          ...(input.audioRetentionDays !== undefined
            ? { audioRetentionDays: input.audioRetentionDays }
            : {}),
        },
        create: {
          serverId: server.id,
          name: input.campaignName.trim(),
          normalizedName,
          defaultVoiceChannelId: input.defaultVoiceChannelId ?? null,
          defaultLogChannelId: input.defaultLogChannelId ?? null,
          nextSessionNumber: input.startingSessionNumber ?? 1,
          transcriptionVocabulary: input.transcriptionVocabulary?.trim() ?? "",
          audioRetentionDays: input.audioRetentionDays ?? null,
        },
        select: {
          id: true,
          name: true,
          defaultVoiceChannelId: true,
          defaultLogChannelId: true,
          nextSessionNumber: true,
          transcriptionVocabulary: true,
          audioRetentionDays: true,
        },
      });
      return {
        ...configured,
        nextSessionNumber: Math.max(
          configured.nextSessionNumber,
          minimumSessionNumber,
        ),
      };
    });
  }

  async listByGuild(
    discordGuildId: string,
  ): Promise<readonly CampaignSummary[]> {
    const campaigns = await this.database.campaign.findMany({
      where: { server: { discordGuildId } },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { members: true, sessions: true } },
        sessions: {
          orderBy: { sequenceNumber: "desc" },
          take: 1,
          select: { sequenceNumber: true },
        },
      },
    });

    return campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      memberCount: campaign._count.members,
      sessionCount: campaign._count.sessions,
      defaultVoiceChannelId: campaign.defaultVoiceChannelId,
      defaultLogChannelId: campaign.defaultLogChannelId,
      nextSessionNumber: Math.max(
        campaign.nextSessionNumber,
        (campaign.sessions[0]?.sequenceNumber ?? 0) + 1,
      ),
      transcriptionVocabulary: campaign.transcriptionVocabulary,
      audioRetentionDays: campaign.audioRetentionDays,
    }));
  }

  async findByGuildAndName(
    discordGuildId: string,
    campaignName: string,
  ): Promise<ConfiguredCampaign | null> {
    return this.database.campaign.findFirst({
      where: {
        normalizedName: normalizeCampaignName(campaignName),
        server: { discordGuildId },
      },
      select: {
        id: true,
        name: true,
        defaultVoiceChannelId: true,
        defaultLogChannelId: true,
        nextSessionNumber: true,
        transcriptionVocabulary: true,
        audioRetentionDays: true,
      },
    });
  }

  async configureMember(
    input: ConfigureCampaignMemberInput,
  ): Promise<CampaignMemberSummary> {
    const campaign = await this.findByGuildAndName(
      input.discordGuildId,
      input.campaignName,
    );
    if (campaign === null) throw new CampaignNotConfiguredError(input.campaignName);

    return this.database.campaignMember.upsert({
      where: {
        campaignId_discordUserId: {
          campaignId: campaign.id,
          discordUserId: input.discordUserId,
        },
      },
      update: {
        playerName: input.playerName.trim(),
        characterName: input.characterName.trim(),
      },
      create: {
        campaignId: campaign.id,
        discordUserId: input.discordUserId,
        playerName: input.playerName.trim(),
        characterName: input.characterName.trim(),
        role: "jugador",
      },
      select: {
        discordUserId: true,
        playerName: true,
        characterName: true,
      },
    });
  }

  listMembersByCampaignId(
    campaignId: string,
  ): Promise<readonly CampaignMemberSummary[]> {
    return this.database.campaignMember.findMany({
      where: { campaignId },
      orderBy: { createdAt: "asc" },
      select: {
        discordUserId: true,
        playerName: true,
        characterName: true,
      },
    });
  }

  async findById(campaignId: string): Promise<ManagedCampaign | null> {
    return this.database.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        name: true,
        defaultVoiceChannelId: true,
        defaultLogChannelId: true,
        nextSessionNumber: true,
        transcriptionVocabulary: true,
        audioRetentionDays: true,
        server: { select: { discordGuildId: true } },
      },
    }).then((campaign) =>
      campaign === null
        ? null
        : {
            id: campaign.id,
            name: campaign.name,
            defaultVoiceChannelId: campaign.defaultVoiceChannelId,
            defaultLogChannelId: campaign.defaultLogChannelId,
            nextSessionNumber: campaign.nextSessionNumber,
            transcriptionVocabulary: campaign.transcriptionVocabulary,
            audioRetentionDays: campaign.audioRetentionDays,
            discordGuildId: campaign.server.discordGuildId,
          },
    );
  }

  async deleteMember(
    discordGuildId: string,
    campaignName: string,
    discordUserId: string,
  ): Promise<boolean> {
    const result = await this.database.campaignMember.deleteMany({
      where: {
        discordUserId,
        campaign: {
          normalizedName: normalizeCampaignName(campaignName),
          server: { discordGuildId },
        },
      },
    });
    return result.count > 0;
  }

  async deleteById(campaignId: string): Promise<void> {
    await this.database.campaign.delete({ where: { id: campaignId } });
  }

  async setVocabulary(
    discordGuildId: string,
    campaignName: string,
    vocabulary: string,
  ): Promise<ConfiguredCampaign> {
    const campaign = await this.findByGuildAndName(discordGuildId, campaignName);
    if (campaign === null) throw new CampaignNotConfiguredError(campaignName);
    return this.database.campaign.update({
      where: { id: campaign.id },
      data: { transcriptionVocabulary: vocabulary.trim() },
      select: {
        id: true,
        name: true,
        defaultVoiceChannelId: true,
        defaultLogChannelId: true,
        nextSessionNumber: true,
        transcriptionVocabulary: true,
        audioRetentionDays: true,
      },
    });
  }

  async setAudioRetention(
    discordGuildId: string,
    campaignName: string,
    days: number | null,
  ): Promise<ConfiguredCampaign> {
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      throw new TypeError("Audio retention must be null or a positive integer.");
    }
    const campaign = await this.findByGuildAndName(discordGuildId, campaignName);
    if (campaign === null) throw new CampaignNotConfiguredError(campaignName);
    return this.database.campaign.update({
      where: { id: campaign.id },
      data: { audioRetentionDays: days },
      select: {
        id: true,
        name: true,
        defaultVoiceChannelId: true,
        defaultLogChannelId: true,
        nextSessionNumber: true,
        transcriptionVocabulary: true,
        audioRetentionDays: true,
      },
    });
  }
}

export function normalizeCampaignName(name: string): string {
  const normalized = name.trim().normalize("NFKC").toLocaleLowerCase("es");
  if (normalized.length === 0) {
    throw new TypeError("Campaign name is required.");
  }
  return normalized;
}
