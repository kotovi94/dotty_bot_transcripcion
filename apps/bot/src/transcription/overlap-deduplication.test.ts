import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deduplicateOverlapLines,
  formatTime,
  type TranscriptLine,
} from "./transcription-publisher.ts";

function line(id: string, startMs: number, endMs: number, text: string): TranscriptLine {
  return {
    utteranceId: id,
    startMs,
    endMs,
    speakerUserId: "daisy",
    speakerName: "Daisy",
    rawText: text,
    text,
    words: [],
    confidence: 0.9,
  };
}

describe("overlap transcript compilation", () => {
  it("removes the repeated boundary sentence and keeps global timestamps", () => {
    const result = deduplicateOverlapLines([
      line("old", 3_599_000, 3_601_200, "Hay algo detrás de esa puerta."),
      line("overlap", 3_599_050, 3_601_250, "Hay algo detras de esa puerta"),
      line("next", 3_604_000, 3_605_000, "Entonces la derribo."),
    ]);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((item) => item.startMs), [3_599_000, 3_604_000]);
  });

  it("does not remove a repeated phrase at a different time", () => {
    const result = deduplicateOverlapLines([
      line("one", 1_000, 2_000, "Sí."),
      line("two", 10_000, 11_000, "Sí."),
    ]);
    assert.equal(result.length, 2);
  });

  it("renders global timestamps across the first hour boundary", () => {
    assert.equal(formatTime(3_599_000), "00:59:59");
    assert.equal(formatTime(3_600_000), "01:00:00");
    assert.equal(formatTime(3_601_000), "01:00:01");
  });
});
