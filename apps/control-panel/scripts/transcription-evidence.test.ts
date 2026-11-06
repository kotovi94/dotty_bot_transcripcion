import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createReadyMarker, serializeReadyMarker } from "../../../packages/shared/src/transcription-ready.ts";
import { DottySupervisor } from "../src/main/supervisor.ts";
import { SessionFileCoordinator } from "../../bot/src/sessions/session-file-coordinator.ts";

it("verifies only the selected session's current jobs and published transcript", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-h11-panel-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recording = join(root, "data", "recordings", "session-one");
  const exported = join(root, "data", "exports", "session-one");
  await mkdir(join(recording, ".transcription-jobs"), { recursive: true });
  await mkdir(exported, { recursive: true });
  await writeFile(join(root, "data", "transcriber.secret"), "test-secret");
  await writeFile(join(recording, ".transcription-enqueued"), "yes");
  await writeFile(join(recording, "manifest.json"), JSON.stringify({
    sessionId: "session-one", status: "completed", chunks: [{ id: "chunk-one" }],
  }));
  const bytes = Buffer.from("# Bitácora\nHola\n");
  await writeFile(join(exported, "bitacora.md"), bytes);
  const completed = { id: "session-one:chunk-one", status: "completed", speaker_user_id: "speaker",
    start_offset_ms: 0, completed_at: "2026-01-01T00:00:00+00:00", result: { language: "es", segments: [] } };
  const marker = serializeReadyMarker(createReadyMarker("session-one", [completed], bytes, "2026-01-01T00:00:01.000Z"));
  await writeFile(join(recording, ".transcription-ready"), marker);
  let response: () => Promise<Response> = async () => new Response(JSON.stringify({ session_id: "session-one", jobs: [completed] }));
  test.mock.method(globalThis, "fetch", async () => response());
  const supervisor = new DottySupervisor(root);
  const read = () => supervisor.getSessionProcessingStatus("session-one");
  assert.equal((await read()).transcription.status, "completed");

  for (const [status, expected] of [["queued", "pending"], ["processing", "running"], ["failed", "error"]] as const) {
    response = async () => new Response(JSON.stringify({ session_id: "session-one", jobs: [{ ...completed, status }] }));
    const actual = await read();
    assert.equal(actual.transcription.status, expected, status);
    assert.notEqual(actual.transcriptionEvidence?.publication, "verified");
  }
  response = async () => new Response(JSON.stringify({ session_id: "session-one", jobs: [completed] }));
  await writeFile(join(recording, ".transcription-regenerating"), "retry");
  assert.equal((await read()).transcription.status, "running");
  await unlink(join(recording, ".transcription-regenerating"));
  await writeFile(join(recording, ".transcription-jobs", "chunk-one.posting"), "uncertain");
  assert.equal((await read()).transcription.status, "pending");
  await unlink(join(recording, ".transcription-jobs", "chunk-one.posting"));

  await writeFile(join(recording, ".transcription-ready"), "2026-01-01T00:00:01.000Z\n");
  assert.equal((await read()).transcription.status, "warning");
  await writeFile(join(recording, ".transcription-ready"), "{invalid json");
  assert.notEqual((await read()).transcription.status, "completed");
  await unlink(join(recording, ".transcription-ready"));
  assert.notEqual((await read()).transcription.status, "completed");
  await writeFile(join(recording, ".transcription-ready"), marker);
  response = async () => new Response(JSON.stringify({ session_id: "session-one", jobs: [{ ...completed,
    result: { language: "en", segments: [] } }] }));
  assert.equal((await read()).transcription.status, "warning");
  response = async () => new Response(JSON.stringify({ session_id: "session-one", jobs: [completed] }));
  await writeFile(join(exported, "bitacora.md"), "manual edit\n");
  assert.equal((await read()).transcription.status, "warning");
  await writeFile(join(exported, "bitacora.md"), bytes);
  response = async () => new Response(JSON.stringify({ session_id: "session-one", jobs: [] }));
  assert.notEqual((await read()).transcription.status, "completed");
  response = async () => new Response(JSON.stringify({ session_id: "other-session", jobs: [completed] }));
  assert.equal((await read()).transcription.status, "unknown");
  response = async () => new Response("bad json");
  assert.equal((await read()).transcription.status, "unknown");
  response = async () => new Response("server error", { status: 500 });
  assert.equal((await read()).transcription.status, "unknown");
  response = async () => { throw new DOMException("timeout", "TimeoutError"); };
  assert.equal((await read()).transcription.status, "unknown");
  response = async () => new Response(JSON.stringify({ session_id: "session-one", jobs: [completed] }));
  assert.equal((await read()).transcription.status, "completed");
  const coordinator = new SessionFileCoordinator(join(root, "data", "session-locks"));
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const holding = coordinator.runExclusive("session-one", async () => { entered(); await held; });
  await ready;
  assert.equal((await read()).transcription.status, "completed");
  release();
  await holding;
  assert.equal((await read()).transcription.status, "completed");
  assert.deepEqual(await readFile(join(recording, ".transcription-ready"), "utf8"), marker);
});

it("serializes a panel transcript edit with publication for the same session", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-h11-edit-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const exported = join(root, "data", "exports", "session-one");
  await mkdir(exported, { recursive: true });
  const transcript = join(exported, "bitacora.md");
  const previous = "## Transcripción\n[00:00:01] **Voz:** Anterior\n";
  const edited = "## Transcripción\n[00:00:01] **Voz:** Editado\n";
  await writeFile(transcript, previous);
  const coordinator = new SessionFileCoordinator(join(root, "data", "session-locks"));
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const holding = coordinator.runExclusive("session-one", async () => { entered(); await held; });
  await ready;
  const saving = new DottySupervisor(root).saveTranscript("session-one", edited);
  assert.equal(await readFile(transcript, "utf8"), previous);
  release();
  await holding;
  assert.equal((await saving).saved, true);
  assert.equal(await readFile(transcript, "utf8"), edited);
});
