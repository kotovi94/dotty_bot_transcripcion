import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { approveNarrativeReview, refreshNarrativeReview } from "./narrative-review.ts";

import { isNarrativeGenerationActive, NarrativePublicationService } from "./narrative-publication.ts";

describe("narrative publication state gate", () => {
  it("serializes publication across service instances and clears the intent only after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-publication-lock-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const recording = join(root, "recordings", "session");
      const exported = join(root, "exports", "session");
      await mkdir(recording, { recursive: true });
      await mkdir(exported, { recursive: true });
      await writeFile(join(recording, "manifest.json"), JSON.stringify({ sessionId: "session", voiceChannelId: "voice" }));
      await writeFile(join(exported, "guion.md"), "# Campaña\n# ESCENA 1\n" + "Texto aprobado. ".repeat(10));
      await refreshNarrativeReview(exported, "session", { valid: true, issues: [], checkedAt: new Date().toISOString() });
      await approveNarrativeReview(exported, "session", "test");
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let calls = 0;
      const client = { channels: { fetch: async () => ({ id: "voice", isTextBased: () => true, isDMBased: () => false,
        send: async () => { calls += 1; entered(); await gate; return { id: "only" }; },
      }) } } as unknown as Client;
      const first = new NarrativePublicationService(client, join(root, "recordings"), join(root, "exports"));
      const second = new NarrativePublicationService(client, join(root, "recordings"), join(root, "exports"));
      const publishing = first.publish("session");
      await started;
      await assert.rejects(second.publish("session"), /otra publicación/u);
      release();
      assert.equal((await publishing).messageCount, 1);
      assert.equal(calls, 1);
      await readFile(join(recording, ".transcription-published"));
      await assert.rejects(readFile(join(recording, ".publication-attempt.json")));
    } finally { release(); await rm(root, { recursive: true, force: true }); }
  });

  it("does not duplicate a partial publication on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "dotty-publication-"));
    try {
      const recording = join(root, "recordings", "session");
      const exported = join(root, "exports", "session");
      await mkdir(recording, { recursive: true });
      await mkdir(exported, { recursive: true });
      await writeFile(join(recording, "manifest.json"), JSON.stringify({ sessionId: "session", voiceChannelId: "voice" }));
      await writeFile(join(exported, "guion.md"), "# Campaña\n# ESCENA 1\n" + "Texto aprobado. ".repeat(200));
      await refreshNarrativeReview(exported, "session", { valid: true, issues: [], checkedAt: new Date().toISOString() });
      await approveNarrativeReview(exported, "session", "test");
      let calls = 0;
      const client = { channels: { fetch: async () => ({ id: "voice", isTextBased: () => true, isDMBased: () => false,
        send: async () => { calls += 1; if (calls === 2) throw new Error("synthetic network failure"); return { id: "first" }; },
      }) } } as unknown as Client;
      const service = new NarrativePublicationService(client, join(root, "recordings"), join(root, "exports"));
      await assert.rejects(service.publish("session"), /synthetic network failure/u);
      await assert.rejects(service.publish("session"), /anterior quedó interrumpida/u);
      assert.equal(calls, 2);
      const attempt = JSON.parse(await readFile(join(recording, ".publication-attempt.json"), "utf8"));
      assert.equal(attempt.state, "pending");
      assert.equal(attempt.steps[0].messageId, "first");
      await assert.rejects(readFile(join(recording, ".transcription-published")));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks only while a replacement is actively being generated", () => {
    assert.equal(isNarrativeGenerationActive("queued"), true);
    assert.equal(isNarrativeGenerationActive("generating"), true);
    assert.equal(isNarrativeGenerationActive("ready"), false);
    assert.equal(isNarrativeGenerationActive("failed"), false);
    assert.equal(isNarrativeGenerationActive("missing"), false);
    assert.equal(isNarrativeGenerationActive(undefined), false);
  });
});
