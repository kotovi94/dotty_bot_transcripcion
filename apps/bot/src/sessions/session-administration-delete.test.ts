import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Client } from "discord.js";
import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import { AudioRetentionManager } from "../storage/audio-retention-manager.ts";
import { ReprocessIntentStore } from "./reprocess-intent-store.ts";
import { ReprocessIntentEligibility } from "./reprocess-intent-eligibility.ts";
import { SessionAdministration, SessionDeletionError } from "./session-administration.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";
import type { SessionService } from "./session-service.ts";

const fakeAudio = (id: string) => `audio-${id}`.repeat(8);

async function fixture(test: { after(callback: () => Promise<void>): void }, ids = ["session-1"]) {
  const root = await mkdtemp(join(tmpdir(), "dotty-admin-delete-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recordings = join(root, "recordings");
  const exports = join(root, "exports");
  const sessions = new Map(ids.map((id) => [id, {
    id, campaignId: "campaign-1", discordGuildId: "guild-1", status: "completed",
    logChannelId: null, sequenceNumber: 1, campaignName: "Test",
  }]));
  for (const id of ids) {
    const directory = join(recordings, id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "audio.wav"), fakeAudio(id));
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      version: 2, sessionId: id, campaignId: "campaign-1", discordGuildId: "guild-1", status: "completed",
      endedAt: "2026-01-01T00:00:00.000Z", chunks: [{ file: "audio.wav" }],
    }));
    await writeFile(join(directory, ".transcription-published"), "published");
  }
  const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const calls: string[] = [];
  const campaign = { id: "campaign-1", discordGuildId: "guild-1", name: "Test", audioRetentionDays: 7 };
  const campaigns = {
    findById: async () => campaign,
    deleteById: async () => { calls.push("campaign-deleted"); },
  } as unknown as CampaignService;
  const service = {
    findById: async (id: string) => sessions.get(id) ?? null,
    listByCampaignId: async () => [...sessions.values()],
    deleteById: async (id: string) => { calls.push(`db:${id}`); sessions.delete(id); },
  } as unknown as SessionService;
  const intents = new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator,
    new ReprocessIntentEligibility(service, recordings));
  const logger = { info() {}, error() {} } as unknown as Logger;
  const admin = new SessionAdministration(
    { channels: { fetch: async () => null } } as unknown as Client,
    campaigns, service, {} as VoiceCaptureManager, recordings, exports,
    "http://127.0.0.1:8765", "secret", logger, intents, coordinator,
  );
  return { root, recordings, exports, sessions, coordinator, intents, calls, campaigns, service, logger, admin,
    wav: (id = "session-1") => join(recordings, id, "audio.wav") };
}

