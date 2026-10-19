import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { it } from "node:test";

const projectRoot = resolve(import.meta.dirname, "../../..");
const script = join(projectRoot, "apps", "bot", "scripts", "recover-session.ts");
const tsx = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        result[`${name}/`] = "directory";
        await visit(path);
      } else {
        result[name] = (await readFile(path)).toString("hex");
      }
    }
  }
  await visit(root);
  return result;
}

async function invoke(sessionId: string, dataRoot: string, baseUrl: string) {
  const child = spawn(process.execPath, [tsx, script, sessionId], {
    cwd: projectRoot, windowsHide: true,
    env: { ...process.env, DOTTY_DATA_DIR: dataRoot,
      DATABASE_URL: `file:${join(dataRoot, "fixture.db")}`,
      TRANSCRIBER_BASE_URL: baseUrl,
      RECOVERY_PROTOCOL_PENDING_BYPASS: "true" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const [exitCode] = await once(child, "close") as [number | null];
  return { exitCode, stdout, stderr };
}

it("rejects old recovery before any filesystem, database or HTTP effect", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "dotty-recovery-disabled-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const recording = join(root, "recordings", "session-valid");
  const exports = join(root, "exports", "session-valid");
  const jobs = join(recording, ".transcription-jobs");
  await mkdir(jobs, { recursive: true });
  await mkdir(exports, { recursive: true });
  await writeFile(join(recording, "audio.wav"), Buffer.alloc(48, 1));
  await writeFile(join(recording, "manifest.json"), JSON.stringify({ status: "failed", chunks: [{ file: "audio.wav" }] }));
  await writeFile(join(recording, ".transcription-enqueued"), "queued");
  await writeFile(join(recording, ".transcription-failed"), "failed");
  await writeFile(join(recording, ".transcription-published"), "published");
  await writeFile(join(jobs, "chunk-1"), "job marker");
  await writeFile(join(exports, "bitacora.md"), "old export");
  await writeFile(join(root, "fixture.db"), "unchanged database fixture");
  const before = await snapshot(root);

  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500).end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;

  for (const id of ["session-valid", "session-valid", "session-missing"]) {
    const result = await invoke(id, root, url);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    const response = JSON.parse(result.stderr.trim()) as { ok: boolean; code: string; message: string };
    assert.deepEqual({ ok: response.ok, code: response.code },
      { ok: false, code: "RECOVERY_PROTOCOL_PENDING" });
    assert.match(response.message, /temporalmente deshabilitada/);
    assert.deepEqual(await snapshot(root), before);
    assert.equal(requests, 0);
  }
});
