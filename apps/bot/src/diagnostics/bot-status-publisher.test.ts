import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotStatusPublisher } from "./bot-status-publisher.ts";

test("heartbeat publica conexión actual y cambios de Discord", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotty-bot-health-"));
  const path = join(directory, "dotty.status.json");
  let ready = false;
  const publisher = new BotStatusPublisher(path, () => ready, 60_000);
  try {
    await publisher.start();
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "starting");
    ready = true;
    await publisher.setPhase("ready", "bot-user");
    const connected = JSON.parse(await readFile(path, "utf8"));
    assert.equal(connected.instanceId, publisher.instanceId);
    assert.equal(connected.status, "ready");
    ready = false;
    await publisher.publish();
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "disconnected");
    await publisher.setPhase("reconnecting");
    ready = true;
    await publisher.setPhase("ready");
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "ready");
  } finally { await publisher.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("reinicio rápido reclama estado de un proceso finalizado y no pisa otro activo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotty-bot-restart-"));
  const path = join(directory, "dotty.status.json");
  try {
    await writeFile(path, JSON.stringify({ version: 1, instanceId: "old", pid: 999_999_999,
      heartbeatAt: new Date().toISOString() }));
    const restarted = new BotStatusPublisher(path, () => false, 60_000);
    await restarted.start();
    assert.equal(JSON.parse(await readFile(path, "utf8")).instanceId, restarted.instanceId);
    const competing = new BotStatusPublisher(path, () => false, 60_000);
    await assert.rejects(competing.start(), /Otra instancia/);
    await restarted.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("un cierre anterior conserva el marcador de una instancia nueva", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotty-bot-owner-"));
  const path = join(directory, "dotty.status.json");
  const old = new BotStatusPublisher(path, () => false, 60_000);
  try {
    await old.start();
    await writeFile(path, JSON.stringify({ version: 1, instanceId: "replacement", pid: 4321 }));
    await old.removeIfOwned();
    await old.reportIfOwned({ status: "shutdown-incomplete" });
    assert.equal(JSON.parse(await readFile(path, "utf8")).instanceId, "replacement");
  } finally { await old.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("un estado histórico con PID vivo no autoriza otra instancia", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotty-bot-legacy-"));
  const path = join(directory, "dotty.status.json");
  try {
    await writeFile(path, JSON.stringify({ status: "ready", pid: process.pid }));
    const publisher = new BotStatusPublisher(path, () => false, 60_000);
    await assert.rejects(publisher.start(), /Otra instancia/);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
