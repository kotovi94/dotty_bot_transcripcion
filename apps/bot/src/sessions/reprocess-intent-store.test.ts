import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ReprocessIntentAppliedError, ReprocessIntentStore } from "./reprocess-intent-store.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";

const eligible = { assertEligible: async (_sessionId: string) => {} };

const sessionId = "session-1";
const operationId = "4b2aa77f-cc49-4f24-9033-6a48f5f880c1";
const oldRecord = {
  version: 1, sessionId, operationId: "operation-1", phase: "prepared",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

async function fixture(test: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dotty-intent-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const coordinator = new SessionFileCoordinator(join(root, "locks"));
  const store = new ReprocessIntentStore(root, coordinator, eligible);
  const path = store.pathFor(sessionId);
  return { root, coordinator, store, path };
}

describe("reprocess intent store", () => {
  it("distinguishes a verified absence from a pending or completed intent", async (test) => {
    const { store } = await fixture(test);
    assert.equal(await store.read(sessionId), null);
    assert.equal(await store.hasPending(sessionId), false);
    const created = await store.create(sessionId);
    assert.equal(await store.hasPending(sessionId), true);
    for (const phase of ["delete-confirmed", "recovering", "redispatch-ready", "completed"] as const) {
      await store.updatePhase(sessionId, created.operationId, phase);
    }
    assert.equal((await store.read(sessionId))?.phase, "completed");
    assert.equal(await store.hasPending(sessionId), false);
  });

  it("blocks a lone temporary intent instead of reporting absence", async (test) => {
    const { store, path } = await fixture(test);
    const temporary = `${path}.interrupted.tmp`;
    await writeFile(temporary, JSON.stringify(oldRecord));
    await assert.rejects(store.read(sessionId), /Uncommitted temporary/);
    await assert.rejects(store.hasPending(sessionId), /Uncommitted temporary/);
    await assert.rejects(store.create(sessionId), /Uncommitted temporary/);
    assert.equal(await readFile(temporary, "utf8"), JSON.stringify(oldRecord));
  });

  it("blocks an isolated lock instead of reporting absence", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(`${path}.lock`, "interrupted");
    await assert.rejects(store.read(sessionId), /Locked intent/);
    await assert.rejects(store.hasPending(sessionId), /Locked intent/);
  });

  it("rejects a corrupt backup when the primary is absent", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(`${path}.bak`, "{broken");
    await assert.rejects(store.read(sessionId), /Corrupt backup/);
    await assert.rejects(store.hasPending(sessionId), /Corrupt backup/);
  });

  it("propagates a read error instead of reporting absence", async (test) => {
    const { store, path } = await fixture(test);
    await mkdir(path);
    await assert.rejects(store.read(sessionId));
    await assert.rejects(store.hasPending(sessionId));
  });

  it("creates and reads a pending intention", async (test) => {
    const { store } = await fixture(test);
    const created = await store.create(sessionId, operationId);
    assert.equal(created.phase, "prepared");
    assert.equal(created.version, 1);
    assert.deepEqual(await store.read(sessionId), created);
    assert.equal(await store.hasPending(sessionId), true);
  });

  it("creates under verified ownership without reacquiring the session lock", async (test) => {
    const { coordinator, store } = await fixture(test);
    const created = await coordinator.runExclusive(sessionId, async () => {
      await assert.rejects(store.create(sessionId), /Reentrant/);
      return store.createWithHeldLock(sessionId);
    });
    assert.match(created.operationId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
    assert.deepEqual(await store.read(sessionId), created);
  });

  it("rejects missing, foreign and released lock ownership without writing", async (test) => {
    const { coordinator, store } = await fixture(test);
    await assert.rejects(store.createWithHeldLock(sessionId), /No active/);
    await assert.rejects(coordinator.runExclusive("other-session", () => store.createWithHeldLock(sessionId)), /No active/);
    let detached!: () => Promise<unknown>;
    await coordinator.runExclusive(sessionId, async () => {
      detached = () => store.createWithHeldLock(sessionId);
    });
    await assert.rejects(detached(), /No active/);
    assert.equal(await store.read(sessionId), null);
  });

  it("drains registered creation after the owning callback returns", async (test) => {
    const { root, coordinator, store } = await fixture(test);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new ReprocessIntentStore(
      root, coordinator,
      { assertEligible: async () => { entered(); await gate; } },
    );
    let creation!: Promise<unknown>;
    const owner = coordinator.runExclusive(sessionId, async () => {
      creation = delayed.createWithHeldLock(sessionId);
      await started;
    });
    await started;
    await assert.rejects(coordinator.runExclusive(sessionId, async () => {}, { timeoutMs: 0 }), /Timed out/);
    release();
    await owner;
    await creation;
    assert.equal((await store.read(sessionId))?.phase, "prepared");
  });

  it("recovers the same UUID after restart and never replaces an existing intent", async (test) => {
    const { root, coordinator, store } = await fixture(test);
    const created = await coordinator.runExclusive(sessionId, () => store.createWithHeldLock(sessionId));
    const restarted = new ReprocessIntentStore(root, new SessionFileCoordinator(join(root, "locks")), eligible);
    const recovered = await coordinator.runExclusive(sessionId, () => restarted.recoverWithHeldLock(sessionId));
    assert.deepEqual(recovered, created);
    await assert.rejects(store.create(sessionId), /already exists/);
    assert.deepEqual(await store.read(sessionId), created);
  });

  it("keeps historical IDs readable but refuses them for protocol recovery", async (test) => {
    const { coordinator, store, path } = await fixture(test);
    await writeFile(path, JSON.stringify(oldRecord));
    assert.deepEqual(await store.readForInspection(sessionId), oldRecord);
    await assert.rejects(store.read(sessionId), /canonical UUID/);
    await assert.rejects(coordinator.runExclusive(sessionId, () => store.recoverWithHeldLock(sessionId)),
      (error) => error instanceof AggregateError && error.errors.some((cause) => /canonical UUID/.test(String(cause))));
    assert.deepEqual(await store.readForInspection(sessionId), oldRecord);
    await writeFile(path, JSON.stringify({ ...oldRecord, phase: "completed" }));
    await assert.rejects(store.read(sessionId), /canonical UUID/);
    await assert.rejects(store.hasPending(sessionId), /canonical UUID/);
  });

  it("rejects noncanonical IDs for new intentions", async (test) => {
    const { coordinator, store } = await fixture(test);
    await assert.rejects(store.create(sessionId, "operation-1"), /canonical UUID/);
    await assert.rejects(coordinator.runExclusive(sessionId, () => store.createWithHeldLock(sessionId, operationId.toUpperCase())),
      (error) => error instanceof AggregateError && error.errors.some((cause) => /canonical UUID/.test(String(cause))));
    assert.equal(await store.read(sessionId), null);
  });

  it("permits only one of two concurrent held-lock creations", async (test) => {
    const { coordinator, store } = await fixture(test);
    let results!: PromiseSettledResult<unknown>[];
    await assert.rejects(coordinator.runExclusive(sessionId, async () => {
      results = await Promise.allSettled([
        store.createWithHeldLock(sessionId), store.createWithHeldLock(sessionId),
      ]);
    }), /already exists|Intent is locked|Protected session operations failed/);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.read(sessionId))?.phase, "prepared");
  });

  it("allows independent sessions to create under separate locks", async (test) => {
    const { coordinator, store } = await fixture(test);
    const [first, second] = await Promise.all([
      coordinator.runExclusive(sessionId, () => store.createWithHeldLock(sessionId)),
      coordinator.runExclusive("session-2", () => store.createWithHeldLock("session-2")),
    ]);
    assert.notEqual(first.operationId, second.operationId);
    assert.deepEqual(await store.read(sessionId), first);
    assert.deepEqual(await store.read("session-2"), second);
  });

  it("preserves uncertainty when the final rename fails", async (test) => {
    const { root, coordinator, path } = await fixture(test);
    const faulty = new ReprocessIntentStore(root, coordinator, eligible, {
      rename: async () => { throw new Error("rename failed"); },
    });
    await assert.rejects(coordinator.runExclusive(sessionId, () => faulty.createWithHeldLock(sessionId)),
      (error) => error instanceof AggregateError && error.errors.some((cause) => /rename failed/.test(String(cause))));
    await assert.rejects(faulty.read(sessionId), /Uncommitted temporary/);
    await assert.rejects(faulty.create(sessionId), /Uncommitted temporary/);
    assert.equal(await readFile(`${path}.bak`, "utf8").catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");
  });

  it("rejects duplicate creation", async (test) => {
    const { store } = await fixture(test);
    await store.create(sessionId);
    await assert.rejects(store.create(sessionId), /already exists/);
  });

  it("updates phases in order and detects completion", async (test) => {
    const { store } = await fixture(test);
    const created = await store.create(sessionId, operationId);
    let current = created;
    for (const phase of ["delete-confirmed", "recovering", "redispatch-ready", "completed"] as const) {
      current = await store.updatePhase(sessionId, created.operationId, phase);
      assert.equal((await store.read(sessionId))?.phase, phase);
    }
    assert.equal(current.createdAt, created.createdAt);
    assert.equal(await store.hasPending(sessionId), false);
  });

  it("reads a record from a new store instance", async (test) => {
    const { root, store } = await fixture(test);
    const created = await store.create(sessionId);
    assert.deepEqual(await new ReprocessIntentStore(root, new SessionFileCoordinator(join(root, "locks")), eligible).read(sessionId), created);
  });

  it("reads and restores a valid backup when the primary is absent", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(`${path}.bak`, JSON.stringify(oldRecord));
    assert.deepEqual(await store.readForInspection(sessionId), oldRecord);
    assert.deepEqual(await store.restoreBackup(sessionId), oldRecord);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), oldRecord);
  });

  it("ignores an uncommitted temporary file beside a valid backup", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(`${path}.bak`, JSON.stringify(oldRecord));
    await writeFile(`${path}.uncommitted.tmp`, JSON.stringify({ ...oldRecord, phase: "delete-confirmed" }));
    assert.deepEqual(await store.readForInspection(sessionId), oldRecord);
    assert.equal((await readFile(`${path}.uncommitted.tmp`, "utf8")).includes("delete-confirmed"), true);
  });

  it("prefers a valid primary and leaves old auxiliaries intact", async (test) => {
    const { store, path } = await fixture(test);
    const current = { ...oldRecord, phase: "delete-confirmed", updatedAt: "2026-01-01T00:01:00.000Z" };
    await writeFile(path, JSON.stringify(current));
    await writeFile(`${path}.bak`, JSON.stringify(oldRecord));
    await writeFile(`${path}.uncommitted.tmp`, "incomplete");
    assert.deepEqual(await store.readForInspection(sessionId), current);
    assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, "utf8")), oldRecord);
  });

  it("blocks a corrupt primary even when a valid backup exists", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(path, "{broken");
    await writeFile(`${path}.bak`, JSON.stringify(oldRecord));
    await assert.rejects(store.read(sessionId), /Corrupt primary/);
    await assert.rejects(store.restoreBackup(sessionId), /Primary intent exists/);
  });

  it("rejects corrupt files rather than guessing a state", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(path, "{broken");
    await writeFile(`${path}.bak`, "also broken");
    await assert.rejects(store.read(sessionId), /Corrupt primary/);
  });

  it("rejects unknown versions and incomplete records", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(path, JSON.stringify({ ...oldRecord, version: 2 }));
    await assert.rejects(store.read(sessionId), /Corrupt primary/);
    await writeFile(path, JSON.stringify({ version: 1, sessionId }));
    await assert.rejects(store.read(sessionId), /Corrupt primary/);
  });

  it("propagates a write failure without creating an intention", async (test) => {
    const { root } = await fixture(test);
    const blocked = join(root, "file-instead-of-directory");
    await writeFile(blocked, "occupied");
    const store = new ReprocessIntentStore(blocked, new SessionFileCoordinator(join(root, "locks")), eligible);
    await assert.rejects(store.create(sessionId));
    assert.equal(await readFile(blocked, "utf8"), "occupied");
  });

  it("rejects phase rollback and skipping phases", async (test) => {
    const { store } = await fixture(test);
    const created = await store.create(sessionId, operationId);
    await assert.rejects(store.updatePhase(sessionId, created.operationId, "recovering"), /Incompatible/);
    await store.updatePhase(sessionId, created.operationId, "delete-confirmed");
    await assert.rejects(store.updatePhase(sessionId, created.operationId, "prepared"), /Incompatible/);
    assert.equal((await store.read(sessionId))?.phase, "delete-confirmed");
  });

  it("reports an applied phase when backup cleanup fails and permits a validated retry", async (test) => {
    const { root, store, path } = await fixture(test);
    const created = await store.create(sessionId, operationId);
    let failRemoval = true;
    const faulty = new ReprocessIntentStore(root, new SessionFileCoordinator(join(root, "locks")), eligible, {
      removeBackup: async (backup) => {
        if (failRemoval) throw new Error("remove failed");
        await rm(backup);
      },
    });
    await assert.rejects(
      faulty.updatePhase(sessionId, created.operationId, "delete-confirmed"),
      (error) => error instanceof ReprocessIntentAppliedError &&
        error.intent.phase === "delete-confirmed",
    );
    assert.equal((await store.read(sessionId))?.phase, "delete-confirmed");
    assert.equal(JSON.parse(await readFile(`${path}.bak`, "utf8")).phase, "prepared");
    failRemoval = false;
    await faulty.updatePhase(sessionId, created.operationId, "recovering");
    assert.equal((await store.read(sessionId))?.phase, "recovering");
  });

  it("rejects an incompatible old backup without removing it", async (test) => {
    const { store, path } = await fixture(test);
    const created = await store.create(sessionId, operationId);
    await store.updatePhase(sessionId, created.operationId, "delete-confirmed");
    await writeFile(`${path}.bak`, JSON.stringify({ ...created, operationId: "another-operation" }));
    await assert.rejects(store.updatePhase(sessionId, created.operationId, "recovering"), /incompatible/);
    assert.equal((await store.read(sessionId))?.phase, "delete-confirmed");
  });

  it("recovers the last confirmed phase between the two renames", async (test) => {
    const { store, path } = await fixture(test);
    const created = await store.create(sessionId, operationId);
    await writeFile(`${path}.bak`, await readFile(path));
    await rm(path);
    await writeFile(`${path}.interrupted.tmp`, JSON.stringify({ ...created, phase: "delete-confirmed" }));
    assert.equal((await store.read(sessionId))?.phase, "prepared");
    assert.equal((await store.restoreBackup(sessionId)).phase, "prepared");
  });

  it("serializes two instances and fails closed on an abandoned lock", async (test) => {
    const { root, store, path } = await fixture(test);
    const other = new ReprocessIntentStore(root, new SessionFileCoordinator(join(root, "locks")), eligible);
    const results = await Promise.allSettled([
      store.create(sessionId, operationId), other.create(sessionId, randomUUID()),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const persistedOperationId = (await store.read(sessionId))!.operationId;
    await writeFile(`${path}.lock`, "abandoned");
    await assert.rejects(store.read(sessionId), /Locked intent/);
    await assert.rejects(other.updatePhase(sessionId, persistedOperationId, "delete-confirmed"), /locked/);
    await assert.rejects(other.recoverAbandonedLock(sessionId), /Cannot prove/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), "abandoned");
  });

  it("uses distinct Windows-safe paths for IDs differing only in case", async (test) => {
    const { store } = await fixture(test);
    assert.notEqual(store.pathFor("Session-1").toLowerCase(), store.pathFor("session-1").toLowerCase());
    await store.create("Session-1");
    await store.create("session-1");
    assert.equal((await store.read("Session-1"))?.sessionId, "Session-1");
    assert.equal((await store.read("session-1"))?.sessionId, "session-1");
  });

  it("rejects unsafe IDs and a mismatched session ID inside the record", async (test) => {
    const { store, path } = await fixture(test);
    for (const value of ["", ".", "..", "../other", "a\\b", "bad\nname"]) {
      assert.throws(() => store.pathFor(value), /Invalid session ID/);
    }
    await assert.rejects(store.create(sessionId, "bad\noperation"), /canonical UUID/);
    await writeFile(path, JSON.stringify({ ...oldRecord, sessionId: "another-session" }));
    await assert.rejects(store.read(sessionId), /Corrupt primary/);
  });
});
