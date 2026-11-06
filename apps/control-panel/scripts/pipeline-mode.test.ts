import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { DottySupervisor } from "../src/main/supervisor.ts";

it("persists manual and automatic draft generation across panel instances", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-pipeline-mode-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"));
  const first = new DottySupervisor(root);
  const initial = await first.getPipelineMode();
  assert.equal(initial.mode, "automatic");
  assert.equal((await first.setPipelineMode("manual")).mode, "manual");
  const second = new DottySupervisor(root);
  assert.equal((await second.getPipelineMode()).mode, "manual");
  const resumed = await second.setPipelineMode("automatic");
  assert.equal(resumed.mode, "automatic");
  assert.equal(JSON.parse(await readFile(join(root, "data", "pipeline-mode.json"), "utf8")).automaticFrom, resumed.automaticFrom);
});
