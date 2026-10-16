import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AutomaticBackups } from "./automatic-backups.ts";
import { ActiveRecordingBackupError, type BackupSummary } from "./backup-manager.ts";

const logger = { info: () => undefined, error: () => undefined };
async function fixture(run: (root: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dotty-auto-backup-"));
  const directory = join(root, "recordings", "session-1");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ status: "completed", endedAt: "2026-10-15", chunks: [] }));
    await run(root, directory);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function service(root: string) {
  const calls: Array<{ sessionId?: string; reason?: string }> = [];
  return { calls, valid: true, fail: false, active: false,
    async create(options = {}): Promise<BackupSummary> {
      calls.push(options);
      if (this.active) throw new ActiveRecordingBackupError();
      if (this.fail) throw new Error("Disk full");
      await mkdir(join(root, "backups"), { recursive: true });
      return { name: `backup-${calls.length}`, path: join(root, "backups"), createdAt: new Date(), fileCount: 1, totalBytes: 1 };
    },
    async verify() { return { valid: this.valid, checkedFiles: 1 }; },
  };
}

describe("AutomaticBackups", () => {
  it("backs up capture and completed transcription separately and remembers them across restarts", async () => fixture(async (root, directory) => {
    const backup = service(root);
    await new AutomaticBackups(root, backup, logger).tick();
    assert.equal(backup.calls[0]?.reason, "recording-finished");
    await writeFile(join(directory, ".transcription-ready"), "first");
    await new AutomaticBackups(root, backup, logger).tick();
    assert.equal(backup.calls[1]?.reason, "transcription-finished");
    await new AutomaticBackups(root, backup, logger).tick();
    assert.equal(backup.calls.length, 2);
    await writeFile(join(directory, ".transcription-ready"), "reprocessed");
    await new AutomaticBackups(root, backup, logger).tick();
    assert.equal(backup.calls.length, 3);
  }));

  it("retries failed, unverified and active-capture deferrals without acknowledging them", async () => fixture(async (root) => {
    const backup = service(root);
    const auto = new AutomaticBackups(root, backup, logger);
    backup.fail = true; await auto.tick();
    backup.fail = false; backup.valid = false; await auto.tick();
    backup.valid = true; backup.active = true; await auto.tick();
    await assert.rejects(readFile(join(root, "backups", "automatic-state.json")));
    backup.active = false; await auto.tick(); await auto.tick();
    assert.equal(backup.calls.length, 4);
  }));

  it("seeds only completions observed before a full backup, preserving later work", async () => fixture(async (root, directory) => {
    const backup = service(root);
    const auto = new AutomaticBackups(root, backup, logger);
    const covered = await auto.completions();
    await writeFile(join(directory, ".transcription-ready"), "finished-during-full-backup");
    await auto.seedFromFullBackup("full-verified", covered);
    await auto.tick();
    assert.deepEqual(backup.calls, [{ sessionId: "session-1", reason: "transcription-finished" }]);
  }));

  it("does not overlap scans or back up an unfinished recording", async () => fixture(async (root, directory) => {
    const backup = service(root);
    const auto = new AutomaticBackups(root, backup, logger);
    await writeFile(join(directory, "manifest.json"), '{"status":"recording"}');
    await auto.tick(); assert.equal(backup.calls.length, 0);
    await writeFile(join(directory, "manifest.json"), '{"status":"interrupted"}');
    await Promise.all([auto.tick(), auto.tick(), auto.tick()]);
    assert.equal(backup.calls.length, 1);
    await auto.stop();
  }));
});
