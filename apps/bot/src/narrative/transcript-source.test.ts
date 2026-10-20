import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { readNarrativeTranscript } from "./transcript-source.ts";

describe("narrative transcript source", () => {
  let root: string;
  let exportsRoot: string;
  let recordingsRoot: string;
  const sessionId = "session-test";

  before(async () => {
    root = await mkdtemp(join(process.cwd(), ".transcript-source-test-"));
    exportsRoot = join(root, "exports", sessionId);
    recordingsRoot = join(root, "recordings");
    await mkdir(exportsRoot, { recursive: true });
    await mkdir(join(recordingsRoot, sessionId), { recursive: true });
    await writeFile(join(recordingsRoot, sessionId, "manifest.json"), JSON.stringify({ campaignId: "campaign-test", campaignName: "Campaña de prueba", sequenceNumber: 2 }));
  });

  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("uses the current bitácora when a saved manual revision becomes stale", async () => {
    const oldMarkdown = "## Transcripción\n[00:00:01] **Jugador:** texto anterior\n";
    const currentMarkdown = "## Transcripción\n[00:00:01] **Personaje:** texto corregido\n";
    await writeFile(join(exportsRoot, "transcript.raw.json"), JSON.stringify({ lines: [{ speakerName: "Jugador", text: "raw anterior" }] }));
    await writeFile(join(exportsRoot, "transcript.manual.json"), JSON.stringify({
      sessionId,
      sourceHash: createHash("sha256").update(oldMarkdown).digest("hex"),
      lines: [{ speakerName: "Jugador", text: "texto anterior" }],
    }));
    await writeFile(join(exportsRoot, "bitacora.md"), currentMarkdown);

    const transcript = await readNarrativeTranscript(exportsRoot, recordingsRoot, sessionId);
    assert.equal(transcript.lines?.[0]?.speakerName, "Personaje");
    assert.equal(transcript.lines?.[0]?.text, "texto corregido");
    assert.equal(transcript.manifest?.campaignId, "campaign-test");
  });

  it("recovers a session from bitácora when raw export is absent", async () => {
    await rm(join(exportsRoot, "transcript.raw.json"));
    await rm(join(exportsRoot, "transcript.manual.json"));
    const transcript = await readNarrativeTranscript(exportsRoot, recordingsRoot, sessionId);
    assert.equal(transcript.lines?.[0]?.text, "texto corregido");
    assert.equal(transcript.manifest?.campaignName, "Campaña de prueba");
  });

  it("reports a useful error when neither source contains transcript lines", async () => {
    await writeFile(join(exportsRoot, "bitacora.md"), "## Transcripción\nSin líneas con hora y hablante.\n");
    await assert.rejects(readNarrativeTranscript(exportsRoot, recordingsRoot, sessionId), /líneas válidas.*Transcripción/u);
  });

  it("does not generate a script from the old raw while audio is being retranscribed", async () => {
    await writeFile(join(recordingsRoot, sessionId, ".transcription-regenerating"), "running");
    await assert.rejects(readNarrativeTranscript(exportsRoot, recordingsRoot, sessionId), /se está rehaciendo desde el audio/u);
  });
});
