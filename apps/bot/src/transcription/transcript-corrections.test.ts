import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  addTranscriptCorrection,
  applyTranscriptCorrections,
  countCorrectionMatches,
  loadTranscriptCorrections,
} from "./transcript-corrections.ts";

const directories: string[] = [];
after(async () => Promise.all(directories.map((directory) => rm(directory, { recursive: true }))));

describe("transcript corrections", () => {
  it("applies literal replacements without treating punctuation as a pattern", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dotty-corrections-"));
    directories.push(directory);
    await addTranscriptCorrection(directory, "dotty-personages", "Dotty personajes");
    await addTranscriptCorrection(directory, "40 y 1", "cuarenta y uno");
    const corrections = await loadTranscriptCorrections(directory);
    const value = "DOTTY-PERSONAGES continúa con la 40 y 1.";
    assert.equal(
      applyTranscriptCorrections(value, corrections),
      "Dotty personajes continúa con la cuarenta y uno.",
    );
    assert.equal(countCorrectionMatches(value, "dotty-personages"), 1);
    assert.match(await readFile(join(directory, "corrections.json"), "utf8"), /Dotty personajes/);
  });

  it("replaces an earlier correction for the same source phrase", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dotty-corrections-"));
    directories.push(directory);
    await addTranscriptCorrection(directory, "categoras", "categorías");
    await addTranscriptCorrection(directory, "CATEGORAS", "bitácoras");
    const corrections = await loadTranscriptCorrections(directory);
    assert.equal(corrections.length, 1);
    assert.equal(applyTranscriptCorrections("categoras", corrections), "bitácoras");
  });
});
