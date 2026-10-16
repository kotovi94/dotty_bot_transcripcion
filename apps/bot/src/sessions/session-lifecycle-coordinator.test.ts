import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Guild } from "discord.js";

import { applySessionEvent } from "../domain/session.ts";
import { CaptureClosureError, type CaptureShutdownReport, type VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import { CampaignFileCoordinator } from "./campaign-file-coordinator.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";
import { SessionLifecycleCoordinator, SessionLifecycleError } from "./session-lifecycle-coordinator.ts";
import { type ManagedSession, type PersistedSession, type SessionRepository, type StartSessionInput } from "./session-repository.ts";
import { SessionService } from "./session-service.ts";

const defaultInput: StartSessionInput = {
  discordGuildId: "guild-one",
  campaignName: "Campaign One",
  voiceChannelId: "voice-one",
  logChannelId: null,
  occurredAt: new Date("2026-10-16T00:00:00.000Z"),
};

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  return { promise, release, entered, enteredPromise };
}

function guild(id: string): Guild {
  return { id } as Guild;
}

async function fixture(
  test: { after(callback: () => Promise<void>): void },
  initial?: { session: ManagedSession; campaignId: string },
) {
  const root = await mkdtemp(join(tmpdir(), "dotty-lifecycle-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const campaignByKey = new Map<string, { id: string; name: string }>([
    ["guild-one:Campaign One", { id: "campaign-one", name: "Campaign One" }],
    ["guild-two:Campaign Two", { id: "campaign-two", name: "Campaign Two" }],
  ]);
  const records = new Map<string, { session: ManagedSession; campaignId: string }>();
  if (initial !== undefined) records.set(initial.session.id, initial);
  let nextSequence = 1;
  let startAction: ((session: PersistedSession) => Promise<void>) | undefined;
  let pauseAction: (() => Promise<void>) | undefined;
  let resumeAction: (() => Promise<void>) | undefined;
  let finishAction: (() => Promise<void>) | undefined;
  let transitionCalls = 0;
  const events: string[] = [];

  const repository = {
    start: async (input: StartSessionInput): Promise<PersistedSession> => {
      const campaign = campaignByKey.get(`${input.discordGuildId}:${input.campaignName}`);
      if (campaign === undefined) throw new Error("campaign missing");
      const id = `session-${input.discordGuildId}-${nextSequence++}`;
      const created: ManagedSession = {
        id,
        discordGuildId: input.discordGuildId,
        campaignName: campaign.name,
        sequenceNumber: nextSequence,
        status: "recording",
        voiceChannelId: input.voiceChannelId,
        logChannelId: input.logChannelId,
        startedAt: input.occurredAt,
        endedAt: null,
      };
      records.set(id, { session: created, campaignId: campaign.id });
      return {
        ...created,
        campaignId: campaign.id,
      };
    },
    transition: async (input: { discordGuildId: string; campaignName: string; event: Parameters<typeof applySessionEvent>[1] }) => {
  transitionCalls += 1;
      const current = [...records.values()].find(({ session }) =>
        session.discordGuildId === input.discordGuildId &&
        session.campaignName === input.campaignName &&
        ["recording", "paused", "finalizing"].includes(session.status),
      );
      if (current === undefined) throw new Error("active session missing");
      const next = applySessionEvent({
        id: current.session.id,
        campaignId: current.campaignId,
        sequenceNumber: current.session.sequenceNumber,
        status: current.session.status,
        startedAt: current.session.startedAt,
        endedAt: current.session.endedAt,
      }, input.event);
      current.session = { ...current.session, status: next.status, startedAt: next.startedAt, endedAt: next.endedAt };
      events.push(`db:${input.event.type}:${current.session.id}`);
      return { ...next, campaignName: current.session.campaignName, voiceChannelId: current.session.voiceChannelId, logChannelId: current.session.logChannelId };
    },
    findById: async (sessionId: string) => records.get(sessionId)?.session ?? null,
    findActive: async (discordGuildId: string, campaignName: string) => [...records.values()]
      .map((entry) => entry.session)
      .filter((session) => session.discordGuildId === discordGuildId && session.campaignName === campaignName && ["recording", "paused", "finalizing"].includes(session.status))
      .sort((left, right) => right.sequenceNumber - left.sequenceNumber)[0] ?? null,
  } as unknown as SessionRepository;
  const campaigns = {
    findByGuildAndName: async (discordGuildId: string, campaignName: string) => {
      const campaign = campaignByKey.get(`${discordGuildId}:${campaignName}`);
      return campaign === undefined ? null : {
        ...campaign,
        defaultVoiceChannelId: "voice-one",
        defaultLogChannelId: null,
        nextSessionNumber: 1,
        transcriptionVocabulary: "",
        audioRetentionDays: null,
      };
    },
  };
  const campaignCoordinator = new CampaignFileCoordinator(join(root, "campaign-locks"));
  const sessionCoordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const service = new SessionService(repository, campaigns, campaignCoordinator, sessionCoordinator);
  let wavPreserved = true;
  const recordings = {
    assertTransitionAllowed: (_guildId: string, sessionId: string, transition: string) => {
      events.push(`guard:${transition}:${sessionId}`);
    },
    start: async (_guild: Guild, session: PersistedSession) => {
      events.push(`capture:start:${session.id}`);
      await startAction?.(session);
    },
    pause: async () => { events.push("capture:pause"); await pauseAction?.(); },
    resume: async () => { events.push("capture:resume"); await resumeAction?.(); },
    finish: async () => { events.push("capture:finish"); await finishAction?.(); },
    shutdown: async (runExclusive?: <T>(sessionId: string, action: () => Promise<T>) => Promise<T>): Promise<CaptureShutdownReport> => {
      events.push("capture:shutdown-called");
      const closedSessionIds: string[] = [];
      for (const { session } of records.values()) {
        if (!["recording", "paused", "finalizing"].includes(session.status)) continue;
        const close = async () => { events.push(`capture:shutdown:${session.id}`); };
        if (runExclusive === undefined) await close();
        else await runExclusive(session.id, close);
        closedSessionIds.push(session.id);
      }
      return { closedSessionIds, failedCaptures: [], uncertainCaptures: [] };
    },
  } as unknown as VoiceCaptureManager;
  const lifecycle = new SessionLifecycleCoordinator(service, sessionCoordinator, recordings);
  return {
    root,
    service,
    lifecycle,
    campaignCoordinator,
    sessionCoordinator,
    recordings,
    records,
    events,
    get transitionCalls() { return transitionCalls; },
    get wavPreserved() { return wavPreserved; },
    set startAction(value: ((session: PersistedSession) => Promise<void>) | undefined) { startAction = value; },
    set pauseAction(value: (() => Promise<void>) | undefined) { pauseAction = value; },
    set resumeAction(value: (() => Promise<void>) | undefined) { resumeAction = value; },
    set finishAction(value: (() => Promise<void>) | undefined) { finishAction = value; },
    set wavPreserved(value: boolean) { wavPreserved = value; },
  };
}

