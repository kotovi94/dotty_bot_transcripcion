import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

import { SetupManager } from "../src/main/setup-manager.ts";
import { DottySupervisor } from "../src/main/supervisor.ts";
import { SetupOperationLock } from "../src/main/setup-operation-lock.ts";
import { classifySetupProcesses, inspectSetupArtifacts } from "../src/main/setup-safety.ts";
import type { SetupConfig, SetupSafetyStatus } from "../src/shared/contracts.ts";

const allowed: SetupSafetyStatus = { status: "allowed", message: "Seguro", action: "Continuar" };
const blocked = (message: string): SetupSafetyStatus => ({ status: "blocked", message, action: "Detener Dotty" });
const execFileAsync = promisify(execFile);

it("classifies simulated Node and Python processes and fails closed on inaccessible process details", () => {
  assert.equal(classifySetupProcesses([]).status, "allowed");
  assert.equal(classifySetupProcesses({ CommandLine: "node src/index.ts" }).status, "blocked");
  assert.equal(classifySetupProcesses({ CommandLine: "python -m uvicorn dotty_transcriber.main:app" }).status, "blocked");
  assert.equal(classifySetupProcesses({ CommandLine: null }).status, "unknown");
});

async function fixture(test: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "dotty-h7-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const python = join(root, "python.exe");
  const npm = join(root, "npm.cmd");
  await mkdir(data);
  await writeFile(python, "synthetic");
  await writeFile(npm, "synthetic");
  const config: SetupConfig = { discordToken: "synthetic-secret", keepExistingToken: false,
    discordClientId: "12345678901234567", discordGuildId: "12345678901234567",
    dataDirectory: data, pythonExecutable: python, npmExecutable: npm,
    transcriptionMode: "cpu", whisperModel: "small" };
  return { root, data, config };
}

it("permits inactive setup, preserves unrelated .env variables and creates a recoverable backup", async (test) => {
  const { root, data, config } = await fixture(test);
  const previous = `CUSTOM_SETTING=keep\nDISCORD_TOKEN=previous\nDOTTY_DATA_DIR=${data}\nDATABASE_URL=file:custom.db\n`;
  await writeFile(join(root, ".env"), previous);
  const manager = new SetupManager(root, async () => allowed);
  const calls: string[] = [];
  (manager as unknown as { run: (exe: string, args: string[]) => Promise<void> }).run = async (_exe, args) => { calls.push(args.join(" ")); };
  const result = await manager.save(config);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["run commands:deploy"]);
  const current = await readFile(join(root, ".env"), "utf8");
  assert.match(current, /CUSTOM_SETTING=keep/u);
  assert.match(current, /DATABASE_URL=file:custom\.db/u);
  assert.match(current, /DISCORD_TOKEN=synthetic-secret/u);
  const backup = (await readdir(root)).find((name) => name.startsWith(".env.backup-"));
  assert.ok(backup);
  assert.equal(await readFile(join(root, backup), "utf8"), previous);
  assert.equal((await readdir(root)).includes(".setup-operation.lock"), false);
});

it("prepares an initial installation with simulated commands and no real migration", async (test) => {
  const { root, config } = await fixture(test);
  const manager = new SetupManager(root, async () => allowed);
  const commands: string[] = [];
  (manager as unknown as { run: (exe: string, args: string[]) => Promise<void> }).run = async (_exe, args) => { commands.push(args.join(" ")); };
  assert.equal((await manager.save(config)).ok, true);
  assert.deepEqual(commands, ["run db:deploy", "run commands:deploy"]);
  assert.match(await readFile(join(root, ".env"), "utf8"), /DISCORD_TOKEN=synthetic-secret/u);
});

it("blocks active recording, Whisper, recovery, unknown state and inaccessible service without side effects", async (test) => {
  const { root, config } = await fixture(test);
  for (const safety of [blocked("Grabación activa"), blocked("Whisper activo"),
    blocked("Recuperación crítica"), { status: "unknown", message: "Estado desconocido", action: "Revisar" } as SetupSafetyStatus,
    { status: "unknown", message: "Servicio inaccesible", action: "Revisar" } as SetupSafetyStatus]) {
    const manager = new SetupManager(root, async () => safety);
    (manager as unknown as { run: () => Promise<void> }).run = async () => { throw new Error("No debe ejecutarse"); };
    const result = await manager.save(config);
    assert.equal(result.ok, false, safety.message);
    assert.match(result.message, new RegExp(safety.message, "u"));
    assert.equal((await readdir(root)).includes(".env"), false);
  }
});

it("rechecks before mutation and leaves .env unchanged when activity starts", async (test) => {
  const { root, config } = await fixture(test);
  await writeFile(join(root, ".env"), "CUSTOM=original\n");
  let checks = 0;
  const manager = new SetupManager(root, async () => ++checks === 1 ? allowed : blocked("Ahora hay actividad"));
  (manager as unknown as { run: () => Promise<void> }).run = async () => { throw new Error("No debe ejecutarse"); };
  assert.equal((await manager.save(config)).ok, false);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "CUSTOM=original\n");
});

