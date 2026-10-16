import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CampaignFileCoordinator } from "./campaign-file-coordinator.ts";
import { CampaignNotFoundError, type PersistedSession, type SessionRepository, type StartSessionInput } from "./session-repository.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";
import { SessionService } from "./session-service.ts";

const input: StartSessionInput = {
  discordGuildId: "guild-one",
  campaignName: "Campaign One",
  voiceChannelId: "voice-one",
  logChannelId: null,
  occurredAt: new Date("2026-10-16T00:00:00.000Z"),
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const campaign = {
  id: "campaign-one",
  name: "Campaign One",
  defaultVoiceChannelId: null,
  defaultLogChannelId: null,
  nextSessionNumber: 1,
  transcriptionVocabulary: "",
  audioRetentionDays: null,
};

async function fixture(
  test: { after(callback: () => Promise<void>): void },
  options: {
    campaigns?: { findByGuildAndName: (guildId: string, name: string) => Promise<typeof campaign | null> };
    start?: (startInput: StartSessionInput) => Promise<{ id: string }>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "dotty-session-start-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  let starts = 0;
  let created: PersistedSession | undefined;
  const sessions = {
    start: async (startInput: StartSessionInput) => {
      starts += 1;
      const result = await options.start?.(startInput) ?? { id: "session-one" };
      created = {
        id: result.id,
        campaignId: campaign.id,
        sequenceNumber: 1,
        status: "recording",
        startedAt: startInput.occurredAt,
        endedAt: null,
        campaignName: campaign.name,
        voiceChannelId: startInput.voiceChannelId,
        logChannelId: startInput.logChannelId,
      };
      return created;
    },
    findById: async (id: string) => created?.id === id ? {
      id,
      discordGuildId: input.discordGuildId,
      campaignName: campaign.name,
      sequenceNumber: created.sequenceNumber,
      status: created.status,
      voiceChannelId: created.voiceChannelId,
      logChannelId: created.logChannelId,
      startedAt: created.startedAt,
      endedAt: created.endedAt,
    } : null,
  } as unknown as SessionRepository;
  const campaigns = options.campaigns ?? { findByGuildAndName: async () => campaign };
  const coordinator = new CampaignFileCoordinator(root);
  const sessionCoordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const service = new SessionService(sessions, campaigns, coordinator, sessionCoordinator);
  return { service, get starts() { return starts; }, coordinator, sessionCoordinator };
}

describe("SessionService campaign coordination", () => {
  it("creates normally after revalidating the campaign under lock", async (test) => {
    let lookups = 0;
    const f = await fixture(test, {
      campaigns: { findByGuildAndName: async () => { lookups += 1; return campaign; } },
    });
    assert.equal((await f.service.start(input)).id, "session-one");
    assert.equal(lookups, 2);
    assert.equal(f.starts, 1);
  });

  it("rejects a campaign that disappears while waiting for its lock", async (test) => {
    let lookups = 0;
    const f = await fixture(test, {
      campaigns: { findByGuildAndName: async () => ++lookups === 1 ? campaign : null },
    });
    const hold = gate();
    const entered = gate();
    const owner = f.coordinator.runExclusive("campaign-one", async () => { entered.release(); await hold.promise; });
    await entered.promise;
    const start = f.service.start(input);
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(f.starts, 0);
    hold.release();
    await owner;
    await assert.rejects(start, CampaignNotFoundError);
    assert.equal(f.starts, 0);
  });

  it("rejects a missing campaign before attempting creation", async (test) => {
    const f = await fixture(test, {
      campaigns: { findByGuildAndName: async () => null },
    });
    await assert.rejects(f.service.start(input), CampaignNotFoundError);
    assert.equal(f.starts, 0);
  });

  it("serializes concurrent starts for the same campaign", async (test) => {
    const entered = gate();
    const hold = gate();
    let startCalls = 0;
    const f = await fixture(test, {
      start: async () => {
        startCalls += 1;
        if (startCalls === 1) {
          entered.release();
          await hold.promise;
        }
        return { id: `session-${startCalls}` };
      },
    });
    const first = f.service.start(input);
    await entered.promise;
    const second = f.service.start(input);
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(startCalls, 1);
    hold.release();
    await Promise.all([first, second]);
    assert.equal(startCalls, 2);
  });
});