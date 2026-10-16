import assert from "node:assert/strict";
import Database from "better-sqlite3";
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
      const live = new Database(join(root, "custom.db"));
      live.pragma("journal_mode = WAL");
      live.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('committed-in-wal')");
      await writeFile(join(root, ".env"), "DISCORD_TOKEN=secret", "utf8");
      await writeFile(
        join(root, "recordings", "session-1", "manifest.json"),
        JSON.stringify({ status: "completed" }),
        "utf8",
      );
      await writeFile(join(root, "recordings", "session-1", "audio.wav"), "audio", "utf8");
      await writeFile(join(root, "exports", "session-1", "bitacora.md"), "texto", "utf8");

      const manager = new BackupManager(root, `file:${join(root, "custom.db")}`);
      let backup;
      try { backup = await manager.create(); } finally { live.close(); }
      assert.equal(backup.fileCount, 4);
      assert.equal((await manager.verify(backup.name)).valid, true);
      await assert.rejects(readFile(join(backup.path, ".env"), "utf8"));

      const manifest = JSON.parse(
        await readFile(join(backup.path, "backup-manifest.json"), "utf8"),
      ) as { files: Array<{ path: string; sha256: string }> };
      assert.ok(manifest.files.find((file) => file.path === "dotty.db")?.sha256);
      const restored = new Database(join(backup.path, "dotty.db"), { readonly: true });
      try { assert.deepEqual(restored.prepare("SELECT value FROM sample").all(), [{ value: "committed-in-wal" }]); } finally { restored.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes queue, corrections, vocabulary and profiles in an isolated restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-backup-complete-"));
    try {
      for (const name of ["dotty.db", "transcriber.db"]) {
        const db = new Database(join(root, name));
        db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved')");
        db.close();
      }
      for (const folder of ["campaigns", "users", "adaptive-vocabulary"]) {
        await mkdir(join(root, folder));
        await writeFile(join(root, folder, "sample.json"), '{"preserved":true}');
      }
      await writeFile(join(root, "transcriber.secret"), "not-for-backup");
      const manager = new BackupManager(root);
      const backup = await manager.create();
      assert.equal((await manager.verify(backup.name)).valid, true);
      const queue = new Database(join(backup.path, "transcriber.db"), { readonly: true });
      try { assert.deepEqual(queue.prepare("SELECT value FROM sample").all(), [{ value: "preserved" }]); } finally { queue.close(); }
      for (const folder of ["campaigns", "users", "adaptive-vocabulary"]) assert.equal(await readFile(join(backup.path, folder, "sample.json"), "utf8"), '{"preserved":true}');
      await assert.rejects(readFile(join(backup.path, "transcriber.secret")));
    } finally { await rm(root, { recursive: true, force: true }); }
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

  it("limits an automatic snapshot to its session, preserves its diagnostics and restores both databases", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-backup-scoped-"));
    try {
      for (const name of ["dotty.db", "transcriber.db"]) {
        const db = new Database(join(root, name));
        db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('restored')");
        db.close();
      }
      for (const id of ["session-1", "session-2"]) {
        for (const folder of ["recordings", "exports", ".diagnostics"]) {
          await mkdir(join(root, folder, id), { recursive: true });
          await writeFile(join(root, folder, id, "sample.txt"), id);
        }
        await writeFile(join(root, "recordings", id, "manifest.json"), '{"status":"completed"}');
      }
      const manager = new BackupManager(root);
      const backup = await manager.create({ sessionId: "session-1", reason: "recording-finished" });
      assert.equal(backup.scope, "session");
      assert.equal((await manager.list())[0]?.scope, "session");
      assert.equal((await manager.verify(backup.name)).valid, true);
      assert.equal(await readFile(join(backup.path, ".diagnostics", "session-1", "sample.txt"), "utf8"), "session-1");
      await assert.rejects(readFile(join(backup.path, "recordings", "session-2", "manifest.json")));
      const restoreRoot = join(root, "isolated-restore");
      await mkdir(restoreRoot);
      const { copyFile } = await import("node:fs/promises");
      for (const name of ["dotty.db", "transcriber.db"]) {
        await copyFile(join(backup.path, name), join(restoreRoot, name));
        const restored = new Database(join(restoreRoot, name), { readonly: true });
        try { assert.deepEqual(restored.prepare("SELECT value FROM sample").all(), [{ value: "restored" }]); }
        finally { restored.close(); }
      }
      await assert.rejects(manager.create({ sessionId: "../session-1" }));
      await assert.rejects(manager.create({ sessionId: "missing-session" }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
