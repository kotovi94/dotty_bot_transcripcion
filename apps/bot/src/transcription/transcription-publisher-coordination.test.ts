import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Logger } from "pino";
import type { Client } from "discord.js";
import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { SessionService } from "../sessions/session-service.ts";
import type { ReprocessIntentStore, ReprocessPhase } from "../sessions/reprocess-intent-store.ts";
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import type { AdaptiveVocabularyStore } from "./adaptive-vocabulary.ts";
import { SessionFileCoordinator } from "../sessions/session-file-coordinator.ts";
import { CampaignFileCoordinator } from "../sessions/campaign-file-coordinator.ts";
import { SessionAdministration } from "../sessions/session-administration.ts";
import { TranscriptionPublisher } from "./transcription-publisher.ts";
import { jobsDigest, parseReadyMarker, transcriptDigest, verifyReadyMarker } from "../../../../packages/shared/src/transcription-ready.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function prepared(init: RequestInit | undefined): Response {
  const { operation_id } = JSON.parse(String(init?.body)) as { operation_id: string };
  const canonical = JSON.stringify({ operation_type: "reprocess", parameters: {}, session_id: "session-1" });
  return new Response(JSON.stringify({ operation_id, session_id: "session-1", operation_type: "reprocess",
    parameters_hash: createHash("sha256").update(canonical).digest("hex"), close_id: "a".repeat(32),
    status: "pending_drain", workers_inactive: null, jobs_deleted: false }), { status: 202 });
}

const job = (id: string) => ({ id: `${id}:chunk-1`, status: "completed", speaker_user_id: "user-1",
  start_offset_ms: 0, completed_at: "2026-01-01T01:00:01+00:00",
  result: { language: "es", segments: [] } });

