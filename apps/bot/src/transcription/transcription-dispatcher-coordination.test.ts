import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Logger } from "pino";
import type { Client } from "discord.js";
import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { SessionService } from "../sessions/session-service.ts";
import type { ReprocessIntentStore, ReprocessPhase } from "../sessions/reprocess-intent-store.ts";
import { SessionFileCoordinator } from "../sessions/session-file-coordinator.ts";
import { CampaignFileCoordinator } from "../sessions/campaign-file-coordinator.ts";
import { SessionAdministration } from "../sessions/session-administration.ts";
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import { AudioRetentionManager } from "../storage/audio-retention-manager.ts";
import type { AdaptiveVocabularyStore } from "./adaptive-vocabulary.ts";
import { TranscriptionDispatcher } from "./transcription-dispatcher.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(test: { after(callback: () => Promise<void>): void }, ids = ["session-1"]) {
  const root = await mkdtemp(join(tmpdir(), "dotty-dispatch-lock-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recordings = join(root, "recordings");
  const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const sessions = new Map(ids.map((id) => [id, {
    id, campaignName: "Campaign", discordGuildId: "guild-1", status: "completed",
    logChannelId: null, sequenceNumber: 1,
  }]));
  const manifest = (id: string) => ({
    version: 1, sessionId: id, campaignId: "campaign-1", campaignName: "Campaign",
    discordGuildId: "guild-1", status: "completed",
    endedAt: "2026-01-01T01:00:00.000Z",
    chunks: [{ id: "chunk-1", speakerUserId: "user-1", file: "audio.wav", startedOffsetMs: 0 }],
  });
  for (const id of ids) {
    await mkdir(join(recordings, id), { recursive: true });
    await writeFile(join(recordings, id, "audio.wav"), Buffer.alloc(48, 1));
    await writeFile(join(recordings, id, "manifest.json"), JSON.stringify(manifest(id)));
  }
  let phase: ReprocessPhase | null = null;
  let intentError: Error | null = null;
  const campaigns = {
    findById: async () => ({ name: "Campaign", transcriptionVocabulary: "" }),
    findByGuildAndName: async () => ({ id: "campaign-1" }),
    listMembersByCampaignId: async () => [],
  } as unknown as CampaignService;
  const service = { findById: async (id: string) => sessions.get(id) ?? null } as unknown as SessionService;
  const intents = { read: async (id: string) => {
    if (intentError) throw intentError;
    return phase === null ? null : { version: 1, sessionId: id, phase };
  }, hasPending: async () => phase !== null && phase !== "completed" } as unknown as ReprocessIntentStore;
  const logger = { info() {}, warn() {}, debug() {}, error() {} } as unknown as Logger;
  const createDispatcher = () => new TranscriptionDispatcher(recordings, campaigns, "http://127.0.0.1:8765", "secret",
    { listActive: async () => [] } as unknown as AdaptiveVocabularyStore,
    logger,
    service, coordinator, intents);
  const dispatcher = createDispatcher();
  const admin = new SessionAdministration({ channels: { fetch: async () => null } } as unknown as Client,
    campaigns, { ...service, deleteById: async (id: string) => { sessions.delete(id); } } as SessionService,
    { cancelIfActive: async () => false } as unknown as VoiceCaptureManager,
    recordings, join(root, "exports"), "http://127.0.0.1:8765", "secret", logger,
    intents, coordinator, new CampaignFileCoordinator(join(root, "campaign-locks")));
  return { root, recordings, coordinator, sessions, dispatcher, restart: createDispatcher, intents, admin, manifest,
    setPhase: (value: ReprocessPhase | null) => { phase = value; },
    setIntentError: (error: Error | null) => { intentError = error; },
    path: (id: string, name: string) => join(recordings, id, name) };
}

describe("coordinated transcription dispatch", () => {
  for (const phase of [null, "completed", "prepared", "delete-confirmed", "recovering", "redispatch-ready"] as const) {
    it(`applies provisional intent policy: ${phase ?? "none"}`, async (test) => {
      const f = await fixture(test);
      f.setPhase(phase);
      let posts = 0;
      test.mock.method(globalThis, "fetch", async () => { posts++; return new Response(null, { status: 200 }); });
      await f.dispatcher.dispatchCompleted();
      assert.equal(posts, phase === null || phase === "completed" ? 1 : 0);
      if (posts) {
        await access(f.path("session-1", ".transcription-jobs/chunk-1"));
        await access(f.path("session-1", ".transcription-enqueued"));
        await assert.rejects(access(f.path("session-1", ".transcription-jobs/chunk-1.posting")));
      }
      else await assert.rejects(access(f.path("session-1", ".transcription-jobs")));
    });
  }

  it("blocks corrupt or inaccessible intent", async (test) => {
    const f = await fixture(test);
    f.setIntentError(new Error("corrupt intent"));
    let posts = 0;
    test.mock.method(globalThis, "fetch", async () => { posts++; return new Response(null, { status: 200 }); });
    await f.dispatcher.dispatchCompleted();
    assert.equal(posts, 0);
  });

  for (const change of ["delete", "manifest", "wav"] as const) {
    it(`rechecks ${change} after waiting for the lock`, async (test) => {
      const f = await fixture(test, [`session-${change}`]);
      const id = `session-${change}`;
      const entered = gate(); const release = gate();
      const holding = f.coordinator.runExclusive(id, async () => { entered.release(); await release.promise; });
      await entered.promise;
      let posts = 0;
      test.mock.method(globalThis, "fetch", async () => { posts++; return new Response(null, { status: 200 }); });
      const dispatching = f.dispatcher.dispatchCompleted();
      if (change === "delete") { f.sessions.delete(id); await rm(join(f.recordings, id), { recursive: true }); }
      if (change === "manifest") await writeFile(f.path(id, "manifest.json"), JSON.stringify({ ...f.manifest(id), status: "recording" }));
      if (change === "wav") await rm(f.path(id, "audio.wav"));
      release.release(); await holding; await dispatching;
      assert.equal(posts, 0, change);
      if (change === "delete") await assert.rejects(access(join(f.recordings, id)));
    });
  }

  it("keeps delete behind POST and its accepted marker", async (test) => {
    const f = await fixture(test);
    const posted = gate(); const release = gate();
    test.mock.method(globalThis, "fetch", async () => { posted.release(); await release.promise; return new Response(null, { status: 200 }); });
    const dispatching = f.dispatcher.dispatchCompleted();
    await posted.promise;
    let deleted = false;
    const deleting = f.coordinator.runExclusive("session-1", async () => {
      await access(f.path("session-1", ".transcription-jobs/chunk-1"));
      f.sessions.delete("session-1");
      await rm(join(f.recordings, "session-1"), { recursive: true });
      deleted = true;
    });
    assert.equal(deleted, false);
    release.release(); await dispatching; await deleting;
    assert.equal(deleted, true);
    await assert.rejects(access(join(f.recordings, "session-1")));
  });

  it("makes administrative delete wait for the accepted POST", async (test) => {
    const f = await fixture(test);
    const posted = gate(); const release = gate();
    const calls: string[] = [];
    test.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "DELETE") { calls.push("DELETE"); return new Response(null, { status: 200 }); }
      calls.push("POST"); posted.release(); await release.promise;
      return new Response(null, { status: 200 });
    });
    const dispatching = f.dispatcher.dispatchCompleted();
    await posted.promise;
    const deleting = f.admin.delete("session-1", "guild-1");
    assert.deepEqual(calls, ["POST"]);
    release.release(); await dispatching; await deleting;
    assert.deepEqual(calls, ["POST", "DELETE"]);
    await assert.rejects(access(join(f.recordings, "session-1")));
  });

  it("makes reprocess wait for a POST", async (test) => {
    const f = await fixture(test);
    const posted = gate(); const releasePost = gate(); const deleting = gate(); const releaseDelete = gate();
    const calls: string[] = [];
    test.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "DELETE") {
        calls.push("DELETE"); deleting.release(); await releaseDelete.promise;
        return new Response(null, { status: 200 });
      }
      calls.push("POST"); posted.release(); await releasePost.promise;
      return new Response(null, { status: 200 });
    });
    const firstDispatch = f.dispatcher.dispatchCompleted();
    await posted.promise;
    const reprocessing = f.admin.reprocess("session-1", "guild-1");
    assert.deepEqual(calls, ["POST"]);
    releasePost.release(); await firstDispatch; await deleting.promise;
    assert.deepEqual(calls, ["POST", "DELETE"]);
    releaseDelete.release(); await reprocessing;
    assert.deepEqual(calls, ["POST", "DELETE"]);
    await assert.rejects(access(f.path("session-1", ".transcription-enqueued")));
  });

  it("makes dispatcher wait for reprocess and reject its stale manifest", async (test) => {
    const f = await fixture(test);
    const deleting = gate(); const releaseDelete = gate();
    const calls: string[] = [];
    test.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "DELETE") {
        calls.push("DELETE"); deleting.release(); await releaseDelete.promise;
        return new Response(null, { status: 200 });
      }
      calls.push("POST"); return new Response(null, { status: 200 });
    });
    const reprocessing = f.admin.reprocess("session-1", "guild-1");
    await deleting.promise;
    const dispatching = f.dispatcher.dispatchCompleted();
    assert.deepEqual(calls, ["DELETE"]);
    releaseDelete.release(); await reprocessing; await dispatching;
    assert.deepEqual(calls, ["DELETE"]);
  });

  for (const outcome of ["timeout", "conflict"] as const) {
    it(`blocks rebuilt POST after ${outcome}`, async (test) => {
      const f = await fixture(test);
      let posts = 0;
      test.mock.method(globalThis, "fetch", async () => {
        posts++;
        if (outcome === "timeout") throw new DOMException("timeout", "TimeoutError");
        return new Response(null, { status: 409 });
      });
      await f.dispatcher.dispatchCompleted();
      await access(f.path("session-1", ".transcription-jobs/chunk-1.posting"));
      await f.restart().dispatchCompleted();
      assert.equal(posts, 1);
      await assert.rejects(access(f.path("session-1", ".transcription-enqueued")));
      await assert.rejects(f.admin.delete("session-1", "guild-1"), /aceptación incierta/);
      await assert.rejects(f.admin.reprocess("session-1", "guild-1"), /aceptación incierta/);
      assert.equal((await readFile(f.path("session-1", "audio.wav"))).length, 48);
    });
  }

  it("keeps .posting if an accepted job marker cannot be persisted, including after restart", async (test) => {
    const f = await fixture(test);
    let posts = 0;
    test.mock.method(globalThis, "fetch", async () => {
      posts++;
      await access(f.path("session-1", ".transcription-jobs/chunk-1.posting"));
      await mkdir(f.path("session-1", ".transcription-jobs/chunk-1"));
      return new Response(null, { status: 200 });
    });
    await f.dispatcher.dispatchCompleted();
    await access(f.path("session-1", ".transcription-jobs/chunk-1.posting"));
    await f.restart().dispatchCompleted();
    assert.equal(posts, 1);
    await assert.rejects(f.admin.delete("session-1", "guild-1"), /aceptación incierta/);
    await access(f.path("session-1", "audio.wav"));
  });

  it("retention waits for an uncertain POST and preserves the WAV", async (test) => {
    const f = await fixture(test);
    await writeFile(f.path("session-1", ".transcription-published"), "published");
    const posted = gate(); const release = gate();
    test.mock.method(globalThis, "fetch", async () => {
      await access(f.path("session-1", ".transcription-jobs/chunk-1.posting"));
      posted.release(); await release.promise;
      throw new DOMException("timeout", "TimeoutError");
    });
    const dispatching = f.dispatcher.dispatchCompleted();
    await posted.promise;
    const retention = new AudioRetentionManager(
      { findById: async () => ({ audioRetentionDays: 7 }) } as unknown as CampaignService,
      f.recordings, join(f.root, "exports"),
      { info() {}, error() {} } as unknown as Logger, f.intents, f.coordinator);
    const cleanup = retention.cleanupExpired();
    await access(f.path("session-1", "audio.wav"));
    release.release(); await dispatching;
    assert.equal(await cleanup, 0);
    await access(f.path("session-1", "audio.wav"));
    await access(f.path("session-1", ".transcription-jobs/chunk-1.posting"));
  });

  it("reports lock acquisition failure and leaves the recording untouched", async (test) => {
    const f = await fixture(test);
    const entered = gate(); const release = gate();
    const holding = f.coordinator.runExclusive("session-1", async () => { entered.release(); await release.promise; });
    await entered.promise;
    let posts = 0;
    test.mock.method(globalThis, "fetch", async () => { posts++; return new Response(null, { status: 200 }); });
    await f.dispatcher.dispatchCompleted();
    assert.equal(posts, 0);
    assert.equal((await readFile(f.path("session-1", "audio.wav"))).length, 48);
    release.release(); await holding;
  });

  it("lets distinct sessions progress independently", async (test) => {
    const f = await fixture(test, ["session-1", "session-2"]);
    const entered = gate(); const release = gate();
    const holding = f.coordinator.runExclusive("session-1", async () => { entered.release(); await release.promise; });
    await entered.promise;
    const posts: string[] = [];
    test.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      posts.push((JSON.parse(String(init?.body)) as { id: string }).id);
      return new Response(null, { status: 200 });
    });
    const internal = f.dispatcher as unknown as { dispatchDirectory(directory: string): Promise<void> };
    const first = internal.dispatchDirectory(join(f.recordings, "session-1"));
    await internal.dispatchDirectory(join(f.recordings, "session-2"));
    assert.deepEqual(posts, ["session-2:chunk-1"]);
    release.release(); await holding; await first;
    assert.deepEqual(posts.sort(), ["session-1:chunk-1", "session-2:chunk-1"]);
  });
});

