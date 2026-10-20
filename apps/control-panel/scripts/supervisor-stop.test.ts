import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { spawn } from "node:child_process";
import { DottySupervisor } from "../src/main/supervisor.ts";

class SimulatedProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

async function waitForCompletion(supervisor: DottySupervisor): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((supervisor as unknown as { operation: unknown }).operation === null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Simulated shutdown did not complete");
}

it("preserves process references when the simulated stop script fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotty-supervisor-stop-"));
  try {
    const data = join(root, "data");
    await mkdir(join(data, "recordings"), { recursive: true });
    await mkdir(join(data, "exports"), { recursive: true });
    for (const name of ["dotty.pid", "transcriber.pid", "transcriber.launch-id", "dotty.status.json"]) {
      await writeFile(join(data, name), `fixture ${name}`);
    }
    const process = new SimulatedProcess();
    const supervisor = new DottySupervisor(root, (() => process) as unknown as typeof spawn);
    assert.equal((await supervisor.disconnect()).accepted, true);
    process.emit("close", 1);
    await waitForCompletion(supervisor);
    for (const name of ["dotty.pid", "transcriber.pid", "transcriber.launch-id", "dotty.status.json"]) {
      assert.equal(await readFile(join(data, name), "utf8"), `fixture ${name}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("cleans only post-stop artifacts after a simulated successful stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotty-supervisor-success-"));
  try {
    const data = join(root, "data");
    await mkdir(join(data, "recordings"), { recursive: true });
    await mkdir(join(data, "exports", "session"), { recursive: true });
    await writeFile(join(data, "transcriber.pid"), "4242");
    const narrativeLock = join(data, "exports", ".narrative-engine.lock");
    await writeFile(narrativeLock, "stale");
    const process = new SimulatedProcess();
    const supervisor = new DottySupervisor(root, (() => process) as unknown as typeof spawn);
    assert.equal((await supervisor.disconnect()).accepted, true);
    process.emit("close", 0);
    await waitForCompletion(supervisor);
    await assert.rejects(readFile(narrativeLock, "utf8"), { code: "ENOENT" });
    // Process references are owned by the stop script, not erased by the panel.
    assert.equal(await readFile(join(data, "transcriber.pid"), "utf8"), "4242");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
