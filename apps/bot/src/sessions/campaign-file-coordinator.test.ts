import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { CampaignFileCoordinator } from "./campaign-file-coordinator.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";

async function fixture(test: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dotty-campaign-lock-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  return { root, coordinator: new CampaignFileCoordinator(root) };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("campaign file coordinator", () => {
  it("serializes concurrent operations on one campaign", async (test) => {
    const { coordinator } = await fixture(test);
    const hold = gate();
    const entered = gate();
    const events: string[] = [];
    const first = coordinator.runExclusive("campaign-one", async () => {
      events.push("first-start");
      entered.release();
      await hold.promise;
      events.push("first-end");
    });
    await entered.promise;
    const second = coordinator.runExclusive("campaign-one", async () => { events.push("second"); }, { timeoutMs: 1_000 });
    await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(events, ["first-start"]);
    hold.release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-start", "first-end", "second"]);
  });

  it("allows independent campaigns and session locks to proceed", async (test) => {
    const { root, coordinator } = await fixture(test);
    const sessionCoordinator = new SessionFileCoordinator(root);
    assert.notEqual(coordinator.pathFor("same-id"), sessionCoordinator.pathFor("same-id"));
    const hold = gate();
    const entered = gate();
    const campaign = coordinator.runExclusive("campaign-one", async () => { entered.release(); await hold.promise; });
    await entered.promise;
    await coordinator.runExclusive("campaign-two", async () => {});
    await sessionCoordinator.runExclusive("same-id", async () => {});
    hold.release();
    await campaign;
  });

  it("times out without entering while another owner holds the lock", async (test) => {
    const { coordinator } = await fixture(test);
    const hold = gate();
    const entered = gate();
    const owner = coordinator.runExclusive("campaign-one", async () => { entered.release(); await hold.promise; });
    await entered.promise;
    await assert.rejects(
      coordinator.runExclusive("campaign-one", async () => {}, { timeoutMs: 35, pollMs: 5 }),
      /Timed out waiting for campaign lock/u,
    );
    hold.release();
    await owner;
  });

  it("leaves an abandoned lock untouched", async (test) => {
    const { coordinator } = await fixture(test);
    const path = coordinator.pathFor("campaign-one");
    await writeFile(path, "abandoned");
    await assert.rejects(
      coordinator.runExclusive("campaign-one", async () => {}, { timeoutMs: 35, pollMs: 5 }),
      /Timed out.*inspect/u,
    );
    assert.equal(await readFile(path, "utf8"), "abandoned");
  });

  it("excludes a separate Node process", async (test) => {
    const { root, coordinator } = await fixture(test);
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "campaign-file-coordinator.ts")).href;
    const childScript = `import { CampaignFileCoordinator } from ${JSON.stringify(moduleUrl)}; const coordinator = new CampaignFileCoordinator(${JSON.stringify(root)}); coordinator.runExclusive("campaign-one", async () => {}, { timeoutMs: 70, pollMs: 5 }).then(() => process.exit(0)).catch(error => process.exit(error.message.includes("Timed out") ? 7 : 8));`;
    const probe = () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    });
    await coordinator.runExclusive("campaign-one", async () => { assert.equal(await probe(), 7); });
    assert.equal(await probe(), 0);
  });
});