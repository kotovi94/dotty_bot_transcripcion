import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  interleaveOverlappingLines,
  splitMessage,
  splitTranscriptionSegment,
  type TranscriptLine,
} from "./transcription-publisher.ts";

describe("Discord transcript messages", () => {
  it("splits only at line boundaries and preserves all content", () => {
    const source = "uno\ndos\ntres\ncuatro";
    const chunks = splitMessage(source, 9);
    assert.deepEqual(chunks, ["uno\ndos", "tres", "cuatro"]);
    assert.equal(chunks.join("\n"), source);
    assert(chunks.every((chunk) => chunk.length <= 9));
  });

  it("never exceeds Discord's limit when a paragraph is very long", () => {
    const chunks = splitMessage("a".repeat(25), 10);
    assert.deepEqual(chunks, ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
    assert(chunks.every((chunk) => chunk.length <= 10));
  });
});

describe("timed transcript sentences", () => {
  it("uses word timestamps when a Whisper segment contains several sentences", () => {
    const lines = splitTranscriptionSegment({
      start_ms: 1_000,
      end_ms: 8_000,
      text: "Primera frase. Segunda frase.",
      words: [
        { text: " Primera", start_ms: 1_100, end_ms: 1_600, probability: 0.9 },
        { text: " frase.", start_ms: 1_650, end_ms: 2_200, probability: 0.9 },
        { text: " Segunda", start_ms: 5_100, end_ms: 5_700, probability: 0.9 },
        { text: " frase.", start_ms: 5_750, end_ms: 6_300, probability: 0.9 },
      ],
    });

    assert.deepEqual(lines.map((line) => ({ start: line.start_ms, text: line.text })), [
      { start: 1_100, text: "Primera frase." },
      { start: 5_100, text: "Segunda frase." },
    ]);
  });

  it("resumes a long speaker turn after another speaker interrupts", () => {
    const longTurn: TranscriptLine = {
      utteranceId: "speaker-a:1",
      startMs: 1_000,
      endMs: 6_000,
      speakerUserId: "speaker-a",
      speakerName: "A",
      rawText: "Primero sigo después",
      text: "Primero sigo después",
      confidence: 0.9,
      words: [
        { text: " Primero", start_ms: 1_000, end_ms: 1_500, probability: 0.9 },
        { text: " sigo", start_ms: 2_000, end_ms: 2_500, probability: 0.9 },
        { text: " después", start_ms: 5_000, end_ms: 6_000, probability: 0.9 },
      ],
    };
    const interruption: TranscriptLine = {
      utteranceId: "speaker-b:1",
      startMs: 3_000,
      endMs: 4_000,
      speakerUserId: "speaker-b",
      speakerName: "B",
      rawText: "Interrumpo",
      text: "Interrumpo",
      confidence: 0.9,
      words: [
        { text: " Interrumpo", start_ms: 3_000, end_ms: 4_000, probability: 0.9 },
      ],
    };

    const lines = interleaveOverlappingLines([longTurn, interruption]);

    assert.deepEqual(lines.map((line) => [line.startMs, line.speakerName, line.text]), [
      [1_000, "A", "Primero sigo"],
      [3_000, "B", "Interrumpo"],
      [5_000, "A", "Después"],
    ]);
    assert.deepEqual(lines.flatMap((line) => line.words.map((word) => word.text.trim())), [
      "Primero",
      "sigo",
      "Interrumpo",
      "después",
    ]);
  });
});
