import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  averageWordConfidence,
  classifyTranscriptSegment,
  isLikelyHallucination,
  normalizeTranscriptText,
  qualitySummary,
} from "./transcript-quality.ts";

describe("transcript quality", () => {
  it("normalizes spacing and known Dotty terms without rewriting meaning", () => {
    assert.equal(
      normalizeTranscriptText("  dotty-personages   funciona , en discord. "),
      "Dotty personajes funciona, en Discord.",
    );
    assert.equal(normalizeTranscriptText("la sesión cuarenta y uno"), "La sesión cuarenta y uno");
    assert.equal(
      normalizeTranscriptText("dottyConfigurar publicará las bitágonas"),
      "Dotty configurar publicará las bitácoras",
    );
    assert.equal(
      normalizeTranscriptText("un hábito para inteligente con el resumen."),
      "Una bitácora inteligente con el resumen.",
    );
    assert.equal(
      normalizeTranscriptText("la bitócrora quedó lista.]"),
      "La bitácora quedó lista.",
    );
    assert.equal(
      normalizeTranscriptText("el foro donde se publica la bitópera."),
      "El foro donde se publica la bitácora.",
    );
    assert.equal(normalizeTranscriptText("Bitcoin no cambia."), "Bitcoin no cambia.");
  });

  it("calculates confidence and flags only strongly suspicious segments", () => {
    assert.equal(averageWordConfidence([{ text: "hola", probability: 0.8 }, { text: "mundo", probability: 0.6 }]), 0.7);
    assert.equal(isLikelyHallucination({ text: "", noSpeechProbability: 0 }), true);
    assert.equal(isLikelyHallucination({ text: "Texto normal", noSpeechProbability: 0.95, avgLogProbability: -1.2 }), true);
    assert.equal(isLikelyHallucination({ text: "Texto normal", noSpeechProbability: 0.1, avgLogProbability: -0.2 }), false);
  });

  it("reports low-confidence words and lines", () => {
    assert.deepEqual(
      qualitySummary([
        { confidence: 0.7, words: [{ text: "uno", probability: 0.7 }] },
        { confidence: 0.4, words: [{ text: "dos", probability: 0.4 }] },
      ]),
      { averageWordConfidence: 0.55, wordCount: 2, lowConfidenceWords: 1, linesToReview: 1 },
    );
  });

  it("always discards known hallucination templates", () => {
    const discarded = classifyTranscriptSegment({
      text: "Gracias por ver el video",
      avgLogProbability: -1.2,
      noSpeechProbability: 0.86,
      durationMs: 700,
      voiceRatio: 0.1,
      words: [],
    });
    assert.equal(discarded.shouldDiscard, true);
    assert.match(discarded.reason ?? "", /plantilla|frase sospechosa|ausencia de voz|baja|voz/i);

    const discardedDespiteConfidence = classifyTranscriptSegment({
      text: "Gracias por ver el video",
      avgLogProbability: -0.2,
      noSpeechProbability: 0.1,
      durationMs: 1_800,
      voiceRatio: 0.7,
      words: [{ text: "Gracias", probability: 0.93 }],
    });
    assert.equal(discardedDespiteConfidence.shouldDiscard, true);
    assert.equal(discardedDespiteConfidence.reason, "plantilla conocida de alucinación");
  });

  it("discards improbable repeated prompt phrases", () => {
    const assessment = classifyTranscriptSegment({
      text: "Dotty reanudar, Dotty reanudar, Dotty reanudar, Dotty reanudar",
      durationMs: 4_000,
      noSpeechProbability: 0.05,
      avgLogProbability: -0.1,
    });
    assert.equal(assessment.shouldDiscard, true);
    assert.equal(assessment.reason, "repetición improbable");
  });

  it("discards short repeated artifacts but keeps ordinary emphasis", () => {
    assert.equal(classifyTranscriptSegment({
      text: "Unido, Unido, Unido, Unido",
      durationMs: 3_000,
    }).shouldDiscard, true);
    assert.equal(classifyTranscriptSegment({
      text: "No, no, no, no",
      durationMs: 3_000,
    }).shouldDiscard, false);
  });

  it("discards very low confidence words", () => {
    const assessment = classifyTranscriptSegment({
      text: "Deixate iwa arnuma",
      durationMs: 2_000,
      avgLogProbability: -0.95,
      words: [
        { text: "Deixate", probability: 0.22 },
        { text: "iwa", probability: 0.18 },
      ],
    });
    assert.equal(assessment.shouldDiscard, true);
    assert.equal(assessment.reason, "confianza de palabras muy baja");
  });
});