async function fixture(test: { after(callback: () => Promise<void>): void }, ids = ["session-1"]) {
  const root = await mkdtemp(join(tmpdir(), "dotty-publisher-lock-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recordings = join(root, "recordings");
  const exports = join(root, "exports");
  const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const sessions = new Map(ids.map((id) => [id, { id, discordGuildId: "guild-1", campaignName: "Campaign",
    status: "completed", logChannelId: null, sequenceNumber: 1 }]));
  const manifest = (id: string) => ({ version: 2, sessionId: id, campaignId: "campaign-1",
    campaignName: "Campaign", discordGuildId: "guild-1", status: "completed", sequenceNumber: 1,
    startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:00:00Z",
    chunks: [{ id: "chunk-1", speakerUserId: "user-1", speakerName: "User", file: "audio.wav",
      startedOffsetMs: 0, clipIndex: 1 }], clips: [{ clipIndex: 1, transcriptionStatus: "pending" }] });
  for (const id of ids) {
    const directory = join(recordings, id);
    await mkdir(join(directory, ".transcription-jobs"), { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest(id)));
    await writeFile(join(directory, "audio.wav"), Buffer.alloc(48, 1));
    await writeFile(join(directory, ".transcription-enqueued"), "yes");
    await writeFile(join(directory, ".transcription-jobs", "chunk-1"), "yes");
  }
  let phase: ReprocessPhase | null = null;
  let intentError: Error | null = null;
  const operationId = "4b2aa77f-cc49-4f24-9033-6a48f5f880c1";
  let campaignExists = true;
  let observations = 0;
  let observing: (() => Promise<void>) | null = null;
  const campaigns = { findByGuildAndName: async () => campaignExists ? { id: "campaign-1" } : null,
    findById: async () => campaignExists ? { id: "campaign-1", discordGuildId: "guild-1", name: "Campaign", transcriptionVocabulary: "", audioRetentionDays: 7 } : null,
    listMembersByCampaignId: async () => [], deleteById: async () => { campaignExists = false; } } as unknown as CampaignService;
  const service = { findById: async (id: string) => sessions.get(id) ?? null,
    listByCampaignId: async () => [...sessions.values()],
    deleteById: async (id: string) => { sessions.delete(id); },
    recoverFailed: async () => true } as unknown as SessionService;
  const intents = { read: async (id: string) => {
    if (intentError) throw intentError;
    return phase === null ? null : { version: 1, sessionId: id, phase, operationId };
  }, hasPending: async () => phase !== null && phase !== "completed",
  createWithHeldLock: async (id: string) => { phase = "prepared"; return { version: 1, sessionId: id, phase, operationId }; },
  recoverWithHeldLock: async (id: string) => ({ version: 1, sessionId: id, phase, operationId }),
  } as unknown as ReprocessIntentStore;
  const logger = { info() {}, warn() {}, debug() {}, error() {} } as unknown as Logger;
  const vocabulary = { observe: async () => { observations++; if (observing) await observing(); return []; } } as unknown as AdaptiveVocabularyStore;
  const publisher = new TranscriptionPublisher(campaigns, recordings, exports, "http://127.0.0.1:8765", "secret",
    vocabulary, logger, service, coordinator, intents);
  const admin = new SessionAdministration({ channels: { fetch: async () => null } } as unknown as Client,
    campaigns, service, { cancelIfActive: async () => false } as unknown as VoiceCaptureManager,
    recordings, exports, "http://127.0.0.1:8765", "secret", logger, intents, coordinator,
    new CampaignFileCoordinator(join(root, "campaign-locks")));
  return { root, recordings, exports, coordinator, sessions, publisher, admin, manifest,
    setPhase: (value: ReprocessPhase | null) => { phase = value; },
    setIntentError: (value: Error | null) => { intentError = value; },
    setObserving: (value: (() => Promise<void>) | null) => { observing = value; },
    observations: () => observations,
    path: (id: string, file: string) => join(recordings, id, file) };
}

describe("coordinated transcription publication", () => {
  it("publishes without a reprocess intent", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }));
    await f.publisher.publishReady();
    await access(f.path("session-1", ".transcription-ready"));
  });

  it("publishes normally and accepts completed intent", async (test) => {
    const f = await fixture(test, ["session-1", "session-2"]);
    f.setPhase("completed");
    test.mock.method(globalThis, "fetch", async (url: URL | string) => new Response(JSON.stringify({ jobs: [job(String(url).split("/").at(-1)!)] }), { status: 200 }));
    await f.publisher.publishReady();
    for (const id of ["session-1", "session-2"]) {
      await access(f.path(id, ".transcription-ready"));
      await access(join(f.exports, id, "transcript.raw.json"));
    }
    assert.equal(f.observations(), 2);
  });

  for (const phase of ["prepared", "delete-confirmed", "recovering", "redispatch-ready"] as const) {
    it(`blocks pending intent ${phase}`, async (test) => {
      const f = await fixture(test); f.setPhase(phase);
      test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }));
      await f.publisher.publishReady();
      await assert.rejects(access(f.path("session-1", ".transcription-ready")));
      await assert.rejects(access(join(f.exports, "session-1")));
      assert.equal(f.observations(), 0);
    });
  }

  it("blocks corrupt intent and uncertain .posting", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }));
    f.setIntentError(new Error("corrupt")); await f.publisher.publishReady();
    f.setIntentError(null);
    await writeFile(f.path("session-1", ".transcription-jobs/chunk-1.posting"), "uncertain");
    await f.publisher.publishReady();
    assert.equal(f.observations(), 0);
    await assert.rejects(access(join(f.exports, "session-1")));
  });

  it("does not publish after deletion during GET", async (test) => {
    const f = await fixture(test);
    const fetching = gate(); const release = gate();
    test.mock.method(globalThis, "fetch", async () => { fetching.release(); await release.promise;
      return new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }); });
    const publishing = f.publisher.publishReady(); await fetching.promise;
    f.sessions.delete("session-1"); await rm(f.path("session-1", ""), { recursive: true });
    release.release(); await publishing;
    await assert.rejects(access(f.path("session-1", "")));
    await assert.rejects(access(join(f.exports, "session-1")));
    assert.equal(f.observations(), 0);
  });

  it("rejects changed manifest, unrelated jobs, and .posting before writing", async (test) => {
    const f = await fixture(test);
    const fetching = gate(); const release = gate();
    test.mock.method(globalThis, "fetch", async () => { fetching.release(); await release.promise;
      return new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }); });
    const publishing = f.publisher.publishReady(); await fetching.promise;
    await writeFile(f.path("session-1", "manifest.json"), JSON.stringify({ ...f.manifest("session-1"), sequenceNumber: 2 }));
    release.release(); await publishing;
    await assert.rejects(access(join(f.exports, "session-1")));
  });

  it("blocks mismatched jobs and HTTP errors, but marks a matching failed job", async (test) => {
    const f = await fixture(test);
    const fetchMock = test.mock.method(globalThis, "fetch", async () => new Response("error", { status: 503 }));
    await f.publisher.publishReady();
    assert.equal(f.observations(), 0);
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ jobs: [job("foreign")] }), { status: 200 }));
    await f.publisher.publishReady();
    await assert.rejects(access(join(f.exports, "session-1")));
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ jobs: [{ ...job("session-1"), status: "failed", error: "bad" }] }), { status: 200 }));
    await f.publisher.publishReady();
    await access(f.path("session-1", ".transcription-failed"));
  });

  it("fails closed on unreadable job markers or a recording clip and continues with another session", async (test) => {
    const f = await fixture(test, ["session-1", "session-2"]);
    await rm(f.path("session-1", ".transcription-jobs"), { recursive: true });
    await writeFile(f.path("session-1", ".transcription-jobs"), "not a directory");
    test.mock.method(globalThis, "fetch", async (url: URL | string) =>
      new Response(JSON.stringify({ jobs: [job(String(url).split("/").at(-1)!)] }), { status: 200 }));
    await f.publisher.publishReady();
    await assert.rejects(access(join(f.exports, "session-1")));
    await access(f.path("session-2", ".transcription-ready"));
  });

  it("rejects a chunk whose clip is still recording", async (test) => {
    const f = await fixture(test);
    await writeFile(f.path("session-1", "manifest.json"), JSON.stringify({ ...f.manifest("session-1"),
      clips: [{ clipIndex: 1, transcriptionStatus: "recording" }] }));
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }));
    await f.publisher.publishReady();
    await assert.rejects(access(join(f.exports, "session-1")));
  });

  it("serializes publication with delete and keeps independent sessions moving", async (test) => {
    const f = await fixture(test, ["session-1", "session-2"]);
    const entered = gate(); const release = gate();
    f.setObserving(async () => { entered.release(); await release.promise; });
    test.mock.method(globalThis, "fetch", async (url: URL | string) => new Response(JSON.stringify({ jobs: [job(String(url).split("/").at(-1)!)] }), { status: 200 }));
    const publishing = f.publisher.publishReady(); await entered.promise;
    let deleted = false;
    const deleting = f.coordinator.runExclusive("session-1", async () => { deleted = true; });
    assert.equal(deleted, false);
    release.release(); await publishing; await deleting;
    assert.equal(deleted, true);
    await access(f.path("session-2", ".transcription-ready"));
  });

  for (const action of ["delete", "deleteCampaign", "reprocess"] as const) {
    it(`makes ${action} wait for publication`, async (test) => {
      const f = await fixture(test);
      const entered = gate(); const release = gate();
      f.setObserving(async () => { entered.release(); await release.promise; });
      test.mock.method(globalThis, "fetch", async (url: URL | string, options?: RequestInit) =>
        String(url).endsWith("/job-deletions") ? prepared(options) :
          new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }));
      const publishing = f.publisher.publishReady(); await entered.promise;
      let finished = false;
      const administrative = (action === "delete" ? f.admin.delete("session-1", "guild-1") :
        action === "deleteCampaign" ? f.admin.deleteCampaign("campaign-1", "guild-1") :
          f.admin.reprocess("session-1", "guild-1")).finally(() => { finished = true; });
      assert.equal(finished, false);
      release.release(); await publishing;
      if (action === "reprocess") await administrative;
      else await assert.rejects(administrative, /protocolo de inactividad Python/);
      assert.equal(finished, true);
      if (action === "reprocess") {
        await access(f.path("session-1", "audio.wav"));
        await access(f.path("session-1", ".transcription-ready"));
      } else {
        await access(f.path("session-1", "audio.wav"));
        await access(join(f.exports, "session-1"));
      }
    });
  }

  it("waits for reprocess and rejects its pending intent", async (test) => {
    const f = await fixture(test);
    const fetching = gate(); const release = gate();
    test.mock.method(globalThis, "fetch", async (url: URL | string, options?: RequestInit) => {
      if (String(url).endsWith("/job-deletions")) return prepared(options);
      fetching.release(); await release.promise;
      return new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 });
    });
    const publishing = f.publisher.publishReady(); await fetching.promise;
    await f.admin.reprocess("session-1", "guild-1");
    release.release(); await publishing;
    await assert.rejects(access(f.path("session-1", ".transcription-ready")));
    await assert.rejects(access(join(f.exports, "session-1")));
    assert.equal(f.observations(), 0);
  });

  it("keeps partial export evidence without ready marker", async (test) => {
    const f = await fixture(test);
    await writeFile(f.exports, "blocks-directory");
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }));
    await f.publisher.publishReady();
    assert.equal(f.observations(), 0);
    await assert.rejects(access(f.path("session-1", ".transcription-ready")));
    assert.equal((JSON.parse(await readFile(f.path("session-1", "manifest.json"), "utf8")) as { clips: { transcriptionStatus: string }[] }).clips[0]?.transcriptionStatus, "pending");
  });

  it("does not acquire a nested session lock", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] }), { status: 200 }));
    await f.publisher.publishReady();
    await access(f.path("session-1", ".transcription-ready"));
  });

  it("writes a verifiable v1 marker for exactly the published jobs and final transcript bytes", async (test) => {
    const f = await fixture(test);
    const publishedJob = { ...job("session-1"), result: { language: "es", segments: [{
      start_ms: 0, end_ms: 1200, text: "Hola al grupo.",
      words: [{ text: " Hola", start_ms: 0, end_ms: 300, probability: 0.9 },
        { text: " al", start_ms: 301, end_ms: 500, probability: 0.9 },
        { text: " grupo.", start_ms: 501, end_ms: 1200, probability: 0.9 }],
    }] } };
    let requests = 0;
    test.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response(JSON.stringify({ jobs: [publishedJob] }), { status: 200 });
    });
    await f.publisher.publishReady();
    const content = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    const transcript = await readFile(join(f.exports, "session-1", "bitacora.md"));
    assert.match(transcript.toString("utf8"), /Hola al grupo/u);
    const parsed = parseReadyMarker(content);
    assert.equal(parsed.kind, "verifiable");
    if (parsed.kind !== "verifiable") return;
    assert.equal(parsed.marker.jobs_digest, jobsDigest("session-1", [publishedJob]));
    assert.equal(parsed.marker.transcript_digest, transcriptDigest(transcript));
    assert.equal(verifyReadyMarker(content, "session-1", [publishedJob], transcript), "verified");
    assert.equal(requests, 2);
    assert.equal(content.endsWith("\n"), true);
  });

  it("does not create a marker when writing the transcript fails", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] })));
    const original = fs.rename.bind(fs);
    test.mock.method(fs, "rename", async (source: string, destination: string) => {
      if (destination.endsWith("bitacora.md")) throw new Error("synthetic transcript failure");
      return original(source, destination);
    });
    await f.publisher.publishReady();
    await assert.rejects(access(f.path("session-1", ".transcription-ready")));
  });

  it("does not create a marker when a later artifact fails", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] })));
    const original = fs.rename.bind(fs);
    test.mock.method(fs, "rename", async (source: string, destination: string) => {
      if (destination.endsWith("transcript_full.txt")) throw new Error("synthetic later artifact failure");
      return original(source, destination);
    });
    await f.publisher.publishReady();
    await access(join(f.exports, "session-1", "bitacora.md"));
    await assert.rejects(access(f.path("session-1", ".transcription-ready")));
  });

  it("keeps the publication retryable when marker installation fails", async (test) => {
    const f = await fixture(test);
    const publishedJob = job("session-1");
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [publishedJob] })));
    const original = fs.rename.bind(fs);
    const failure = test.mock.method(fs, "rename", async (source: string, destination: string) => {
      if (destination.endsWith(".transcription-ready")) throw new Error("synthetic marker failure");
      return original(source, destination);
    });
    await f.publisher.publishReady();
    await access(join(f.exports, "session-1", "bitacora.md"));
    await assert.rejects(access(f.path("session-1", ".transcription-ready")));
    failure.mock.restore();
    await f.publisher.publishReady();
    const content = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    const transcript = await readFile(join(f.exports, "session-1", "bitacora.md"));
    assert.equal(verifyReadyMarker(content, "session-1", [publishedJob], transcript), "verified");
  });

  it("keeps the old marker stale and preserves history if replacement is interrupted", async (test) => {
    const f = await fixture(test);
    let current = job("session-1");
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [current] })));
    await f.publisher.publishReady();
    const oldMarker = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    const oldTranscript = await readFile(join(f.exports, "session-1", "bitacora.md"), "utf8");
    current = { ...current, completed_at: "2026-01-01T03:00:01+00:00", result: { language: "en", segments: [] } };
    const original = fs.rename.bind(fs);
    const failure = test.mock.method(fs, "rename", async (source: string, destination: string) => {
      if (destination.endsWith("transcript_full.txt")) throw new Error("synthetic interruption");
      return original(source, destination);
    });
    await f.publisher.publishReady();
    assert.equal(await readFile(f.path("session-1", ".transcription-ready"), "utf8"), oldMarker);
    assert.equal(verifyReadyMarker(oldMarker, "session-1", [current],
      await readFile(join(f.exports, "session-1", "bitacora.md"))), "mismatch");
    const history = join(f.exports, "session-1", "publication-history", createHash("sha256").update(oldMarker).digest("hex"));
    assert.equal(await readFile(join(history, "bitacora.md"), "utf8"), oldTranscript);
    failure.mock.restore();
    await f.publisher.publishReady();
    assert.equal(verifyReadyMarker(await readFile(f.path("session-1", ".transcription-ready"), "utf8"), "session-1",
      [current], await readFile(join(f.exports, "session-1", "bitacora.md"))), "verified");
  });

  it("preserves an existing historical marker and transcript", async (test) => {
    const f = await fixture(test);
    const legacy = "2026-01-01T01:00:02.000Z\n";
    await mkdir(join(f.exports, "session-1"), { recursive: true });
    await writeFile(f.path("session-1", ".transcription-ready"), legacy);
    await writeFile(join(f.exports, "session-1", "bitacora.md"), "historical transcript\n");
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] })));
    await f.publisher.publishReady();
    assert.equal(await readFile(f.path("session-1", ".transcription-ready"), "utf8"), legacy);
    assert.equal(await readFile(join(f.exports, "session-1", "bitacora.md"), "utf8"), "historical transcript\n");
  });

  it("does not regenerate an already verified v1 publication", async (test) => {
    const f = await fixture(test);
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] })));
    await f.publisher.publishReady();
    const before = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    const observations = f.observations();
    await f.publisher.publishReady();
    assert.equal(await readFile(f.path("session-1", ".transcription-ready"), "utf8"), before);
    assert.equal(f.observations(), observations);
  });

  it("preserves a manually changed bitácora when jobs later change without regeneration", async (test) => {
    const f = await fixture(test);
    let current = job("session-1");
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [current] })));
    await f.publisher.publishReady();
    const marker = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    await writeFile(join(f.exports, "session-1", "bitacora.md"), "manual revision\n");
    current = { ...current, result: { language: "en", segments: [] } };
    await f.publisher.publishReady();
    assert.equal(await readFile(join(f.exports, "session-1", "bitacora.md"), "utf8"), "manual revision\n");
    assert.equal(await readFile(f.path("session-1", ".transcription-ready"), "utf8"), marker);
  });

  it("replaces a legacy marker only with explicit regeneration evidence", async (test) => {
    const f = await fixture(test);
    const legacy = "2026-01-01T01:00:02.000Z\n";
    await writeFile(f.path("session-1", ".transcription-ready"), legacy);
    await writeFile(f.path("session-1", ".transcription-regenerating"), "retry");
    await mkdir(join(f.exports, "session-1"), { recursive: true });
    await writeFile(join(f.exports, "session-1", "bitacora.md"), "old transcript\n");
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] })));
    await f.publisher.publishReady();
    const current = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    assert.equal(verifyReadyMarker(current, "session-1", [job("session-1")],
      await readFile(join(f.exports, "session-1", "bitacora.md"))), "verified");
    const history = join(f.exports, "session-1", "publication-history", createHash("sha256").update(legacy).digest("hex"));
    assert.equal(await readFile(join(history, ".transcription-ready"), "utf8"), legacy);
    assert.equal(await readFile(join(history, "bitacora.md"), "utf8"), "old transcript\n");
    await assert.rejects(access(f.path("session-1", ".transcription-regenerating")));
  });

  it("does not replace a marker that appears before installation", async (test) => {
    const f = await fixture(test);
    const legacy = "2026-01-01T01:00:02.000Z\n";
    f.setObserving(async () => { await writeFile(f.path("session-1", ".transcription-ready"), legacy); });
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [job("session-1")] })));
    await f.publisher.publishReady();
    assert.equal(await readFile(f.path("session-1", ".transcription-ready"), "utf8"), legacy);
  });

  it("uses a new digest when retranscription yields different results", async (test) => {
    const f = await fixture(test);
    let current = job("session-1");
    test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jobs: [current] })));
    await f.publisher.publishReady();
    const firstContent = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    const firstTranscript = await readFile(join(f.exports, "session-1", "bitacora.md"), "utf8");
    const first = parseReadyMarker(firstContent);
    assert.equal(first.kind, "verifiable");
    current = { ...current, completed_at: "2026-01-01T02:00:01+00:00",
      result: { language: "en", segments: [] } };
    await f.publisher.publishReady();
    const secondContent = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    const second = parseReadyMarker(secondContent);
    const history = join(f.exports, "session-1", "publication-history", createHash("sha256").update(firstContent).digest("hex"));
    assert.equal(await readFile(join(history, ".transcription-ready"), "utf8"), firstContent);
    assert.equal(await readFile(join(history, "bitacora.md"), "utf8"), firstTranscript);
    assert.equal(second.kind, "verifiable");
    if (first.kind !== "verifiable" || second.kind !== "verifiable") return;
    assert.notEqual(second.marker.jobs_digest, first.marker.jobs_digest);
    assert.equal(verifyReadyMarker(secondContent, "session-1", [current],
      await readFile(join(f.exports, "session-1", "bitacora.md"))), "verified");
  });

  it("does not mark changed jobs as ready and republishes their new snapshot on retry", async (test) => {
    const f = await fixture(test);
    const original = job("session-1");
    const changed = { ...original, completed_at: "2026-01-01T02:00:01+00:00",
      result: { language: "es", segments: [], status: "unintelligible" } };
    let requests = 0;
    test.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response(JSON.stringify({ jobs: [requests === 1 ? original : changed] }));
    });
    await f.publisher.publishReady();
    await access(join(f.exports, "session-1", "bitacora.md"));
    await assert.rejects(access(f.path("session-1", ".transcription-ready")));
    await f.publisher.publishReady();
    const content = await readFile(f.path("session-1", ".transcription-ready"), "utf8");
    assert.equal(verifyReadyMarker(content, "session-1", [changed],
      await readFile(join(f.exports, "session-1", "bitacora.md"))), "verified");
    assert.equal(requests, 4);
  });
});
