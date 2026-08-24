import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { PrismaCampaignRepository } from "../campaigns/campaign-repository.ts";
import { createDatabaseClient } from "../database/client.ts";
import { InvalidSessionTransitionError } from "../domain/session.ts";
import {
  ActiveSessionExistsError,
  ActiveSessionNotFoundError,
  CampaignNotFoundError,
  PrismaSessionRepository,
} from "./session-repository.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL must be set by the test runner.");
}

const database = createDatabaseClient(databaseUrl);
const campaigns = new PrismaCampaignRepository(database);
const sessions = new PrismaSessionRepository(database);

after(async () => {
  await database.$disconnect();
});

describe("PrismaSessionRepository", () => {
  it("persists a full session lifecycle and allocates sequence numbers", async () => {
    await campaigns.configure({
      discordGuildId: "session-guild",
      guildName: "Mesa de sesiones",
      campaignName: "Brumas",
      startingSessionNumber: 40,
    });
    const startedAt = new Date("2026-08-01T18:00:00.000Z");
    const first = await sessions.start({
      discordGuildId: "session-guild",
      campaignName: " brumas ",
      voiceChannelId: "voice-1",
      logChannelId: "log-1",
      occurredAt: startedAt,
    });
    assert.equal(first.sequenceNumber, 40);
    assert.equal(first.status, "recording");
    assert.deepEqual(first.startedAt, startedAt);

    const paused = await sessions.transition({
      discordGuildId: "session-guild",
      campaignName: "BRUMAS",
      event: { type: "pause" },
    });
    assert.equal(paused.status, "paused");

    const resumed = await sessions.transition({
      discordGuildId: "session-guild",
      campaignName: "Brumas",
      event: { type: "resume" },
    });
    assert.equal(resumed.status, "recording");

    const endedAt = new Date("2026-08-01T20:30:00.000Z");
    const finished = await sessions.transition({
      discordGuildId: "session-guild",
      campaignName: "Brumas",
      event: { type: "finish", occurredAt: endedAt },
    });
    assert.equal(finished.status, "finalizing");
    assert.deepEqual(finished.endedAt, endedAt);

    await sessions.transition({
      discordGuildId: "session-guild",
      campaignName: "Brumas",
      event: { type: "complete" },
    });
    const second = await sessions.start({
      discordGuildId: "session-guild",
      campaignName: "Brumas",
      voiceChannelId: "voice-2",
      logChannelId: null,
      occurredAt: new Date("2026-08-08T18:00:00.000Z"),
    });
    assert.equal(second.sequenceNumber, 41);
  });

  it("rejects missing campaigns, parallel sessions and invalid transitions", async () => {
    await assert.rejects(
      sessions.start({
        discordGuildId: "missing-guild",
        campaignName: "Inexistente",
        voiceChannelId: "voice",
        logChannelId: null,
        occurredAt: new Date(),
      }),
      CampaignNotFoundError,
    );

    await assert.rejects(
      sessions.start({
        discordGuildId: "session-guild",
        campaignName: "Brumas",
        voiceChannelId: "voice",
        logChannelId: null,
        occurredAt: new Date(),
      }),
      ActiveSessionExistsError,
    );
    await sessions.transition({
      discordGuildId: "session-guild",
      campaignName: "Brumas",
      event: { type: "pause" },
    });
    await assert.rejects(
      sessions.transition({
        discordGuildId: "session-guild",
        campaignName: "Brumas",
        event: { type: "pause" },
      }),
      InvalidSessionTransitionError,
    );
    await assert.rejects(
      sessions.transition({
        discordGuildId: "session-guild",
        campaignName: "Otra",
        event: { type: "pause" },
      }),
      ActiveSessionNotFoundError,
    );

    const active = await database.session.findFirstOrThrow({
      where: { campaign: { server: { discordGuildId: "session-guild" } }, status: "paused" },
      select: { id: true },
    });
    assert.equal(await sessions.failInterrupted([active.id], new Date()), 1);
    assert.equal(
      (await database.session.findUniqueOrThrow({ where: { id: active.id } })).status,
      "failed",
    );
    assert.equal(await sessions.recoverFailed(active.id, new Date()), true);
    assert.equal(
      (await database.session.findUniqueOrThrow({ where: { id: active.id } })).status,
      "completed",
    );

    const recent = await sessions.listRecent("session-guild", "Brumas", 10);
    assert.deepEqual(
      recent.map((session) => session.sequenceNumber),
      [41, 40],
    );
    const removable = await sessions.findBySequence("session-guild", "Brumas", 41);
    assert.notEqual(removable, null);
    await sessions.deleteById(removable!.id);
    const repeated = await sessions.start({
      discordGuildId: "session-guild",
      campaignName: "Brumas",
      voiceChannelId: "voice",
      logChannelId: null,
      occurredAt: new Date(),
    });
    assert.equal(repeated.sequenceNumber, 41);
  });
});