function initialSession(status: ManagedSession["status"] = "recording"): { session: ManagedSession; campaignId: string } {
  return {
    campaignId: "campaign-one",
    session: {
      id: "session-one",
      discordGuildId: "guild-one",
      campaignName: "Campaign One",
      sequenceNumber: 1,
      status,
      voiceChannelId: "voice-one",
      logChannelId: null,
      startedAt: new Date("2026-10-16T00:00:00.000Z"),
      endedAt: null,
    },
  };
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionLifecycleCoordinator", () => {
  it("starts DB and capture under campaign→session locks and fails the row if capture startup fails", async (test) => {
    const f = await fixture(test);
    let nestedCampaignBlocked = false;
    let nestedSessionBlocked = false;
    f.startAction = async (session) => {
      await assert.rejects(f.campaignCoordinator.runExclusive("campaign-one", async () => {}), /Reentrant/u);
      nestedCampaignBlocked = true;
      await assert.rejects(f.sessionCoordinator.runExclusive(session.id, async () => {}), /Reentrant/u);
      nestedSessionBlocked = true;
    };
    const started = await f.lifecycle.start(guild("guild-one"), defaultInput);
    assert.equal(started.status, "recording");
    assert.equal(nestedCampaignBlocked, true);
    assert.equal(nestedSessionBlocked, true);
    assert.deepEqual(f.events.slice(-1), [`capture:start:${started.id}`]);

    const failure = new Error("voice connection unavailable");
    f.startAction = async () => { throw failure; };
    const secondInput = { ...defaultInput, campaignName: "Campaign Two", discordGuildId: "guild-two" };
    await assert.rejects(f.lifecycle.start(guild("guild-two"), secondInput), /voice connection unavailable/u);
    assert.equal([...f.records.values()].find(({ session }) => session.discordGuildId === "guild-two")?.session.status, "failed");
    assert.equal(f.wavPreserved, true);
  });

  it("coordinates pause and resume with DB under one session lock", async (test) => {
    const f = await fixture(test, initialSession());
    const paused = await f.lifecycle.pause("guild-one", "Campaign One");
    assert.equal(paused.status, "paused");
    assert.equal(f.records.get("session-one")?.session.status, "paused");
    assert.deepEqual(f.events.slice(0, 3), ["guard:pause:session-one", "db:pause:session-one", "capture:pause"]);

    const resumed = await f.lifecycle.resume("guild-one", "Campaign One");
    assert.equal(resumed.status, "recording");
    assert.equal(f.records.get("session-one")?.session.status, "recording");
    assert.deepEqual(f.events.slice(3), ["guard:resume:session-one", "db:resume:session-one", "capture:resume"]);
  });

  it("does not write DB state when capture is already uncertain", async (test) => {
    const f = await fixture(test, initialSession());
    (f.recordings as unknown as { assertTransitionAllowed: () => void }).assertTransitionAllowed = () => {
      throw new CaptureClosureError("uncertain", "session-one", "writer still active");
    };
    await assert.rejects(f.lifecycle.pause("guild-one", "Campaign One"), /writer still active/u);
    assert.equal(f.records.get("session-one")?.session.status, "recording");
    assert.equal(f.transitionCalls, 0);
    assert.equal(f.wavPreserved, true);
  });

  it("rejects a duplicate finish from finalizing without another DB transition", async (test) => {
    const f = await fixture(test, initialSession("finalizing"));
    await assert.rejects(f.lifecycle.finish("guild-one", "Campaign One"), /finalizing/u);
    assert.equal(f.transitionCalls, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.wavPreserved, true);
  });

  it("marks DB failed and preserves WAVs after capture close failure", async (test) => {
    const f = await fixture(test, initialSession());
    f.pauseAction = async () => { throw new CaptureClosureError("uncertain", "session-one", "close timed out"); };
    await assert.rejects(f.lifecycle.pause("guild-one", "Campaign One"), /close timed out/u);
    assert.equal(f.records.get("session-one")?.session.status, "failed");
    assert.equal(f.wavPreserved, true);
    assert.deepEqual(f.events.slice(-1), ["db:fail:session-one"]);
  });

  it("serializes finish with an individual delete and a campaign delete", async (test) => {
    for (const deletion of ["individual", "campaign"] as const) {
      const f = await fixture(test, initialSession());
      const captureGate = gate();
      f.finishAction = async () => { captureGate.entered(); await captureGate.promise; };
      const finishing = f.lifecycle.finish("guild-one", "Campaign One");
      await captureGate.enteredPromise;
      let deletionEntered = false;
      const deleteAction = async () => { deletionEntered = true; };
      const deleting = deletion === "individual"
        ? f.sessionCoordinator.runExclusive("session-one", deleteAction)
        : f.campaignCoordinator.runExclusive("campaign-one", () => f.sessionCoordinator.runExclusive("session-one", deleteAction));
      await settle();
      assert.equal(deletionEntered, false);
      captureGate.release();
      const finished = await finishing;
      assert.equal(finished.status, "completed");
      await deleting;
      assert.equal(deletionEntered, true);
    }
  });

  it("revalidates a resume queued behind deletion and never reopens the capture", async (test) => {
    const f = await fixture(test, initialSession("paused"));
    const deleteGate = gate();
    const deleting = f.sessionCoordinator.runExclusive("session-one", async () => {
      deleteGate.entered();
      await deleteGate.promise;
      f.records.delete("session-one");
    });
    await deleteGate.enteredPromise;
    const resuming = f.lifecycle.resume("guild-one", "Campaign One");
    await settle();
    deleteGate.release();
    await deleting;
    await assert.rejects(resuming, SessionLifecycleError);
    assert.equal(f.events.includes("capture:resume"), false);
  });

  it("allows independent campaign starts to overlap", async (test) => {
    const f = await fixture(test);
    const gateOne = gate();
    const gateTwo = gate();
    f.startAction = async (session) => {
      const gateForCampaign = session.campaignId === "campaign-one" ? gateOne : gateTwo;
      gateForCampaign.entered();
      await gateForCampaign.promise;
    };
    const first = f.lifecycle.start(guild("guild-one"), defaultInput);
    await gateOne.enteredPromise;
    const second = f.lifecycle.start(guild("guild-two"), { ...defaultInput, discordGuildId: "guild-two", campaignName: "Campaign Two" });
    await gateTwo.enteredPromise;
    gateOne.release();
    gateTwo.release();
    const [firstSession, secondSession] = await Promise.all([first, second]);
    assert.notEqual(firstSession.id, secondSession.id);
    assert.equal(firstSession.campaignId, "campaign-one");
    assert.equal(secondSession.campaignId, "campaign-two");
  });

  it("waits for an admitted start and rejects new transitions during shutdown", async (test) => {
    const f = await fixture(test);
    const startGate = gate();
    f.startAction = async () => { startGate.entered(); await startGate.promise; };
    const starting = f.lifecycle.start(guild("guild-one"), defaultInput);
    await startGate.enteredPromise;
    let shutdownDone = false;
    const shuttingDown = f.lifecycle.shutdown().then((report) => { shutdownDone = true; return report; });
    await settle();
    await assert.rejects(
      f.lifecycle.start(guild("guild-two"), { ...defaultInput, discordGuildId: "guild-two", campaignName: "Campaign Two" }),
      SessionLifecycleError,
    );
    assert.equal(shutdownDone, false);
    startGate.release();
    const started = await starting;
    const report = await shuttingDown;
    assert.equal(shutdownDone, true);
    assert.ok(f.events.includes(`capture:shutdown:${started.id}`));
    assert.equal(report.clean, true);
  });

  it("aggregates an in-flight transition failure and still attempts capture shutdown", async (test) => {
    const f = await fixture(test, initialSession());
    const pauseGate = gate();
    f.pauseAction = async () => {
      pauseGate.entered();
      await pauseGate.promise;
      throw new Error("synthetic writer close failure");
    };
    const pausing = f.lifecycle.pause("guild-one", "Campaign One");
    await pauseGate.enteredPromise;
    const shutdown = f.lifecycle.shutdown();
    pauseGate.release();
    await assert.rejects(pausing, /synthetic writer close failure/u);
    const report = await shutdown;
    assert.equal(report.clean, false);
    assert.deepEqual(report.operationFailures, ["synthetic writer close failure"]);
    assert.ok(f.events.includes("capture:shutdown-called"));
  });
});
