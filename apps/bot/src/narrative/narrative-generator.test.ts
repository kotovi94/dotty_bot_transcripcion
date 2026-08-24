import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { NarrativeGenerator } from "./narrative-generator.ts";

const analysis = [
  "### TRAMO [00:00:01–00:04:00] — La pista inicial",
  "- HECHO [00:00:01]: Ada encuentra una pista concreta durante la investigación.",
  "- DECISIÓN [00:00:20]: Ada decide seguir la pista antes de abandonar el lugar.",
  "- ACCIÓN [00:00:40]: El grupo revisa la información disponible y conserva el indicio.",
  "- PISTA [00:01:00]: La evidencia señala el siguiente paso de la investigación.",
  "- HECHO [00:01:30]: Los participantes comparan el hallazgo con lo ocurrido anteriormente.",
  "- DECISIÓN [00:02:00]: El grupo acuerda avanzar unido y comprobar el dato.",
  "- ACCIÓN [00:02:30]: Preparan la salida sin alterar ni perder la evidencia obtenida.",
  "- HECHO [00:03:00]: La escena concluye con la investigación todavía abierta.",
].join("\n");

function prologueFor(sequenceNumber: number): string {
  return `# Campaña de prueba
## Sesión ${sequenceNumber} — Ecos verificados
### PRÓLOGO — LA PISTA
**NARRADOR**
La investigación continúa a partir de una pista concreta. Ada y el resto del grupo revisan lo que saben, comparan el hallazgo con los acontecimientos anteriores y evitan dar por cierta cualquier conclusión que todavía no esté respaldada. El indicio ofrece una dirección posible, pero será necesario comprobarlo antes de convertirlo en respuesta. Con la evidencia conservada y una decisión común, el grupo se prepara para avanzar.`;
}

const scene = [
  "# ESCENA — EL SIGUIENTE PASO",
  ...Array.from({ length: 24 }, (_, index) => `Ada y el grupo revisan la pista ${index + 1} con cuidado, comparan la información disponible y mantienen el orden de los hechos. La decisión de continuar queda respaldada por el indicio encontrado, sin convertir las dudas en certezas ni atribuir palabras que no fueron registradas con claridad.`),
].join("\n\n");

const ending = `## FIN DE LA SESIÓN
**NARRADOR**
La pista permanece en manos del grupo y la decisión está tomada: deberán seguirla y comprobar qué parte de la información resiste una investigación más profunda. No hay todavía una respuesta definitiva, pero sí un próximo paso respaldado por lo ocurrido. La sesión termina con la evidencia protegida y la investigación abierta.
### CONTINUARÁ...`;

