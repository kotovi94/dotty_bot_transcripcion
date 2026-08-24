import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { describe, it } from "node:test";

import { WavFileWriter } from "./wav-writer.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL must be set by the test runner.");
}
const databasePath = databaseUrl.slice("file:".length);

describe("WavFileWriter", () => {
  it("writes a valid PCM WAV header with final sizes", async () => {
    const path = join(dirname(databasePath), "sample.wav");
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const writer = new WavFileWriter(path);
    writer.end(pcm);
    await finished(writer);

    const wav = readFileSync(path);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
    assert.equal(wav.readUInt32LE(24), 48_000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(40), pcm.length);
    assert.deepEqual(wav.subarray(44), pcm);
  });
});
