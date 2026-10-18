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
import { PythonInactivityDeletionError, SessionAdministration, SessionDeletionError } from "./session-administration.ts";
import { CampaignFileCoordinator } from "./campaign-file-coordinator.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";
import { SessionService } from "./session-service.ts";
import { CampaignNotFoundError, type SessionRepository, type StartSessionInput } from "./session-repository.ts";

const fakeAudio = (id: string) => `audio-${id}`.repeat(8);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

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
  const campaignCoordinator = new CampaignFileCoordinator(join(root, "campaign-locks"));
  const calls: string[] = [];
  let campaignExists = true;
  const campaign = { id: "campaign-1", discordGuildId: "guild-1", name: "Test", audioRetentionDays: 7 };
  const campaigns = {
    findById: async () => campaignExists ? campaign : null,
    findByGuildAndName: async () => campaignExists ? {
      id: campaign.id,
      name: campaign.name,
      defaultVoiceChannelId: null,
      defaultLogChannelId: null,
      nextSessionNumber: 1,
      transcriptionVocabulary: "",
      audioRetentionDays: campaign.audioRetentionDays,
    } : null,
    deleteById: async () => { calls.push("campaign-deleted"); campaignExists = false; },
  } as unknown as CampaignService;
  const service = {
    findById: async (id: string) => sessions.get(id) ?? null,
    listByCampaignId: async () => [...sessions.values()],
    deleteById: async (id: string) => { calls.push(`db:${id}`); sessions.delete(id); },
  } as unknown as SessionService;
  const intents = new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator,
    new ReprocessIntentEligibility(service, recordings));
  const errors: Array<{ context: unknown; message: string | undefined }> = [];
  const logger = {
    info() {},
    error(context: unknown, message?: string) { errors.push({ context, message }); },
  } as unknown as Logger;
  const captureManager = { cancelIfActive: async () => false } as unknown as VoiceCaptureManager;
  const admin = new SessionAdministration(
    { channels: { fetch: async () => null } } as unknown as Client,
    campaigns, service, captureManager, recordings, exports,
    "http://127.0.0.1:8765", "secret", logger, intents, coordinator, campaignCoordinator,
  );
  return { root, recordings, exports, sessions, coordinator, campaignCoordinator, captureManager, intents, calls, campaigns, service, logger, errors, admin,
    wav: (id = "session-1") => join(recordings, id, "audio.wav") };
}