describe("NarrativeGenerator", () => {
  let root = "";
  let baseUrl = "";
  let chatCalls = 0;
  let activeChats = 0;
  let maxActiveChats = 0;
  let invalidAuditResponses = 0;
  let correctionCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
      return;
    }
    if (request.url === "/api/generate") {
      response.end(JSON.stringify({ done: true }));
      return;
    }
    if (request.url === "/api/chat") {
      chatCalls += 1;
      activeChats += 1;
      maxActiveChats = Math.max(maxActiveChats, activeChats);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: string; content?: string }>;
          format?: Record<string, unknown>;
        };
        const system = payload.messages?.find((message) => message.role === "system")?.content ?? "";
        const user = payload.messages?.find((message) => message.role === "user")?.content ?? "";
        const sessionNumber = Number((user.match(/SESIÓN:\s*(\d+)/u)?.[1] ?? "13").trim());
        const content = payload.format !== undefined
          && system.includes("resolvedor de PNJ")
          ? JSON.stringify({ resolutions: [], unresolved: [] })
          : payload.format !== undefined
            && system.includes("Clasifica líneas RAW")
              ? JSON.stringify({ items: [{ lineId: "L000001", relevance: "IMPORTANT", type: "ACTION", confidence: "HIGH" }] })
          : payload.format !== undefined
            && system.includes("auditor conservador")
            ? invalidAuditResponses > 0
              ? (invalidAuditResponses -= 1, "{invalid-audit")
              : JSON.stringify({ valid: true, issues: [] })
          : system.includes("Corrige únicamente")
            ? (correctionCalls += 1, scene)
            : payload.format !== undefined
              && system.includes("renderizador factual")
              ? JSON.stringify({ text: Array.from({ length: 22 }, () => "Ada conserva la pista y decide seguirla sin añadir información no respaldada por el registro.").join(" ") })
            : system.includes("extractor factual")
              ? JSON.stringify({ facts: [{ id: `B${String(Number((user.match(/BLOQUE\s+(\d+)/u)?.[1] ?? "1").trim())).padStart(3, "0")}-F1`, fact: "Ada encuentra una pista y decide seguirla.", confidence: "HIGH", status: "CONFIRMED", sourceText: user.match(/TRANSCRIPT_DATA\n<transcript>\n([^\n]+)/u)?.[1] ?? "Ada: Encontramos una pista y decidimos seguirla.", sourceLineIds: ["1"] }], dialogues: [], rolls: [], items: [], injuries: [], locations: [], contacts: [], plans: [], npc_candidates: [], uncertain: [] })
            : system.includes("analista documental")
          ? analysis
          : system.includes("cabecera y el prólogo")
            ? prologueFor(Number.isFinite(sessionNumber) && sessionNumber > 0 ? sessionNumber : 13)
            : system.includes("cierre de la crónica")
              ? ending
              : scene;
        setTimeout(() => {
          activeChats -= 1;
          response.end(JSON.stringify({ message: { content } }));
        }, 20);
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "dotty-narrative-"));
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No test port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await rm(root, { recursive: true, force: true });
  });

  it("creates a reviewed script without replacing the raw transcript", async () => {
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const sessionId = "session-13";
    await mkdir(join(recordings, sessionId), { recursive: true });
    await mkdir(join(exports, sessionId), { recursive: true });
    const rawPath = join(exports, sessionId, "transcript.raw.json");
    const raw = JSON.stringify({
      manifest: { sessionId, campaignId: "campaign", campaignName: "Campaña de prueba", sequenceNumber: 13 },
      lines: [{ startMs: 1_000, speakerName: "Ada", text: "Encontramos una pista y decidimos seguirla.", confidence: 0.95 }],
    });
    await writeFile(rawPath, raw, "utf8");

    const generator = new NarrativeGenerator(recordings, exports, baseUrl, "qwen3:8b");
    const result = await generator.generate(sessionId);

    assert.equal(result.status.state, "ready");
    assert.match(await readFile(join(exports, sessionId, "guion.md"), "utf8"), /Sesión 13/u);
    assert.equal(await readFile(rawPath, "utf8"), raw);
    assert.equal(JSON.parse(await readFile(join(exports, sessionId, "guion.estado.json"), "utf8")).state, "ready");
    assert.equal(chatCalls, 3);
  });

  it("serializes different sessions so one cannot unload the other's model", async () => {
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const sessionIds = ["parallel-a", "parallel-b"];
    for (const sessionId of sessionIds) {
      await mkdir(join(recordings, sessionId), { recursive: true });
      await mkdir(join(exports, sessionId), { recursive: true });
      await writeFile(join(exports, sessionId, "transcript.raw.json"), JSON.stringify({
        manifest: { sessionId, campaignId: "campaign", campaignName: "Campaña de prueba", sequenceNumber: 13 },
        lines: [{ startMs: 1_000, speakerName: "Ada", text: "Encontramos una pista y decidimos seguirla." }],
      }), "utf8");
    }
    maxActiveChats = 0;
    const generator = new NarrativeGenerator(recordings, exports, baseUrl, "qwen3:8b");

    await Promise.all(sessionIds.map((sessionId) => generator.generate(sessionId)));

    assert.equal(maxActiveChats, 1);
    assert.equal((await generator.getStatus(sessionIds[0]!)).state, "ready");
    assert.equal((await generator.getStatus(sessionIds[1]!)).state, "ready");
  });

  it("stores multi-stage evidence and scene artifacts for later resume", async () => {
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const sessionId = "pipeline-session";
    await mkdir(join(recordings, sessionId), { recursive: true });
    await mkdir(join(exports, sessionId), { recursive: true });
    await writeFile(join(exports, sessionId, "transcript.raw.json"), JSON.stringify({
      manifest: { sessionId, campaignId: "campaign", campaignName: "Campaña de prueba", sequenceNumber: 14 },
      lines: [
        { startMs: 0, speakerName: "Ada", text: "Encontramos una pista." },
        { startMs: 300_000, speakerName: "Beto", text: "La seguimos." },
      ],
    }), "utf8");

    const generator = new NarrativeGenerator(recordings, exports, baseUrl, "qwen3:8b");
    const result = await generator.generate(sessionId);

    assert.equal(result.status.state, "ready");
    const sessionState = JSON.parse(await readFile(join(exports, sessionId, "guion.work", "session_state.json"), "utf8"));
    assert.equal(sessionState.sessionId, sessionId);
    assert.ok(Array.isArray(sessionState.blocks));
    assert.ok(await readFile(join(exports, sessionId, "guion.work", "block_001_evidence.json"), "utf8").then(() => true).catch(() => false));
    assert.match(await readFile(join(exports, sessionId, "guion.md"), "utf8"), /Campaña de prueba/u);

    const evidenceFile = JSON.parse(await readFile(join(exports, sessionId, "guion.evidencias.json"), "utf8"));
    assert.ok(Array.isArray(evidenceFile.blocks));
    assert.ok(Array.isArray(evidenceFile.facts));
    assert.ok(Array.isArray(evidenceFile.sceneNotes));
  });

  it("continues and assembles when the auditor fails after retry", async () => {
    const recordings = join(root, "recordings");
    const exports = join(root, "exports");
    const sessionId = "audit-failure-session";
    await mkdir(join(recordings, sessionId), { recursive: true });
    await mkdir(join(exports, sessionId), { recursive: true });
    await writeFile(join(exports, sessionId, "transcript.raw.json"), JSON.stringify({
      manifest: { sessionId, campaignId: "campaign", campaignName: "Campaña de prueba", sequenceNumber: 15 },
      lines: [{ startMs: 0, speakerName: "Ada", text: "Encontramos una pista." }],
    }), "utf8");
    invalidAuditResponses = 2;
    correctionCalls = 0;
    const generator = new NarrativeGenerator(recordings, exports, baseUrl, "qwen3:8b");
    const result = await generator.generate(sessionId);
    const work = join(exports, sessionId, "guion.work");
    const state = JSON.parse(await readFile(join(exports, sessionId, "guion.estado.json"), "utf8"));
    const scene = JSON.parse(await readFile(join(work, "scene_001.json"), "utf8"));
    assert.equal(result.status.state, "ready");
    assert.equal(state.state, "ready");
    assert.equal(scene.audit.auditStatus, "STRUCTURED_OUTPUT_ERROR");
    assert.equal(scene.audit.status, "NEEDS_REVIEW");
    assert.equal(scene.audit.reason, "AUDITOR_PARSE_FAILED");
    assert.equal(scene.audit.reviewStatus, "NEEDS_REVIEW");
    assert.equal(correctionCalls, 0);
    assert.match(await readFile(join(exports, sessionId, "guion.md"), "utf8"), /Campaña de prueba/u);
  });
});
