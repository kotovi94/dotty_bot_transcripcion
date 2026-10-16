import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { SessionFileCoordinator } from "./session-file-coordinator.ts";

async function fixture(test: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dotty-session-lock-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  return { root, coordinator: new SessionFileCoordinator(root) };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("session file coordinator", () => {
  it("serializes two operations on one session", async (test) => {
    const { root, coordinator } = await fixture(test);
    const first = gate();
    const entered = gate();
    const events: string[] = [];
    const a = coordinator.runExclusive("one", async () => { events.push("a-start"); entered.release(); await first.promise; events.push("a-end"); });
    await entered.promise;
    const b = new SessionFileCoordinator(root).runExclusive("one", async () => { events.push("b"); }, { timeoutMs: 1_000 });
    await new Promise((done) => setTimeout(done, 60));
    assert.deepEqual(events, ["a-start"]);
    first.release();
    await Promise.all([a, b]);
    assert.deepEqual(events, ["a-start", "a-end", "b"]);
  });

  it("allows different sessions concurrently and reuses the lock", async (test) => {
    const { coordinator } = await fixture(test);
    const hold = gate();
    const entered = gate();
    const a = coordinator.runExclusive("one", async () => { entered.release(); await hold.promise; });
    await entered.promise;
    await coordinator.runExclusive("two", async () => {});
    hold.release();
    await a;
    await coordinator.runExclusive("one", async () => {});
  });

  it("releases after an action throws", async (test) => {
    const { coordinator } = await fixture(test);
    await assert.rejects(coordinator.runExclusive("one", async () => { throw new Error("action failed"); }), /action failed/);
    await coordinator.runExclusive("one", async () => {});
  });

  it("times out on an abandoned lock without deleting it", async (test) => {
    const { coordinator } = await fixture(test);
    const path = coordinator.pathFor("one");
    await writeFile(path, "abandoned");
    await assert.rejects(coordinator.runExclusive("one", async () => {}, { timeoutMs: 35, pollMs: 5 }), /Timed out.*inspect/);
    assert.equal(await readFile(path, "utf8"), "abandoned");
  });

  it("never removes a replacement lock", async (test) => {
    const { coordinator } = await fixture(test);
    const path = coordinator.pathFor("one");
    await assert.rejects(coordinator.runExclusive("one", async () => {
      await rm(path);
      await writeFile(path, "foreign lock");
    }), /ownership changed/);
    assert.equal(await readFile(path, "utf8"), "foreign lock");
  });

  it("rejects reentrancy immediately", async (test) => {
    const { root, coordinator } = await fixture(test);
    await coordinator.runExclusive("one", async () => {
      await assert.rejects(coordinator.runExclusive("one", async () => {}), /Reentrant/);
      await assert.rejects(new SessionFileCoordinator(root).runExclusive("one", async () => {}), /Reentrant/);
    });
  });

  it("uses distinct Windows-safe paths without altering IDs", async (test) => {
    const { coordinator } = await fixture(test);
    assert.notEqual(coordinator.pathFor("Case"), coordinator.pathFor("case"));
    assert.match(coordinator.pathFor("Case"), /[0-9a-f]+\.session\.lock$/u);
    assert.throws(() => coordinator.pathFor("../bad"), /Invalid/);
    assert.throws(() => coordinator.pathFor("a\\b"), /Invalid/);
  });

  it("excludes a separate Node process", async (test) => {
    const { root, coordinator } = await fixture(test);
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "session-file-coordinator.ts")).href;
    const childScript = `import { SessionFileCoordinator } from ${JSON.stringify(moduleUrl)}; const coordinator = new SessionFileCoordinator(${JSON.stringify(root)}); coordinator.runExclusive("one", async () => {}, { timeoutMs: 70, pollMs: 5 }).then(() => process.exit(0)).catch(error => process.exit(error.message.includes("Timed out") ? 7 : 8));`;
    const probe = () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    });
    await coordinator.runExclusive("one", async () => { assert.equal(await probe(), 7); });
    assert.equal(await probe(), 0);
    assert.ok(root);
  });
});
