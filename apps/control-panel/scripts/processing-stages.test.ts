import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { it } from "node:test";
import { DottySupervisor } from "../src/main/supervisor.ts";
import { deriveProcessingStages } from "../src/renderer/processing-stages.ts";
import type { DottyState, ProcessingStage, TranscriptDetail } from "../src/shared/contracts.ts";
import { createReadyMarker, serializeReadyMarker } from "../../../packages/shared/src/transcription-ready.ts";

function state(available: boolean, connected: boolean, work: DottyState["transcriber"]["work"] = null): DottyState {
  return {
    timestamp: "2026-10-20T00:00:00.000Z",
    bot: { running: connected, connected, pid: connected ? 1 : null, connectedAt: null },
    transcriber: {
      available, model: null, configuredDevice: null, activeDevice: null, computeType: null,
      queue: { queued: 0, processing: 0, completed: 0, failed: 0 }, work,
    },
    operation: null,
  };
}

function session(overrides: Partial<TranscriptDetail> = {}): TranscriptDetail {
  return {
    sessionId: "session", title: "Sesión", updatedAt: "2026-10-20T00:00:00.000Z",
    status: null, canOpenDiscord: false, narrativeState: "missing", narrativeProgress: 0,
    narrativePhase: "", narrativeError: null, narrativeReviewState: null,
    narrativeReviewPendingCount: 0, content: "", narrativeContent: null, narrativeReview: null,
    ...overrides,
  };
}

function stage(id: ProcessingStage["id"], status: ProcessingStage["status"]): ProcessingStage {
  return { id, label: id, status, details: "Estado de prueba" };
}

function display(selected: TranscriptDetail | null, system = state(false, false)) {
  return deriveProcessingStages(selected, [], system);
}

function status(stages: ReturnType<typeof display>, id: string): string | undefined {
  return stages.find((entry) => entry.id === id)?.status;
}

it("bot conectado sin sesión no completa la grabación", () => {
  assert.equal(status(display(null, state(true, true)), "capture"), "DESCONOCIDO");
});

it("Python disponible sin transcripción no completa la etapa", () => {
  assert.equal(status(display(null, state(true, false)), "transcription"), "DESCONOCIDO");
  assert.equal(status(display(session(), state(true, false)), "transcription"), "PENDIENTE");
});

it("una sesión interrumpida no completa la grabación aunque llegue una etapa antigua", () => {
  const selected = session({ status: "interrupted", processing: {
    sessionId: "session", state: "unknown", audio: { status: "completed" },
    transcription: { status: "unknown" }, narrative: { status: "unknown" },
    publication: { status: "unknown" }, stages: [stage("capture", "completed")],
  } });
  assert.equal(status(display(selected), "capture"), "AVISO");
});

it("una sesión completada con manifiesto y bitácora válidos conserva COMPLETADO", () => {
  const selected = session({ status: "completed", content: "## Transcripción\n[00:00:01] Hola", processing: {
    sessionId: "session", state: "transcript_ready", audio: { status: "completed" },
    transcriptionEvidence: { availability: "available", publication: "verified", total: 1, queued: 0, processing: 0, completed: 1, failed: 0 },
    transcription: { status: "completed" }, narrative: { status: "pending" },
    publication: { status: "pending" }, stages: [stage("capture", "completed"), stage("transcription", "completed"), stage("assembly", "pending")],
  } });
  assert.equal(status(display(selected), "capture"), "COMPLETADO");
  assert.equal(status(display(selected), "transcription"), "COMPLETADO");
  assert.equal(status(display(selected), "assembly"), "PENDIENTE");
});

it("una API Python inaccesible no completa la transcripción por defecto", () => {
  assert.equal(status(display(null, state(false, true)), "transcription"), "DESCONOCIDO");
  assert.equal(status(display(session(), state(false, true)), "transcription"), "PENDIENTE");
});