it("rechecks immediately before .env replacement after simulated deployment", async (test) => {
  const { root, config } = await fixture(test);
  await writeFile(join(root, ".env"), "CUSTOM=original\n");
  let checks = 0;
  const manager = new SetupManager(root, async () => ++checks < 4 ? allowed : blocked("Actividad antes de escribir"));
  const commands: string[] = [];
  (manager as unknown as { run: (exe: string, args: string[]) => Promise<void> }).run = async (_exe, args) => { commands.push(args.join(" ")); };
  const result = await manager.save(config);
  assert.equal(result.ok, false);
  assert.match(result.message, /Actividad antes de escribir/u);
  assert.deepEqual(commands, ["run commands:deploy"]);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "CUSTOM=original\n");
});

it("stops preparation before a later install when safety changes", async (test) => {
  const { root, config } = await fixture(test);
  const venvPython = join(root, "services", "transcriber", ".venv", "Scripts", "python.exe");
  await mkdir(join(root, "services", "transcriber", ".venv", "Scripts"), { recursive: true });
  await writeFile(venvPython, "synthetic");
  let checks = 0;
  const manager = new SetupManager(root, async () => ++checks < 3 ? allowed : blocked("Transcripción iniciada"));
  const commands: string[] = [];
  (manager as unknown as { run: (exe: string, args: string[]) => Promise<void> }).run = async (_exe, args) => { commands.push(args.join(" ")); };
  const result = await manager.prepare(config);
  assert.equal(result.ok, false);
  assert.match(result.message, /Transcripción iniciada/u);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /pip install/u);
});

it("keeps the former .env and never exposes secrets when a command or write fails", async (test) => {
  const { root, config } = await fixture(test);
  await writeFile(join(root, ".env"), "CUSTOM=original\n");
  const manager = new SetupManager(root, async () => allowed);
  (manager as unknown as { run: () => Promise<void> }).run = async () => { throw new Error(`private ${config.discordToken}`); };
  const failed = await manager.save(config);
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-secret/u);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "CUSTOM=original\n");
  (manager as unknown as { run: () => Promise<void> }).run = async () => {};
  (manager as unknown as { writeEnvSafely: () => Promise<void> }).writeEnvSafely = async () => { throw new Error("disk full"); };
  assert.equal((await manager.save(config)).ok, false);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "CUSTOM=original\n");
});

it("prevents duplicate execution and leaves a surviving foreign lock untouched", async (test) => {
  const { root, config } = await fixture(test);
  const lock = new SetupOperationLock(root);
  let release!: () => void;
  let entered!: () => void;
  const occupied = new Promise<void>((resolve) => { entered = resolve; });
  const pending = lock.run(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
  await occupied;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command",
    "$p=$env:DOTTY_TEST_LOCK_PATH; try { $f=[System.IO.File]::Open($p,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None); $f.Dispose(); Write-Output 'acquired' } catch [System.IO.IOException] { Write-Output 'occupied' }"],
  { windowsHide: true, env: { ...process.env, DOTTY_TEST_LOCK_PATH: join(root, ".setup-operation.lock") } });
  assert.equal(stdout.trim(), "occupied");
  const manager = new SetupManager(root, async () => allowed);
  assert.equal((await manager.save(config)).ok, false);
  assert.equal((await readdir(root)).includes(".setup-operation.lock"), true);
  release(); await pending;
  await writeFile(join(root, ".setup-operation.lock"), "foreign-owner");
  await assert.rejects(lock.run(async () => {}));
  assert.equal(await readFile(join(root, ".setup-operation.lock"), "utf8"), "foreign-owner");
});

it("blocks panel recovery and retranscription while setup owns the shared lock", async (test) => {
  const { root } = await fixture(test);
  const supervisor = new DottySupervisor(root);
  await new SetupOperationLock(root).run(async () => {
    await assert.rejects(supervisor.regenerateRaw("session-one"), { code: "EEXIST" });
    await assert.rejects(supervisor.runMaintenanceAction("recover-session", "session-one"), { code: "EEXIST" });
  });
});

it("detects recording, recovery and administrative artifacts with temporary fixtures", async (test) => {
  const { data } = await fixture(test);
  assert.equal((await inspectSetupArtifacts([data])).status, "allowed");
  const recording = join(data, "recordings", "session-one");
  await mkdir(recording, { recursive: true });
  await writeFile(join(recording, "manifest.json"), JSON.stringify({ status: "recording" }));
  assert.equal((await inspectSetupArtifacts([data])).status, "blocked");
  await writeFile(join(recording, "manifest.json"), JSON.stringify({ status: "completed" }));
  await writeFile(join(recording, ".transcription-regenerating"), "busy");
  assert.equal((await inspectSetupArtifacts([data])).status, "blocked");
  await rm(join(recording, ".transcription-regenerating"));
  await mkdir(join(data, "reprocess-intents"));
  await writeFile(join(data, "reprocess-intents", "pending.json"), "{}");
  assert.equal((await inspectSetupArtifacts([data])).status, "blocked");
  await rm(join(data, "reprocess-intents", "pending.json"));
  await mkdir(join(data, "recovered-audio", "session-one"), { recursive: true });
  await writeFile(join(data, "recovered-audio", "session-one", "transcription.status.json"), JSON.stringify({ phase: "transcribing" }));
  assert.equal((await inspectSetupArtifacts([data])).status, "blocked");
});