describe("administrative deletion protection", () => {
  it("blocks individual and campaign deletion when .posting survives", async (test) => {
    const f = await fixture(test, ["session-1", "session-2"]);
    const jobDirectory = join(f.recordings, "session-2", ".transcription-jobs");
    await mkdir(jobDirectory);
    await writeFile(join(jobDirectory, "chunk-1.posting"), "uncertain");
    let deletes = 0;
    test.mock.method(globalThis, "fetch", async () => { deletes++; return new Response(null, { status: 200 }); });
    await assert.rejects(f.admin.delete("session-2", "guild-1"), /aceptación incierta/);
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), /aceptación incierta/);
    assert.equal(deletes, 0);
    await access(f.wav("session-1"));
    await access(f.wav("session-2"));
  });

  it("fails closed when job marker directory cannot be read", async (test) => {
    const f = await fixture(test);
    await writeFile(join(f.recordings, "session-1", ".transcription-jobs"), "not a directory");
    await assert.rejects(f.admin.delete("session-1", "guild-1"), /No se pudo verificar el despacho/);
    await assert.rejects(f.admin.reprocess("session-1", "guild-1"), /No se pudo verificar el despacho/);
    await access(f.wav());
  });
  it("blocks an otherwise eligible session before any destructive effect, even if Python DELETE would return 200", async (test) => {
    const f = await fixture(test);
    let requests = 0;
    test.mock.method(globalThis, "fetch", async () => { requests++; return new Response(null, { status: 200 }); });
    await assert.rejects(f.admin.delete("session-1", "guild-1"), (error: unknown) =>
      error instanceof PythonInactivityDeletionError && error.code === "PYTHON_INACTIVITY_PROTOCOL_PENDING");
    assert.equal(requests, 0);
    assert.deepEqual(f.calls, []);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
  });

  for (const outcome of ["timeout", "disconnected"] as const) {
    it(`blocks deletion before contacting a ${outcome} transcriber`, async (test) => {
      const f = await fixture(test);
      let requests = 0;
      test.mock.method(globalThis, "fetch", async () => {
        requests++;
        throw new Error(outcome);
      });
      await assert.rejects(f.admin.delete("session-1", "guild-1"), PythonInactivityDeletionError);
      assert.equal(requests, 0);
      assert.deepEqual(f.calls, []);
      await access(f.wav());
    });
  }

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
        await assert.rejects(f.admin.delete("session-1", "guild-1"), PythonInactivityDeletionError);
        assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
        assert.equal(requests, 0);
        assert.deepEqual(f.calls, []);
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

  it("aborts before capture cancellation for an active DB session", async (test) => {
    const f = await fixture(test);
    f.sessions.set("session-1", { ...f.sessions.get("session-1")!, status: "finalizing" });
    await assert.rejects(f.admin.delete("session-1", "guild-1"), PythonInactivityDeletionError);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
    assert.deepEqual(f.calls, []);
  });

  it("protects a campaign session through delete without deleting the campaign", async (test) => {
    const f = await fixture(test, ["session-1", "session-2"]);
    await f.intents.create("session-1");
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), /reprocesamiento pendiente/);
    assert.equal(await readFile(f.wav("session-1"), "utf8"), fakeAudio("session-1"));
    assert.equal(await readFile(f.wav("session-2"), "utf8"), fakeAudio("session-2"));
    assert.deepEqual(f.calls, []);
  });

  it("deletes a campaign without sessions", async (test) => {
    const f = await fixture(test, []);
    const result = await f.admin.deleteCampaign("campaign-1", "guild-1");
    assert.deepEqual(result, { campaignName: "Test", sessionCount: 0 });
    assert.deepEqual(f.calls, ["campaign-deleted"]);
    assert.deepEqual(f.errors, []);
  });

  it("rejects an eligible campaign before deleting any session", async (test) => {
    const f = await fixture(test, ["session-z", "session-a", "session-m"]);
    let requests = 0;
    test.mock.method(globalThis, "fetch", async () => { requests++; return new Response(null, { status: 200 }); });
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), PythonInactivityDeletionError);
    assert.equal(requests, 0);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.errors, []);
    for (const id of ["session-a", "session-m", "session-z"]) await access(f.wav(id));
  });

  for (const protectedId of ["session-a", "session-b", "session-c"]) {
    it(`aborts before effects when ${protectedId} has a pending intent`, async (test) => {
      const ids = ["session-a", "session-b", "session-c"];
      const f = await fixture(test, ids);
      let requests = 0;
      test.mock.method(globalThis, "fetch", async () => { requests += 1; return new Response(null, { status: 200 }); });
      await f.intents.create(protectedId);
      await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), /reprocesamiento pendiente/);
      assert.equal(requests, 0);
      assert.deepEqual(f.calls, []);
      for (const id of ids) assert.equal(await readFile(f.wav(id), "utf8"), fakeAudio(id));
    });
  }

  for (const uncertainty of ["corrupt", "interrupted"] as const) {
    it(`aborts before effects when a campaign intent is ${uncertainty}`, async (test) => {
      const f = await fixture(test, ["session-a", "session-b"]);
      const path = f.intents.pathFor("session-b");
      await mkdir(join(f.root, "reprocess-intents"), { recursive: true });
      if (uncertainty === "corrupt") await writeFile(path, "not-json");
      else await writeFile(`${path}.interrupted.tmp`, "uncommitted");
      await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), SessionDeletionError);
      assert.deepEqual(f.calls, []);
      for (const id of ["session-a", "session-b"]) assert.equal(await readFile(f.wav(id), "utf8"), fakeAudio(id));
    });
  }

  it("times out on the campaign lock before inspecting or deleting anything", async (test) => {
    const f = await fixture(test, ["session-a"]);
    await mkdir(join(f.root, "campaign-locks"), { recursive: true });
    const path = f.campaignCoordinator.pathFor("campaign-1");
    await writeFile(path, "abandoned campaign lock");
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), /Timed out waiting for campaign lock/);
    assert.equal(await readFile(path, "utf8"), "abandoned campaign lock");
    assert.equal(await readFile(f.wav("session-a"), "utf8"), fakeAudio("session-a"));
    assert.deepEqual(f.calls, []);
  });

  it("releases earlier session locks and performs no effects if a later session lock times out", async (test) => {
    const f = await fixture(test, ["session-a", "session-b", "session-c"]);
    await mkdir(join(f.root, "session-locks"), { recursive: true });
    const blockedPath = f.coordinator.pathFor("session-b");
    await writeFile(blockedPath, "abandoned session lock");
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), /Timed out waiting for session lock/);
    assert.equal(await readFile(blockedPath, "utf8"), "abandoned session lock");
    await assert.rejects(access(f.coordinator.pathFor("session-a")));
    await assert.rejects(access(f.campaignCoordinator.pathFor("campaign-1")));
    assert.deepEqual(f.calls, []);
    for (const id of ["session-a", "session-b", "session-c"]) assert.equal(await readFile(f.wav(id), "utf8"), fakeAudio(id));
  });

  it("holds the campaign lock against a concurrent new session start", async (test) => {
    const f = await fixture(test, []);
    const enteredDelete = gate();
    const resumeDelete = gate();
    const deleteCampaign = f.campaigns.deleteById.bind(f.campaigns);
    f.campaigns.deleteById = async (id: string) => {
      enteredDelete.release();
      await resumeDelete.promise;
      await deleteCampaign(id);
    };
    let starts = 0;
    const starter = new SessionService(
      { start: async () => { starts += 1; return {} as never; } } as unknown as SessionRepository,
      f.campaigns,
      f.campaignCoordinator,
      f.coordinator,
    );
    const deletion = f.admin.deleteCampaign("campaign-1", "guild-1");
    await enteredDelete.promise;
    const startInput: StartSessionInput = {
      discordGuildId: "guild-1",
      campaignName: "Test",
      voiceChannelId: "voice-1",
      logChannelId: null,
      occurredAt: new Date(),
    };
    const start = starter.start(startInput);
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(starts, 0);
    resumeDelete.release();
    await deletion;
    await assert.rejects(start, CampaignNotFoundError);
    assert.equal(starts, 0);
  });

  it("waits for a concurrent intent creation, then aborts before effects", async (test) => {
    const f = await fixture(test, ["session-a", "session-b"]);
    const enteredCreate = gate();
    const resumeCreate = gate();
    const original = f.coordinator.runExclusive.bind(f.coordinator);
    let blockCreate = true;
    f.coordinator.runExclusive = <T>(
      id: string,
      action: () => Promise<T>,
      options?: Parameters<SessionFileCoordinator["runExclusive"]>[2],
    ) => original(id, async () => {
      if (id === "session-b" && blockCreate) {
        blockCreate = false;
        enteredCreate.release();
        await resumeCreate.promise;
      }
      return action();
    }, options);
    const create = f.intents.create("session-b");
    await enteredCreate.promise;
    const deletion = f.admin.deleteCampaign("campaign-1", "guild-1");
    await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(f.calls, []);
    resumeCreate.release();
    await create;
    await assert.rejects(deletion, /reprocesamiento pendiente/);
    assert.deepEqual(f.calls, []);
    for (const id of ["session-a", "session-b"]) assert.equal(await readFile(f.wav(id), "utf8"), fakeAudio(id));
  });

  it("waits for concurrent individual deletion and keeps the campaign intact", async (test) => {
    const f = await fixture(test, ["session-a", "session-b"]);
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    const enteredDelete = gate();
    const resumeDelete = gate();
    const originalFind = f.service.findById.bind(f.service);
    let blockFirst = true;
    f.service.findById = async (id: string) => {
      if (id === "session-a" && blockFirst) {
        blockFirst = false;
        enteredDelete.release();
        await resumeDelete.promise;
      }
      return originalFind(id);
    };
    const individual = f.admin.delete("session-a", "guild-1");
    await enteredDelete.promise;
    const listed = gate();
    const originalList = f.service.listByCampaignId.bind(f.service);
    f.service.listByCampaignId = async (id: string) => {
      const result = await originalList(id);
      listed.release();
      return result;
    };
    const campaign = f.admin.deleteCampaign("campaign-1", "guild-1");
    await listed.promise;
    assert.deepEqual(f.calls, []);
    resumeDelete.release();
    await assert.rejects(individual, PythonInactivityDeletionError);
    await assert.rejects(campaign, PythonInactivityDeletionError);
    assert.deepEqual(f.calls, []);
    assert.equal(await readFile(f.wav("session-a"), "utf8"), fakeAudio("session-a"));
    assert.equal(await readFile(f.wav("session-b"), "utf8"), fakeAudio("session-b"));
  });

  it("aborts before effects if session status changes during preflight", async (test) => {
    const f = await fixture(test, ["session-a"]);
    const session = f.sessions.get("session-a")!;
    f.service.findById = async () => ({
      ...session,
      status: "recording",
      voiceChannelId: null,
      startedAt: null,
      endedAt: null,
    });
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), /cambió o tiene un estado incierto/);
    assert.equal(await readFile(f.wav("session-a"), "utf8"), fakeAudio("session-a"));
    assert.deepEqual(f.calls, []);
  });

  it("rejects before reaching a later database failure or any partial campaign effects", async (test) => {
    const f = await fixture(test, ["session-b", "session-a"]);
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    const deleteById = f.service.deleteById.bind(f.service);
    f.service.deleteById = async (id: string) => {
      if (id === "session-b") throw new Error("database unavailable");
      await deleteById(id);
    };
    await assert.rejects(f.admin.deleteCampaign("campaign-1", "guild-1"), PythonInactivityDeletionError);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.errors, []);
    await access(f.wav("session-a"));
    await access(f.wav("session-b"));
    assert.equal(f.sessions.has("session-b"), true);
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
    await assert.rejects(deletion, PythonInactivityDeletionError);
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

  it("allows intent creation after a blocked administrative deletion", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    await assert.rejects(f.admin.delete("session-1", "guild-1"), PythonInactivityDeletionError);
    await f.intents.create("session-1");
    assert.equal((await f.intents.read("session-1"))?.phase, "prepared");
  });

  it("allows intent creation after retention preserves the WAV", async (test) => {
    const f = await fixture(test);
    const retention = new AudioRetentionManager(f.campaigns, f.recordings, f.exports, f.logger, f.intents, f.coordinator);
    assert.equal(await retention.cleanupExpired(), 0);
    await f.intents.create("session-1");
    assert.equal((await f.intents.read("session-1"))?.phase, "prepared");
    await access(f.wav());
  });

  it("keeps an active capture from another session untouched", async (test) => {
    const f = await fixture(test);
    f.sessions.set("session-1", { ...f.sessions.get("session-1")!, status: "recording" });
    const captureManager = {
      cancelIfActive: async (guildId: string, sessionId: string) => {
        f.calls.push(`cancel:${guildId}:${sessionId}`);
        throw new Error(`capture mismatch: ${sessionId}`);
      },
    } as unknown as VoiceCaptureManager;
    const admin = new SessionAdministration(
      { channels: { fetch: async () => null } } as unknown as Client,
      f.campaigns, f.service,
      captureManager,
      f.recordings, f.exports, "http://127.0.0.1:8765", "secret", f.logger, f.intents, f.coordinator, f.campaignCoordinator,
    );
    await assert.rejects(admin.delete("session-1", "guild-1"), PythonInactivityDeletionError);
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
      { cancelIfActive: async () => false } as unknown as VoiceCaptureManager, f.recordings, f.exports, "http://127.0.0.1:8765", "secret",
      f.logger, f.intents, f.coordinator, f.campaignCoordinator,
    );
    test.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    await assert.rejects(admin.delete("session-1", "guild-1"), PythonInactivityDeletionError);
    assert.equal(await readFile(f.wav(), "utf8"), fakeAudio("session-1"));
    assert.deepEqual(f.calls, []);
  });
});
