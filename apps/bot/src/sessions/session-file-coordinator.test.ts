import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("runs registered work under the acquired session lock", async (test) => {
    const { root, coordinator } = await fixture(test);
    await assert.rejects(coordinator.runWithHeldLock("one", async () => {}), /No active/);
    await coordinator.runExclusive("one", async () => {
      assert.equal(await coordinator.runWithHeldLock("one", async () => 42), 42);
      await assert.rejects(coordinator.runWithHeldLock("two", async () => {}), /No active/);
      await assert.rejects(coordinator.runExclusive("one", async () => {}), /Reentrant/);
      assert.equal(await new SessionFileCoordinator(root).runWithHeldLock("one", async () => "shared"), "shared");
    });
  });

  it("waits for detached registered work and rejects new work while closing", async (test) => {
    const { root, coordinator } = await fixture(test);
    const entered = gate();
    const finish = gate();
    const protectedPath = join(root, "protected.txt");
    let settled = false;
    const owner = coordinator.runExclusive("one", async () => {
      void coordinator.runWithHeldLock("one", async () => {
        entered.release();
        await finish.promise;
        await assert.rejects(coordinator.runWithHeldLock("one", async () => {}), /No active/);
        await writeFile(protectedPath, "finished under lock");
      });
      await entered.promise;
    }).then(() => { settled = true; });
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(new SessionFileCoordinator(root).runExclusive("one", async () => {}, { timeoutMs: 0 }), /Timed out/);
    finish.release();
    await owner;
    assert.equal(await readFile(protectedPath, "utf8"), "finished under lock");
  });

  it("rejects a detached inherited context after release without writing", async (test) => {
    const { root, coordinator } = await fixture(test);
    const releaseAttempt = gate();
    const protectedPath = join(root, "late.txt");
    let attempt!: Promise<void>;
    await coordinator.runExclusive("one", async () => {
      attempt = releaseAttempt.promise.then(() => coordinator.runWithHeldLock("one", () => writeFile(protectedPath, "late")));
    });
    releaseAttempt.release();
    await assert.rejects(attempt, /No active/);
    await assert.rejects(access(protectedPath));
  });

  it("does not reactivate an old capability during a new acquisition", async (test) => {
    const { coordinator } = await fixture(test);
    const releaseAttempt = gate();
    let oldAttempt!: Promise<void>;
    await coordinator.runExclusive("one", async () => {
      oldAttempt = releaseAttempt.promise.then(() => coordinator.runWithHeldLock("one", async () => {}));
    });
    await coordinator.runExclusive("one", async () => {
      releaseAttempt.release();
      await assert.rejects(oldAttempt, /No active/);
      await coordinator.runWithHeldLock("one", async () => {});
    });
  });

  it("lets two sessions register independent work", async (test) => {
    const { coordinator } = await fixture(test);
    const finish = gate();
    const entered = gate();
    const first = coordinator.runExclusive("one", async () => {
      await coordinator.runWithHeldLock("one", async () => { entered.release(); await finish.promise; });
    });
    await entered.promise;
    await coordinator.runExclusive("two", async () => {
      await coordinator.runWithHeldLock("two", async () => {});
    });
    finish.release();
    await first;
  });

  it("surfaces an error from detached protected work and then releases", async (test) => {
    const { coordinator } = await fixture(test);
    await assert.rejects(coordinator.runExclusive("one", async () => {
      void coordinator.runWithHeldLock("one", async () => { throw new Error("protected failure"); });
    }), /protected failure/);
    await coordinator.runExclusive("one", async () => {});
  });

  it("retains an uncertain lock instead of releasing with protected work pending", async (test) => {
    const { coordinator } = await fixture(test);
    const finish = gate();
    let pending!: Promise<void>;
    await assert.rejects(coordinator.runExclusive("one", async () => {
      pending = coordinator.runWithHeldLock("one", async () => { await finish.promise; });
    }, { drainTimeoutMs: 0 }), /Timed out draining/);
    assert.ok(await readFile(coordinator.pathFor("one"), "utf8"));
    await assert.rejects(coordinator.runExclusive("one", async () => {}, { timeoutMs: 0 }), /Timed out waiting/);
    finish.release();
    await pending;
  });

  it("revokes a capability when physical lock release fails", async (test) => {
    const { coordinator } = await fixture(test);
    const releaseAttempt = gate();
    let oldAttempt!: Promise<void>;
    const path = coordinator.pathFor("one");
    await assert.rejects(coordinator.runExclusive("one", async () => {
      oldAttempt = releaseAttempt.promise.then(() => coordinator.runWithHeldLock("one", async () => {}));
      await coordinator.runWithHeldLock("one", async () => {});
      await rm(path);
      await writeFile(path, "foreign lock");
    }), /ownership changed/);
    releaseAttempt.release();
    await assert.rejects(oldAttempt, /No active/);
    assert.equal(await readFile(path, "utf8"), "foreign lock");
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