describe("administrative deletion protection", () => {
  it("deletes a session with no intent after checking it", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    await f.admin.delete("session-1", "guild-1");
    await assert.rejects(access(f.wav()));
    assert.deepEqual(f.calls, ["db:session-1"]);
  });

  for (const phase of ["prepared", "delete-confirmed", "recovering", "redispatch-ready", "completed"] as const) {
    it(`checks intent phase ${phase} before administrative deletion`, async (test) => {
      const f = await fixture(test);
      let requests = 0;
      test.mock.method(globalThis, "fetch", async () => { requests++; return new Response(null, { status: 200 }); });
      const created = await f.intents.create("session-1");
      for (const next of ["delete-confirmed", "recovering", "redispatch-ready", "completed"] as const) {
        if (phase === "prepared") break;
        await f.intents.updatePhase("session-1", created.operationId, next);
        if (phase === next) break;
      }
      if (phase === "completed") {
        await f.admin.delete("session-1", "guild-1");
        await assert.rejects(access(f.wav()));
        assert.equal(requests, 1);
      } else {
        await assert.rejects(f.admin.delete("session-1", "guild-1"), SessionDeletionError);
        assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
        assert.equal(requests, 0);
        assert.deepEqual(f.calls, []);
      }
    });
  }

  it("blocks corrupt and ambiguous intent files before side effects", async (test) => {
    const f = await fixture(test);
    let requests = 0;
    test.mock.method(globalThis, "fetch", async () => { requests++; return new Response(null, { status: 200 }); });
    await mkdir(join(f.root, "reprocess-intents"));
    const path = f.intents.pathFor("session-1");
    await writeFile(path, "corrupt");
    await assert.rejects(f.admin.delete("session-1", "guild-1"), (error: unknown) =>
      error instanceof SessionDeletionError && error.cause instanceof Error);
    await rm(path);
    await writeFile(`${path}.interrupted.tmp`, "uncommitted");
    await assert.rejects(f.admin.delete("session-1", "guild-1"), SessionDeletionError);
    assert.equal(requests, 0);
    assert.deepEqual(f.calls, []);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
  });

  it("times out on an abandoned shared lock without touching the session", async (test) => {
    const f = await fixture(test);
    await mkdir(join(f.root, "session-locks"));
    const lock = f.coordinator.pathFor("session-1");
    await writeFile(lock, "abandoned");
    await assert.rejects(f.admin.delete("session-1", "guild-1"), /Timed out.*inspect/);
    assert.equal(await readFile(lock, "utf8"), "abandoned");
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
    assert.deepEqual(f.calls, []);
  });

  it("revalidates the session inside the lock", async (test) => {
    const f = await fixture(test);
    f.sessions.delete("session-1");
    await assert.rejects(f.admin.delete("session-1", "guild-1"), /ya no existe/);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
  });

  it("protects a campaign session through delete without deleting the campaign", async (test) => {
    const f = await fixture(test, ["session-1", "session-2"]);
    await f.intents.create("session-1");
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), /reprocesamiento pendiente/);
    assert.equal(await readFile(f.wav("session-1"), "utf8"), fakeAudio("session-1"));
    assert.equal(await readFile(f.wav("session-2"), "utf8"), fakeAudio("session-2"));
    assert.deepEqual(f.calls, []);
  });

  it("serializes deletion with retention", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.service.findById.bind(f.service);
    f.service.findById = async (id: string) => { entered(); await gate; return original(id); };
    const deletion = f.admin.delete("session-1", "guild-1");
    await inside;
    const retention = new AudioRetentionManager(f.campaigns, f.recordings, f.exports, f.logger, f.intents, f.coordinator);
    const cleanup = retention.cleanupExpired();
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
    release();
    await deletion;
    assert.equal(await cleanup, 0);
  });

  it("a concurrent intent created first blocks administrative deletion", async (test) => {
    const f = await fixture(test);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.coordinator.runExclusive.bind(f.coordinator);
    let first = true;
    f.coordinator.runExclusive = <T>(id: string, action: () => Promise<T>, options?: Parameters<SessionFileCoordinator["runExclusive"]>[2]) =>
      original(id, async () => {
        if (first) { first = false; entered(); await gate; }
        return action();
      }, options);
    const create = f.intents.create("session-1");
    await inside;
    const deletion = f.admin.delete("session-1", "guild-1");
    release();
    await create;
    await assert.rejects(deletion, /reprocesamiento pendiente/);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
  });

  it("rejects intent creation after administrative deletion wins the lock", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    await f.admin.delete("session-1", "guild-1");
    await assert.rejects(f.intents.create("session-1"), /missing or cannot be reprocessed/);
    assert.equal(await f.intents.read("session-1"), null);
  });

  it("rejects intent creation after retention wins the lock", async (test) => {
    const f = await fixture(test);
    const retention = new AudioRetentionManager(f.campaigns, f.recordings, f.exports, f.logger, f.intents, f.coordinator);
    assert.equal(await retention.cleanupExpired(), 1);
    await assert.rejects(f.intents.create("session-1"), /Original audio was purged/);
    assert.equal(await f.intents.read("session-1"), null);
  });

  it("keeps an active capture from another session untouched", async (test) => {
    const f = await fixture(test);
    f.sessions.set("session-1", { ...f.sessions.get("session-1")!, status: "recording" });
    const admin = new SessionAdministration(
      { channels: { fetch: async () => null } } as unknown as Client,
      f.campaigns, f.service,
      { cancel: async (_guild: string, sessionId: string) => { throw new Error(`capture mismatch: ${sessionId}`); } } as unknown as VoiceCaptureManager,
      f.recordings, f.exports, "http://127.0.0.1:8765", "secret", f.logger, f.intents, f.coordinator,
    );
    await assert.rejects(admin.delete("session-1", "guild-1"), /capture mismatch/);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
    assert.deepEqual(f.calls, []);
  });

  it("preserves the original diagnostic if deletion fails", async (test) => {
    const f = await fixture(test);
    const failure = new Error("Discord unavailable");
    const admin = new SessionAdministration(
      { channels: { fetch: async () => { throw failure; } } } as unknown as Client,
      f.campaigns,
      { ...f.service, findById: async (id: string) => ({ ...f.sessions.get(id)!, logChannelId: "log" }) } as unknown as SessionService,
      {} as VoiceCaptureManager, f.recordings, f.exports, "http://127.0.0.1:8765", "secret",
      f.logger, f.intents, f.coordinator,
    );
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    await assert.rejects(admin.delete("session-1", "guild-1"), (error: unknown) => error === failure);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
    assert.deepEqual(f.calls, []);
  });
});
