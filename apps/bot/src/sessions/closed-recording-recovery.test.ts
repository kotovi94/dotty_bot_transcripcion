import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import { recoverClosedRecordings } from "./closed-recording-recovery.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";
import type { ManagedSession } from "./session-repository.ts";
import type { SessionService } from "./session-service.ts";

const startedAt = "2026-10-19T23:42:34.100Z";
const endedAt = "2026-10-20T01:18:07.261Z";

async function fixture(test: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dotty-ghost-"));
  const db = new Database(join(root, "test.sqlite"));
  db.exec("CREATE TABLE Session (id TEXT PRIMARY KEY, status TEXT NOT NULL, startedAt TEXT, endedAt TEXT)");
  test.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const recordingsRoot = join(root, "recordings");
  const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const row = (id: string): ManagedSession | null => {
    const value = db.prepare("SELECT id, status, startedAt, endedAt FROM Session WHERE id = ?")
      .get(id) as { id: string; status: ManagedSession["status"]; startedAt: string | null; endedAt: string | null } | undefined;
    return value === undefined ? null : {
      id: value.id, status: value.status, startedAt: value.startedAt === null ? null : new Date(value.startedAt),
      endedAt: value.endedAt === null ? null : new Date(value.endedAt),
      discordGuildId: "guild", campaignName: "Campaign", sequenceNumber: 1,
      voiceChannelId: "voice", logChannelId: null,
    };
  };
  const sessions = {
    listActive: async () => {
      const rows = db.prepare("SELECT id FROM Session WHERE status IN ('recording','paused','finalizing')").all() as { id: string }[];
      return rows.map(({ id }) => row(id)!);
    },
    findById: async (id: string) => row(id),
    failInterrupted: async (ids: readonly string[], at: Date) => update(ids, "failed", at),
    recoverInterrupted: async (ids: readonly string[], at: Date) => update(ids, "completed", at),
  } satisfies Pick<SessionService, "listActive" | "findById" | "failInterrupted" | "recoverInterrupted">;
  function update(ids: readonly string[], status: string, at: Date): number {
    let count = 0;
    for (const id of ids) count += db.prepare("UPDATE Session SET status = ?, endedAt = ? WHERE id = ? AND status IN ('recording','paused','finalizing')")
      .run(status, at.toISOString(), id).changes;
    return count;
  }
  function insert(id: string, status = "recording") {
    db.prepare("INSERT INTO Session (id,status,startedAt) VALUES (?,?,?)").run(id, status, startedAt);
  }
  async function manifest(id: string, status: string, changes: Record<string, unknown> = {}) {
    const dir = join(recordingsRoot, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({
      sessionId: id, discordGuildId: "guild", voiceChannelId: "voice", startedAt, endedAt, status, ...changes,
    }));
    await writeFile(join(dir, "chunk.wav"), Buffer.alloc(44));
  }
  const recover = () => recoverClosedRecordings(sessions, coordinator, recordingsRoot);
  return { root, db, recordingsRoot, coordinator, row, insert, manifest, recover };
}

describe("closed recording startup recovery", () => {
  it("keeps a normal live recording active", async (t) => {
    const f = await fixture(t); f.insert("live"); await f.manifest("live", "recording");
    assert.deepEqual(await f.recover(), { recovered: [], skipped: [] });
    assert.equal(f.row("live")?.status, "recording");
  });

  it("closes a crashed recording with an interrupted manifest and preserves WAV", async (t) => {
    const f = await fixture(t); f.insert("crashed"); await f.manifest("crashed", "interrupted");
    assert.deepEqual(await f.recover(), { recovered: ["crashed"], skipped: [] });
    assert.equal(f.row("crashed")?.status, "failed");
    assert.equal(f.row("crashed")?.endedAt?.toISOString(), endedAt);
    assert.equal((await readFile(join(f.recordingsRoot, "crashed", "chunk.wav"))).length, 44);
    assert.deepEqual(await f.recover(), { recovered: [], skipped: [] });
  });

  it("recovers a completed WAV manifest left behind by a database failure", async (t) => {
    const f = await fixture(t); f.insert("closed", "finalizing"); await f.manifest("closed", "completed");
    assert.deepEqual(await f.recover(), { recovered: ["closed"], skipped: [] });
    assert.equal(f.row("closed")?.status, "completed");
  });

  it("lets a new session coexist with an interrupted one awaiting transcription", async (t) => {
    const f = await fixture(t); f.insert("old"); await f.manifest("old", "interrupted");
    await f.recover(); f.insert("new"); await f.manifest("new", "recording");
    assert.equal(f.row("old")?.status, "failed");
    assert.equal(f.row("new")?.status, "recording");
    assert.equal((await readFile(join(f.recordingsRoot, "old", "chunk.wav"))).length, 44);
  });

  it("preserves a surviving session lock and leaves the row for manual review", async (t) => {
    const f = await fixture(t); f.insert("locked"); await f.manifest("locked", "interrupted");
    const path = f.coordinator.pathFor("locked"); await mkdir(join(f.root, "session-locks"));
    await writeFile(path, '{"pid":123}');
    assert.deepEqual(await f.recover(), { recovered: [], skipped: ["locked"] });
    assert.equal(f.row("locked")?.status, "recording");
    assert.equal(await readFile(path, "utf8"), '{"pid":123}');
  });

  it("ignores a historical interrupted session already failed", async (t) => {
    const f = await fixture(t); f.insert("history", "failed"); await f.manifest("history", "interrupted");
    assert.deepEqual(await f.recover(), { recovered: [], skipped: [] });
    assert.equal(f.row("history")?.status, "failed");
  });

  it("rejects mismatched identity and missing manifests", async (t) => {
    const f = await fixture(t); f.insert("wrong"); await f.manifest("wrong", "interrupted", { discordGuildId: "other" });
    f.insert("missing");
    assert.deepEqual(await f.recover(), { recovered: [], skipped: [] });
    assert.equal(f.row("wrong")?.status, "recording");
    assert.equal(f.row("missing")?.status, "recording");
  });
});
