import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateSmartChronicle } from "./smart-chronicle.ts";

describe("smart chronicle", () => {
  it("extracts only statements supported by the transcript", () => {
    const lines = [
      { startMs: 1_000, speakerName: "Aria", text: "Encontramos la llave de Barovia dentro de la torre.", confidence: 0.9 },
      { startMs: 2_000, speakerName: "Borin", text: "Decidimos regresar a la taberna antes de entrar al castillo.", confidence: 0.8 },
      { startMs: 3_000, speakerName: "Aria", text: "Para la próxima sesión tenemos que hablar con Strahd.", confidence: 0.85 },
    ];
    const result = generateSmartChronicle(lines, ["Barovia", "Strahd", "objeto ausente"]);
    assert.equal(result.keyMoments[0]?.text, lines[0]!.text);
    assert.equal(result.decisions[0]?.text, lines[1]!.text);
    assert.equal(result.pendingTasks[0]?.text, lines[2]!.text);
    assert.deepEqual(result.mentionedTerms, ["Barovia", "Strahd"]);
    assert.deepEqual(result.participants, [
      { name: "Aria", interventions: 2 },
      { name: "Borin", interventions: 1 },
    ]);
    for (const point of result.summary) {
      assert.ok(lines.some((line) => line.text === point.text));
    }
  });

  it("excludes very low-confidence text from intelligent sections", () => {
    const result = generateSmartChronicle([
      { startMs: 0, speakerName: "Aria", text: "Decidimos derrotar al dragón mañana.", confidence: 0.2 },
    ]);
    assert.equal(result.summary.length, 0);
    assert.equal(result.decisions.length, 0);
    assert.equal(result.participants[0]?.interventions, 1);
  });

  it("does not treat tutorial examples as real decisions or pending tasks", () => {
    const result = generateSmartChronicle([
      { startMs: 0, speakerName: "Guía", text: "Por ejemplo, si vamos a jugar la sesión 40, podemos indicarlo.", confidence: 0.9 },
      { startMs: 1_000, speakerName: "Guía", text: "Si necesitamos corregir algo, podemos borrar la sesión.", confidence: 0.9 },
    ]);
    assert.equal(result.decisions.length, 0);
    assert.equal(result.pendingTasks.length, 0);
  });

  it("keeps tutorial instructions out of decisions and pending tasks", () => {
    const result = generateSmartChronicle([
      { startMs: 0, speakerName: "Admin", text: "Antes de grabar debemos informar a todos los participantes.", confidence: 0.9 },
    ]);
    assert.equal(result.decisions.length, 0);
    assert.equal(result.pendingTasks.length, 0);
  });

  it("keeps explicit decisions and explicit pending tasks without inventing owners", () => {
    const result = generateSmartChronicle([
      { startMs: 0, speakerName: "Admin", text: "Entonces acordamos grabar la próxima sesión el sábado.", confidence: 0.95 },
      { startMs: 1_000, speakerName: "Admin", text: "Para la próxima sesión, Admin debe corregir el nombre de la campaña.", confidence: 0.95 },
    ]);
    assert.equal(result.decisions[0]?.text, "Entonces acordamos grabar la próxima sesión el sábado.");
    assert.equal(result.pendingTasks[0]?.text, "Para la próxima sesión, Admin debe corregir el nombre de la campaña.");
  });

  it("counts a split utterance only once", () => {
    const result = generateSmartChronicle([
      { utteranceId: "job:1", startMs: 0, speakerName: "Admin", text: "Primera oración completa.", confidence: 0.9 },
      { utteranceId: "job:1", startMs: 2_000, speakerName: "Admin", text: "Segunda oración completa.", confidence: 0.9 },
    ]);
    assert.equal(result.participants[0]?.interventions, 1);
  });
});
