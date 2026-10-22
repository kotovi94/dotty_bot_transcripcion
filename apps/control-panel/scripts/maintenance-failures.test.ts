import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { FailureTracker, parseFailures } from "../src/main/maintenance-failures.ts";
import { DottySupervisor } from "../src/main/supervisor.ts";
import { MaintenanceRequestGate } from "../src/renderer/maintenance-request.ts";
import { maintenanceDisplay } from "../src/renderer/maintenance-display.ts";

const valid = (sessions: unknown[]) => new Response(JSON.stringify({ sessions }));
const failure = { session_id: "session-one", failed_jobs: 2, last_error: "falló un fragmento" };

it("validates successful empty and populated failure responses", () => {
  assert.deepEqual(parseFailures({ sessions: [] }), []);
  assert.equal(parseFailures({ sessions: [failure] })[0]?.failedJobs, 2);
  for (const payload of [null, {}, { sessions: {} }, { sessions: [null] },
    { sessions: [{ ...failure, failed_jobs: -1 }] }, { sessions: [failure, failure] }]) {
    assert.throws(() => parseFailures(payload), SyntaxError);
  }
});

it("shows 'Sin incidencias' only after a complete successful check", () => {
  const base = { checkedAt: "", issues: [] };
  assert.equal(maintenanceDisplay(base).empty, false);
  assert.equal(maintenanceDisplay({ ...base, failureQuery: {
    status: "current", lastSuccessAt: "2026-01-01", reason: null, detail: null, action: null,
  } }).empty, true);
  assert.equal(maintenanceDisplay({ ...base, localScanAvailable: false, failureQuery: {
    status: "current", lastSuccessAt: "2026-01-01", reason: null, detail: null, action: null,
  } }).empty, false);
  assert.deepEqual(maintenanceDisplay({ ...base, failureQuery: {
    status: "stale", lastSuccessAt: "2026-01-01", reason: "network", detail: "offline", action: "retry",
  } }), { confirmed: false, empty: false, stale: true });
});

it("keeps the last valid response stale through network, timeout, HTTP and invalid replies, then recovers", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-h3-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data", "recordings", "session-one"), { recursive: true });
  await writeFile(join(root, "data", "transcriber.secret"), "synthetic-secret");
  await writeFile(join(root, "data", "recordings", "session-one", "manifest.json"),
    JSON.stringify({ sessionId: "session-one", status: "completed", chunks: [{ id: "chunk" }] }));
  let response: () => Promise<Response> = async () => valid([]);
  test.mock.method(globalThis, "fetch", async () => response());
  const supervisor = new DottySupervisor(root);
  const read = () => supervisor.getMaintenanceState();

  let state = await read();
  assert.equal(state.failureQuery?.status, "current");
  assert.deepEqual(state.issues, []);
  assert.ok(state.failureQuery.lastSuccessAt);

  response = async () => valid([failure]);
  state = await read();
  assert.equal(state.issues[0]?.failedJobs, 2);
  assert.equal(state.failureQuery?.status, "current");
  const lastSuccess = state.failureQuery?.lastSuccessAt;

  const errors: Array<[() => Promise<Response>, string]> = [
    [async () => { throw new TypeError("fetch failed"); }, "network"],
    [async () => { throw new DOMException("timed out", "TimeoutError"); }, "timeout"],
    [async () => new Response("unavailable", { status: 500 }), "http"],
    [async () => new Response("{broken"), "invalid"],
    [async () => new Response(JSON.stringify({ sessions: "wrong" })), "invalid"],
  ];
  for (const [next, reason] of errors) {
    response = next;
    state = await read();
    assert.equal(state.failureQuery?.status, "stale", reason);
    assert.equal(state.failureQuery?.reason, reason);
    assert.equal(state.failureQuery?.lastSuccessAt, lastSuccess);
    assert.equal(state.issues[0]?.failedJobs, 2);
    assert.ok(state.failureQuery?.detail);
    assert.ok(state.failureQuery?.action);
  }
  response = async () => valid([]);
  state = await read();
  assert.equal(state.failureQuery?.status, "current");
  assert.deepEqual(state.issues, []);
});

it("preserves local issues when Python is unavailable without claiming an empty result", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-h3-local-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recording = join(root, "data", "recordings", "session-one");
  await mkdir(recording, { recursive: true });
  await writeFile(join(root, "data", "transcriber.secret"), "synthetic-secret");
  await writeFile(join(recording, "manifest.json"),
    JSON.stringify({ sessionId: "session-one", status: "interrupted", chunks: [{ id: "chunk" }] }));
  test.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline"); });
  const state = await new DottySupervisor(root).getMaintenanceState();
  assert.equal(state.failureQuery?.status, "unavailable");
  assert.equal(state.failureQuery?.reason, "network");
  assert.equal(state.issues.length, 1);
  assert.equal(state.issues[0]?.canRecover, true);
});

it("shows Python failures without a readable manifest and never confirms an incomplete local scan", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-h3-scan-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data", "transcriber.secret"), "synthetic-secret");
  test.mock.method(globalThis, "fetch", async () => valid([failure]));
  const supervisor = new DottySupervisor(root);
  const state = await supervisor.getMaintenanceState();
  assert.equal(state.failureQuery?.status, "current");
  assert.equal(state.localScanAvailable, false);
  assert.equal(state.issues[0]?.failedJobs, 2);
  assert.equal(state.issues[0]?.sessionId, "session-one");
});

it("ignores late responses and does not emit notifications while polling", async () => {
  const tracker = new FailureTracker();
  let finishOld!: (value: unknown) => void;
  const old = tracker.query(() => new Promise((resolve) => { finishOld = resolve; }));
  const fresh = await tracker.query(async () => ({ sessions: [failure] }));
  finishOld({ sessions: [] });
  const late = await old;
  assert.equal(fresh.sessions.length, 1);
  assert.equal(late.sessions.length, 1);
  const gate = new MaintenanceRequestGate();
  const older = gate.begin();
  const newer = gate.begin();
  assert.equal(gate.isCurrent(older), false);
  assert.equal(gate.isCurrent(newer), true);
  // El seguimiento de incidencias no tiene un canal de notificaciones.
  const first = await tracker.query(async () => { throw new TypeError("offline"); });
  const repeated = await tracker.query(async () => { throw new TypeError("offline"); });
  assert.deepEqual(repeated.query, first.query);
});
