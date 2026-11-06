import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import type { Logger } from "pino";

import type { NarrativeManager } from "../narrative/narrative-manager.ts";
import { AutomaticNarrative } from "./automatic-narrative.ts";

it("starts a new ready draft automatically and honors durable mode and pause", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-auto-narrative-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recordings = join(root, "recordings");
  const exports = join(root, "exports");
  const sessionId = "new-session";
  await mkdir(join(recordings, sessionId), { recursive: true });
  await mkdir(join(exports, sessionId), { recursive: true });
  await writeFile(join(recordings, sessionId, "manifest.json"), JSON.stringify({
    sessionId, status: "completed", endedAt: new Date(Date.now() + 2_000).toISOString(),
  }));
  await writeFile(join(recordings, sessionId, ".transcription-ready"), "ready");
  let paused = false;
  test.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ processing_paused: paused })));
  const started: string[] = [];
  const narratives = {
    hasActiveGeneration: () => false,
    start: async (id: string) => { started.push(id); return { started: true }; },
  } as unknown as NarrativeManager;
  const logger = { warn: () => undefined } as unknown as Logger;
  const automatic = new AutomaticNarrative(root, recordings, exports, "http://127.0.0.1:8765", narratives, logger);

  await automatic.scan();
  assert.deepEqual(started, [sessionId]);
  const saved = JSON.parse(await readFile(join(root, "pipeline-mode.json"), "utf8"));
  assert.equal(saved.mode, "automatic");
  paused = true;
  await automatic.scan();
  assert.deepEqual(started, [sessionId]);
  paused = false;
  await writeFile(join(root, "pipeline-mode.json"), JSON.stringify({ ...saved, mode: "manual" }));
  await automatic.scan();
  assert.deepEqual(started, [sessionId]);
  await writeFile(join(root, "pipeline-mode.json"), JSON.stringify(saved));
  await writeFile(join(exports, sessionId, "guion.md"), "draft");
  await automatic.scan();
  assert.deepEqual(started, [sessionId]);
});
