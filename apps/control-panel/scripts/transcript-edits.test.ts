import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { saveTranscriptRevision } from "../src/main/transcript-edits.ts";

it("rejects an invalid second edit without leaving a stale override or changing the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotty-edits-"));
  try {
    const path = join(root, "bitacora.md");
    await writeFile(path, "original");
    const valid = "# Sesión\n## Transcripción\n[00:00:01] **Ada:** Abro la puerta.\n";
    let invalidations = 0;
    const result = await saveTranscriptRevision(path, "session", valid, async () => { invalidations += 1; });
    assert.equal(invalidations, 1);
    assert.equal(await readFile(join(root, result.backupName!), "utf8"), "original");
    const override = await readFile(join(root, "transcript.manual.json"), "utf8");
    const parsed = JSON.parse(override);
    assert.equal(parsed.sourceHash, createHash("sha256").update(valid).digest("hex"));
    assert.equal(parsed.lines[0].speakerName, "Ada");
    await assert.rejects(saveTranscriptRevision(path, "session", "sin estructura", async () => { invalidations += 1; }), /No se guardó/u);
    assert.equal(invalidations, 1);
    assert.equal(await readFile(path, "utf8"), valid);
    assert.equal(await readFile(join(root, "transcript.manual.json"), "utf8"), override);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not change source files when approval invalidation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotty-edits-failure-"));
  try {
    const path = join(root, "bitacora.md");
    await writeFile(path, "original");
    await assert.rejects(saveTranscriptRevision(path, "session", "## Transcripción\n[00:00:01] **Ada:** Hola.\n", async () => { throw new Error("synthetic failure"); }), /synthetic failure/u);
    assert.equal(await readFile(path, "utf8"), "original");
    await assert.rejects(readFile(join(root, "transcript.manual.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
