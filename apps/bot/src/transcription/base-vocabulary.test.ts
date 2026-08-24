import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  baseTranscriptionVocabulary,
  priorityTranscriptionHotwords,
} from "./base-vocabulary.ts";

describe("base transcription vocabulary", () => {
  it("includes Chilean Spanish and official Spanish tabletop terms", () => {
    const vocabulary = baseTranscriptionVocabulary();
    assert.match(vocabulary, /cachái/u);
    assert.match(vocabulary, /tirada de salvación/u);
    assert.match(vocabulary, /espacio de conjuro/u);
  });

  it("keeps the directly injected defaults compact", () => {
    const hotwords = priorityTranscriptionHotwords().join(", ");
    assert.ok(hotwords.length <= 500);
    assert.equal(new Set(priorityTranscriptionHotwords()).size, priorityTranscriptionHotwords().length);
  });
});