it("el trabajo activo de otra sesión no modifica la etapa seleccionada", () => {
  const selected = session({ status: "completed", processing: {
    sessionId: "session", state: "unknown", audio: { status: "completed" },
    transcription: { status: "pending" }, narrative: { status: "unknown" },
    publication: { status: "unknown" }, stages: [stage("transcription", "pending")],
  } });
  assert.equal(status(display(selected, state(true, true, { status: "processing", session_id: "other" })), "transcription"), "PENDIENTE");
});

it("la evidencia de publicación de otra sesión no completa la seleccionada", () => {
  const selected = session({ content: "bitácora anterior", processing: {
    sessionId: "other", state: "transcript_ready", audio: { status: "completed" },
    transcription: { status: "completed" }, narrative: { status: "unknown" },
    publication: { status: "unknown" }, stages: [stage("transcription", "completed")],
    transcriptionEvidence: { availability: "available", publication: "verified", total: 1, queued: 0,
      processing: 0, completed: 1, failed: 0 },
  } });
  assert.notEqual(status(display(selected), "transcription"), "COMPLETADO");
});

it("conserva estados existentes válidos y rechaza bitácora vacía", () => {
  assert.equal(status(display(session({ status: "recording" })), "capture"), "PROCESANDO");
  assert.equal(status(display(session({ status: "failed" })), "capture"), "ERROR");
  assert.equal(status(display(session({ content: "texto", status: "completed" })), "transcription"), "AVISO");
  assert.equal(status(display(session({ content: "  ", processing: {
    sessionId: "session", state: "unknown", audio: { status: "unknown" },
    transcription: { status: "completed" }, narrative: { status: "unknown" },
    publication: { status: "unknown" }, stages: [stage("transcription", "completed")],
  } })), "transcription"), "DESCONOCIDO");
  assert.equal(status(display(null, state(false, false, { status: "processing", session_id: "session" })), "transcription"), "PROCESANDO");
});

it("Supervisor deriva interrupción y finalización desde archivos de prueba aislados", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotty-h1-"));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  try {
    const recordings = join(root, "data", "recordings", "session");
    const exports = join(root, "data", "exports", "session");
    await mkdir(recordings, { recursive: true });
    await mkdir(exports, { recursive: true });
    const supervisor = new DottySupervisor(root);
    await writeFile(join(recordings, "manifest.json"), JSON.stringify({ sessionId: "session", status: "interrupted" }));
    let processing = await supervisor.getSessionProcessingStatus("session");
    assert.equal(processing.audio.status, "warning");
    assert.notEqual(processing.transcription.status, "completed");

    await writeFile(join(recordings, "manifest.json"), JSON.stringify({ sessionId: "session", status: "completed", chunks: [{ id: "chunk" }] }));
    await writeFile(join(exports, "bitacora.md"), "  \n");
    processing = await supervisor.getSessionProcessingStatus("session");
    assert.equal(processing.audio.status, "completed");
    assert.notEqual(processing.transcription.status, "completed");

    await writeFile(join(exports, "bitacora.md"), "## Transcripción\n[00:00:01] Hola");
    processing = await supervisor.getSessionProcessingStatus("session");
    assert.equal(processing.audio.status, "completed");
    assert.notEqual(processing.transcription.status, "completed");
    await writeFile(join(root, "data", "transcriber.secret"), "fixture-secret");
    await writeFile(join(recordings, ".transcription-enqueued"), "yes");
    const job = { id: "session:chunk", status: "completed", speaker_user_id: "speaker", start_offset_ms: 0,
      completed_at: "2026-01-01T00:00:00+00:00", result: { language: "es", segments: [] } };
    const transcript = Buffer.from("## Transcripción\n[00:00:01] Hola");
    await writeFile(join(recordings, ".transcription-ready"), serializeReadyMarker(
      createReadyMarker("session", [job], transcript, "2026-01-01T00:00:01.000Z"),
    ));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ session_id: "session", jobs: [job] }));
    try {
      processing = await supervisor.getSessionProcessingStatus("session");
      assert.equal(processing.transcription.status, "completed");
      await writeFile(join(exports, "bitacora.md"), "texto modificado");
      processing = await supervisor.getSessionProcessingStatus("session");
      assert.notEqual(processing.transcription.status, "completed");
    } finally { globalThis.fetch = originalFetch; }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
