import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateBotHealth, recentBotIdentity } from "../src/main/bot-health.ts";

const now = Date.now();
const started = new Date(now - 10_000).toISOString();
const status = { version: 1, instanceId: "instance-a", pid: 1234, processStartedAt: started,
  heartbeatAt: new Date(now).toISOString(), status: "ready", connectedAt: new Date(now - 2_000).toISOString() };
const processInfo = { pid: 1234, name: "node.exe", commandLine: 'node --import tsx src/index.ts', createdAt: started };
const health = (state: unknown = status, process = processInfo) => evaluateBotHealth(state, process, now);

test("bot conectado exige heartbeat e identidad vigentes", () => {
  assert.equal(health().status, "connected");
  assert.equal(health().instanceId, "instance-a");
  assert.equal(health().connected, true);
  for (const phase of ["starting", "disconnected", "reconnecting", "error", "stopping"]) {
    const result = health({ ...status, status: phase });
    assert.equal(result.connected, false, phase);
  }
  assert.equal(health({ ...status, status: "starting" }).status, "starting");
  assert.equal(health({ ...status, status: "disconnected" }).status, "disconnected");
  assert.equal(health({ ...status, status: "reconnecting" }).status, "reconnecting");
});

test("un reinicio con el mismo PID conserva una identidad de instancia diferente", () => {
  const restarted = health({ ...status, instanceId: "instance-b" });
  assert.equal(restarted.instanceId, "instance-b");
  assert.notEqual(restarted.instanceId, health().instanceId);
});

test("caída, PID reutilizado y proceso ajeno nunca conectan", () => {
  assert.equal(evaluateBotHealth(status, null, now).status, "error");
  assert.equal(evaluateBotHealth({ ...status, status: "stopping" }, null, now).status, "stopped");
  for (const process of [
    { ...processInfo, pid: 9999 },
    { ...processInfo, createdAt: new Date(now).toISOString() },
    { ...processInfo, createdAt: "fecha inválida" },
    { ...processInfo, commandLine: "node foreign.js" },
    { ...processInfo, name: "other.exe" },
  ]) assert.equal(evaluateBotHealth(status, process, now).connected, false);
});

test("heartbeat antiguo, estado histórico o corrupto quedan desconocidos", () => {
  assert.equal(health({ ...status, heartbeatAt: new Date(now - 8_000).toISOString() }).status, "unknown");
  assert.equal(health({ pid: 1234, status: "ready" }).status, "unknown");
  assert.equal(health({ ...status, status: "mystery" }).status, "unknown");
  assert.equal(health({ ...status, connectedAt: null }).connected, false);
});

test("una reconexión necesita una nueva señal lista", () => {
  assert.equal(health({ ...status, status: "disconnected" }).connected, false);
  assert.equal(health({ ...status, status: "reconnecting" }).connected, false);
  assert.equal(health().connected, true);
});

test("un fallo temporal de consulta usa identidad reciente, pero no una antigua", () => {
  const cached = { identity: processInfo, at: now - 1_000 };
  assert.equal(evaluateBotHealth(status, recentBotIdentity(cached, 1234, now), now).connected, true);
  assert.equal(recentBotIdentity(cached, 1234, now + 5_100), null);
  assert.equal(recentBotIdentity(cached, 5678, now), null);
});
