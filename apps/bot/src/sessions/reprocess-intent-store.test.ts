import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ReprocessIntentAppliedError, ReprocessIntentStore } from "./reprocess-intent-store.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";

const eligible = { assertEligible: async (_sessionId: string) => {} };

const sessionId = "session-1";
const oldRecord = {
  version: 1, sessionId, operationId: "operation-1", phase: "prepared",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

async function fixture(test: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dotty-intent-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReprocessIntentStore(root, new SessionFileCoordinator(join(root, "locks")), eligible);
  const path = store.pathFor(sessionId);
  return { root, store, path };
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
    const created = await store.create(sessionId, "operation-1");
    assert.equal(created.phase, "prepared");
    assert.equal(created.version, 1);
    assert.deepEqual(await store.read(sessionId), created);
    assert.equal(await store.hasPending(sessionId), true);
  });

  it("rejects duplicate creation", async (test) => {
    const { store } = await fixture(test);
    await store.create(sessionId);
    await assert.rejects(store.create(sessionId), /already exists/);
  });

  it("updates phases in order and detects completion", async (test) => {
    const { store } = await fixture(test);
    const created = await store.create(sessionId, "operation-1");
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
    assert.deepEqual(await store.read(sessionId), oldRecord);
    assert.deepEqual(await store.restoreBackup(sessionId), oldRecord);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), oldRecord);
  });

  it("ignores an uncommitted temporary file beside a valid backup", async (test) => {
    const { store, path } = await fixture(test);
    await writeFile(`${path}.bak`, JSON.stringify(oldRecord));
    await writeFile(`${path}.uncommitted.tmp`, JSON.stringify({ ...oldRecord, phase: "delete-confirmed" }));
    assert.deepEqual(await store.read(sessionId), oldRecord);
    assert.equal((await readFile(`${path}.uncommitted.tmp`, "utf8")).includes("delete-confirmed"), true);
  });

  it("prefers a valid primary and leaves old auxiliaries intact", async (test) => {
    const { store, path } = await fixture(test);
    const current = { ...oldRecord, phase: "delete-confirmed", updatedAt: "2026-01-01T00:01:00.000Z" };
    await writeFile(path, JSON.stringify(current));
    await writeFile(`${path}.bak`, JSON.stringify(oldRecord));
    await writeFile(`${path}.uncommitted.tmp`, "incomplete");
    assert.deepEqual(await store.read(sessionId), current);
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
    const created = await store.create(sessionId, "operation-1");
    await assert.rejects(store.updatePhase(sessionId, created.operationId, "recovering"), /Incompatible/);
    await store.updatePhase(sessionId, created.operationId, "delete-confirmed");
    await assert.rejects(store.updatePhase(sessionId, created.operationId, "prepared"), /Incompatible/);
    assert.equal((await store.read(sessionId))?.phase, "delete-confirmed");
  });

  it("reports an applied phase when backup cleanup fails and permits a validated retry", async (test) => {
    const { root, store, path } = await fixture(test);
    const created = await store.create(sessionId, "operation-1");
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
    const created = await store.create(sessionId, "operation-1");
    await store.updatePhase(sessionId, created.operationId, "delete-confirmed");
    await writeFile(`${path}.bak`, JSON.stringify({ ...created, operationId: "another-operation" }));
    await assert.rejects(store.updatePhase(sessionId, created.operationId, "recovering"), /incompatible/);
    assert.equal((await store.read(sessionId))?.phase, "delete-confirmed");
  });

  it("recovers the last confirmed phase between the two renames", async (test) => {
    const { store, path } = await fixture(test);
    const created = await store.create(sessionId, "operation-1");
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
      store.create(sessionId, "first"), other.create(sessionId, "second"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const operationId = (await store.read(sessionId))!.operationId;
    await writeFile(`${path}.lock`, "abandoned");
    await assert.rejects(store.read(sessionId), /Locked intent/);
    await assert.rejects(other.updatePhase(sessionId, operationId, "delete-confirmed"), /locked/);
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
    await assert.rejects(store.create(sessionId, "bad\noperation"), /Invalid intent/);
    await writeFile(path, JSON.stringify({ ...oldRecord, sessionId: "another-session" }));
    await assert.rejects(store.read(sessionId), /Corrupt primary/);
  });
});
