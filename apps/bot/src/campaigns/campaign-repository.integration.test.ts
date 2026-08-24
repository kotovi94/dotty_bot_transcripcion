import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createDatabaseClient } from "../database/client.ts";
import { PrismaCampaignRepository } from "./campaign-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL must be set by the test runner.");
}

const database = createDatabaseClient(databaseUrl);
const repository = new PrismaCampaignRepository(database);

after(async () => {
  await database.$disconnect();
});

describe("PrismaCampaignRepository", () => {
  it("persists a campaign and updates it idempotently", async () => {
    const first = await repository.configure({
      discordGuildId: "guild-1",
      guildName: "Mesa de los viernes",
      campaignName: "La Maldicion de Strahd",
    });
    const second = await repository.configure({
      discordGuildId: "guild-1",
      guildName: "Mesa de los viernes",
      campaignName: "  LA MALDICION DE STRAHD ",
      defaultVoiceChannelId: "voice-123",
      defaultLogChannelId: "log-456",
      startingSessionNumber: 40,
    });

    assert.equal(second.id, first.id);
    const campaigns = await repository.listByGuild("guild-1");
    assert.equal(campaigns.length, 1);
    assert.deepEqual(campaigns[0], {
      id: first.id,
      name: "LA MALDICION DE STRAHD",
      memberCount: 0,
      sessionCount: 0,
      defaultVoiceChannelId: "voice-123",
      defaultLogChannelId: "log-456",
      nextSessionNumber: 40,
      transcriptionVocabulary: "",
      audioRetentionDays: null,
    });
    assert.deepEqual(
      await repository.findByGuildAndName("guild-1", "la maldicion de strahd"),
      {
        id: first.id,
        name: "LA MALDICION DE STRAHD",
        defaultVoiceChannelId: "voice-123",
        defaultLogChannelId: "log-456",
        nextSessionNumber: 40,
        transcriptionVocabulary: "",
        audioRetentionDays: null,
      },
    );
    const vocabulary = await repository.setVocabulary(
      "guild-1",
      "La Maldicion de Strahd",
      "Barovia, Strahd, Ireena, Ezmerelda",
    );
    assert.equal(
      vocabulary.transcriptionVocabulary,
      "Barovia, Strahd, Ireena, Ezmerelda",
    );
    const retention = await repository.setAudioRetention(
      "guild-1",
      "La Maldicion de Strahd",
      30,
    );
    assert.equal(retention.audioRetentionDays, 30);

    await repository.configureMember({
      discordGuildId: "guild-1",
      campaignName: "La Maldicion de Strahd",
      discordUserId: "user-123",
      playerName: "Camila",
      characterName: "Ireena",
    });
    await repository.configureMember({
      discordGuildId: "guild-1",
      campaignName: "La Maldicion de Strahd",
      discordUserId: "user-123",
      playerName: "Cami",
      characterName: "Ezmerelda",
    });
    assert.deepEqual(await repository.listMembersByCampaignId(first.id), [
      {
        discordUserId: "user-123",
        playerName: "Cami",
        characterName: "Ezmerelda",
      },
    ]);
    assert.equal(
      await repository.deleteMember(
        "guild-1",
        "La Maldicion de Strahd",
        "user-123",
      ),
      true,
    );
    assert.deepEqual(await repository.listMembersByCampaignId(first.id), []);
  });

  it("keeps campaigns from different Discord servers isolated", async () => {
    await repository.configure({
      discordGuildId: "guild-2",
      guildName: "Otra mesa",
      campaignName: "La Maldicion de Strahd",
    });

    const firstGuild = await repository.listByGuild("guild-1");
    const secondGuild = await repository.listByGuild("guild-2");
    assert.equal(firstGuild.length, 1);
    assert.equal(secondGuild.length, 1);
    assert.notEqual(firstGuild[0]?.id, secondGuild[0]?.id);
    const campaignToDelete = secondGuild[0];
    assert.notEqual(campaignToDelete, undefined);
    await repository.deleteById(campaignToDelete!.id);
    assert.equal(await repository.findById(campaignToDelete!.id), null);
  });
});
