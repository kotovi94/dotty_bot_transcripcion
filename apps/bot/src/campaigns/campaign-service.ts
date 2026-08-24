import type {
  CampaignRepository,
  CampaignSummary,
  ConfigureCampaignInput,
} from "./campaign-repository.ts";

export class CampaignService {
  constructor(private readonly campaigns: CampaignRepository) {}

  configure(input: ConfigureCampaignInput) {
    return this.campaigns.configure(input);
  }

  listByGuild(discordGuildId: string): Promise<readonly CampaignSummary[]> {
    return this.campaigns.listByGuild(discordGuildId);
  }

  findByGuildAndName(discordGuildId: string, campaignName: string) {
    return this.campaigns.findByGuildAndName(discordGuildId, campaignName);
  }

  configureMember(input: import("./campaign-repository.ts").ConfigureCampaignMemberInput) {
    return this.campaigns.configureMember(input);
  }

  listMembersByCampaignId(campaignId: string) {
    return this.campaigns.listMembersByCampaignId(campaignId);
  }

  findById(campaignId: string) {
    return this.campaigns.findById(campaignId);
  }

  deleteMember(
    discordGuildId: string,
    campaignName: string,
    discordUserId: string,
  ) {
    return this.campaigns.deleteMember(discordGuildId, campaignName, discordUserId);
  }

  deleteById(campaignId: string) {
    return this.campaigns.deleteById(campaignId);
  }

  setVocabulary(discordGuildId: string, campaignName: string, vocabulary: string) {
    return this.campaigns.setVocabulary(discordGuildId, campaignName, vocabulary);
  }

  setAudioRetention(
    discordGuildId: string,
    campaignName: string,
    days: number | null,
  ) {
    return this.campaigns.setAudioRetention(discordGuildId, campaignName, days);
  }
}
