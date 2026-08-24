import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDatabaseClient } from "../database/client.ts";
import { verifyDraft } from "./draft-verifier.ts";
import { EditorialLearningService } from "./editorial-learning-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL must be set by the test runner.");
const database = createDatabaseClient(databaseUrl);
const service = new EditorialLearningService(database);
let campaignA = "";
let campaignB = "";
let sessionA = "";
let sessionB = "";

before(async () => {
  const server = await database.discordServer.create({ data: { discordGuildId: "editorial-guild", name: "Editorial" } });
  const a = await database.campaign.create({ data: { serverId: server.id, name: "Campaña A", normalizedName: "campana a" } });
  const b = await database.campaign.create({ data: { serverId: server.id, name: "Campaña B", normalizedName: "campana b" } });
  campaignA = a.id; campaignB = b.id;
  sessionA = (await database.session.create({ data: { campaignId: a.id, sequenceNumber: 1 } })).id;
  sessionB = (await database.session.create({ data: { campaignId: b.id, sequenceNumber: 1 } })).id;
  await service.ensureCriticalRules();
});
after(async () => database.$disconnect());

describe("editorial supervised learning", () => {
  it("A: creates a candidate and never approves it automatically", async () => {
    const result = await service.submitFeedback({ sessionId: sessionA, generatedVersion: "El héroe estaba furioso sin evidencia.", editedVersion: "El héroe levantó la espada.", comment: "No atribuir emociones sin evidencia explícita." });
    assert.ok(result.candidates.length > 0);
    assert.ok(result.candidates.every((rule) => rule.status === "candidate"));
  });

  it("B: applies an approved campaign rule only to its campaign", async () => {
    const result = await service.submitFeedback({ sessionId: sessionA, generatedVersion: "Versión original suficientemente extensa.", editedVersion: "Versión corregida suficientemente extensa.", comment: "Usar un tono sobrio en esta campaña." });
    const rule = result.candidates.find((item) => item.text.includes("tono sobrio"))!;
    await service.decideRule(rule.id, "approve", "campaign");
    const same = await service.retrieve({ sessionId: sessionA, campaignId: campaignA });
    const other = await service.retrieve({ sessionId: sessionB, campaignId: campaignB });
    assert.ok(same.rules.some((item) => item.id === rule.id));
    assert.ok(!other.rules.some((item) => item.id === rule.id));
  });

  it("C: applies an approved global rule to another campaign", async () => {
    const result = await service.submitFeedback({ sessionId: sessionA, generatedVersion: "Texto original para editar.", editedVersion: "Texto corregido para editar.", comment: "Evitar metáforas que agreguen hechos." });
    const rule = result.candidates.find((item) => item.text.includes("metáforas"))!;
    await service.decideRule(rule.id, "approve", "global");
    const other = await service.retrieve({ sessionId: sessionB, campaignId: campaignB });
    assert.ok(other.rules.some((item) => item.id === rule.id));
  });

  it("D: deprecates a conflicting older rule only after human approval", async () => {
    const first = await service.submitFeedback({ sessionId: sessionA, generatedVersion: "Primera versión descriptiva.", editedVersion: "Primera corrección descriptiva.", comment: "No incluir descripciones sensoriales inventadas." });
    const firstRule = first.candidates.find((item) => item.text.includes("sensoriales"))!;
    await service.decideRule(firstRule.id, "approve", "campaign");
    const second = await service.submitFeedback({ sessionId: sessionA, generatedVersion: "Segunda versión descriptiva.", editedVersion: "Segunda corrección descriptiva.", comment: "Incluir descripciones sensoriales inventadas." });
    const secondRule = second.candidates.find((item) => item.text.startsWith("Incluir"))!;
    await service.decideRule(secondRule.id, "approve", "campaign");
    const state = await service.listState(sessionA);
    assert.equal(state.rules.find((item) => item.id === firstRule.id)?.status, "deprecated");
  });

  it("E: detects repeated corrections without auto-approving them", async () => {
    const comment = "Reducir repeticiones de la misma acción.";
    for (let index = 0; index < 3; index += 1) {
      await service.submitFeedback({ sessionId: sessionA, generatedVersion: `Texto repetido original ${index}.`, editedVersion: `Texto breve corregido ${index}.`, comment });
    }
    const state = await service.listState(sessionA);
    const repeated = state.candidates.find((item) => item.text === comment);
    assert.ok(repeated);
    assert.ok(repeated.occurrences >= 3);
    assert.equal(repeated.status, "candidate");
  });

  it("F: flags unsupported emotion and meta text independently", () => {
    const report = verifyDraft("# Campaña\n# ESCENA 1 — Puerta\nEl guardia estaba secretamente furioso. La transcripción lo confirma.", ["El guardia abrió la puerta."]);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some((item) => item.type === "unsupported"));
    assert.ok(report.issues.some((item) => item.type === "meta"));
  });

  it("G: restores a previous rule version", async () => {
    const result = await service.submitFeedback({ sessionId: sessionA, generatedVersion: "Inicio anterior de escena.", editedVersion: "Inicio corregido de escena.", comment: "Comenzar cada escena con una acción confirmada." });
    const rule = result.candidates.find((item) => item.text.includes("acción confirmada"))!;
    await service.decideRule(rule.id, "approve", "campaign");
    const restored = await service.rollbackRule(rule.id);
    assert.equal(restored.status, "candidate");
    assert.ok(restored.version >= 3);
  });
});
