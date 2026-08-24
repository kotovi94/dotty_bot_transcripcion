import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ActiveRecordingBackupError, BackupManager } from "./backup-manager.ts";

describe("BackupManager", () => {
  it("creates and verifies a backup without copying secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-backup-"));
    try {
      await mkdir(join(root, "recordings", "session-1"), { recursive: true });
      await mkdir(join(root, "exports", "session-1"), { recursive: true });
      await writeFile(join(root, "dotty.db"), "database", "utf8");
      await writeFile(join(root, ".env"), "DISCORD_TOKEN=secret", "utf8");
      await writeFile(
        join(root, "recordings", "session-1", "manifest.json"),
        JSON.stringify({ status: "completed" }),
        "utf8",
      );
      await writeFile(join(root, "recordings", "session-1", "audio.wav"), "audio", "utf8");
      await writeFile(join(root, "exports", "session-1", "bitacora.md"), "texto", "utf8");

      const manager = new BackupManager(root);
      const backup = await manager.create();
      assert.equal(backup.fileCount, 4);
      assert.equal((await manager.verify(backup.name)).valid, true);
      await assert.rejects(readFile(join(backup.path, ".env"), "utf8"));

      const manifest = JSON.parse(
        await readFile(join(backup.path, "backup-manifest.json"), "utf8"),
      ) as { files: Array<{ path: string; sha256: string }> };
      assert.equal(
        manifest.files.find((file) => file.path === "dotty.db")?.sha256,
        createHash("sha256").update("database").digest("hex"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to back up an active recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-backup-active-"));
    try {
      await mkdir(join(root, "recordings", "session-1"), { recursive: true });
      await writeFile(
        join(root, "recordings", "session-1", "manifest.json"),
        JSON.stringify({ status: "recording" }),
        "utf8",
      );
      await assert.rejects(new BackupManager(root).create(), ActiveRecordingBackupError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
