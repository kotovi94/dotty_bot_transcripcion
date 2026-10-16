import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { SessionService } from "./session-service.ts";
import { ReprocessIntentEligibility } from "./reprocess-intent-eligibility.ts";
import { ReprocessIntentStore } from "./reprocess-intent-store.ts";
import { SessionFileCoordinator } from "./session-file-coordinator.ts";

async function fixture(test: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "dotty-intent-eligibility-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recordings = join(root, "recordings");
  const directory = join(recordings, "session-1");
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "manifest.json");
  const wav = join(directory, "audio.wav");
  const manifest = {
    version: 2, sessionId: "session-1", discordGuildId: "guild-1",
    status: "completed", chunks: [{ file: "audio.wav" }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(wav, Buffer.alloc(64, 7));
  let session: { id: string; discordGuildId: string; status: string } | null = {
    id: "session-1", discordGuildId: "guild-1", status: "completed",
  };
  let readError: Error | null = null;
  const service = { findById: async () => { if (readError) throw readError; return session; } } as unknown as SessionService;
  const coordinator = new SessionFileCoordinator(join(root, "session-locks"));
  const store = new ReprocessIntentStore(join(root, "reprocess-intents"), coordinator,
    new ReprocessIntentEligibility(service, recordings));
  return { root, directory, manifestPath, wav, manifest, store,
    setSession: (value: typeof session) => { session = value; },
    setReadError: (value: Error) => { readError = value; } };
}

describe("reprocess intent eligibility", () => {
  it("creates an intent for a completed session with its original WAV", async (test) => {
    const f = await fixture(test);
    assert.equal((await f.store.create("session-1")).phase, "prepared");
  });

  it("allows a failed session with an interrupted recording and intact WAV", async (test) => {
    const f = await fixture(test);
    f.setSession({ id: "session-1", discordGuildId: "guild-1", status: "failed" });
    await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, status: "interrupted" }));
    assert.equal((await f.store.create("session-1")).phase, "prepared");
  });

  it("rejects a deleted or active session", async (test) => {
    const f = await fixture(test);
    f.setSession(null);
    await assert.rejects(f.store.create("session-1"), /missing or cannot be reprocessed/);
    f.setSession({ id: "session-1", discordGuildId: "guild-1", status: "recording" });
    await assert.rejects(f.store.create("session-1"), /missing or cannot be reprocessed/);
    assert.equal(await f.store.read("session-1"), null);
  });

  it("rejects a missing or incomplete WAV", async (test) => {
    const f = await fixture(test);
    await rm(f.wav);
    await assert.rejects(f.store.create("session-1"), /Original WAV is missing/);
    await writeFile(f.wav, Buffer.alloc(44));
    await assert.rejects(f.store.create("session-1"), /Original WAV is incomplete/);
    assert.equal(await f.store.read("session-1"), null);
  });

  it("requires every WAV listed in the manifest", async (test) => {
    const f = await fixture(test);
    await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest,
      chunks: [{ file: "audio.wav" }, { file: "missing.wav" }] }));
    await assert.rejects(f.store.create("session-1"), /Original WAV is missing/);
    assert.equal(await f.store.read("session-1"), null);
  });

  it("propagates a database read failure without writing an intent", async (test) => {
    const f = await fixture(test);
    const error = new Error("Prisma unavailable");
    f.setReadError(error);
    await assert.rejects(f.store.create("session-1"), (actual: unknown) => actual === error);
    assert.equal(await f.store.read("session-1"), null);
  });

  it("rejects an unreadable or inconsistent manifest", async (test) => {
    const f = await fixture(test);
    await writeFile(f.manifestPath, "{broken");
    await assert.rejects(f.store.create("session-1"), /manifest is missing or unreadable/);
    await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, sessionId: "other" }));
    await assert.rejects(f.store.create("session-1"), /manifest is incomplete or inconsistent/);
    assert.equal(await f.store.read("session-1"), null);
  });

  it("rejects a purge marker even when a WAV remains", async (test) => {
    const f = await fixture(test);
    await writeFile(join(f.directory, ".audio-purged"), "purged");
    await assert.rejects(f.store.create("session-1"), /Original audio was purged/);
    assert.equal((await readFile(f.wav)).length, 64);
    assert.equal(await f.store.read("session-1"), null);
  });

  it("does not acquire the same coordinator recursively", async (test) => {
    const f = await fixture(test);
    // A caller already holding the session lock must use a separate internal
    // path rather than calling create() recursively.
    const coordinator = new SessionFileCoordinator(join(f.root, "session-locks"));
    await coordinator.runExclusive("session-1", async () => {
      await assert.rejects(f.store.create("session-1"), /Reentrant/);
    });
  });
});
