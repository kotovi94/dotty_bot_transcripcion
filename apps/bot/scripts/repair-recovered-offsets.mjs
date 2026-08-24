import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const sessionId = process.argv[2] ?? "";
const apply = process.argv.includes("--apply");
if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(sessionId)) {
  throw new Error("Usage: node repair-recovered-offsets.mjs <session-id> [--apply]");
}

const projectRoot = resolve(import.meta.dirname, "../../..");
const dataDirectory = resolve(projectRoot, "data");
const recordingDirectory = join(dataDirectory, "recordings", sessionId);
const manifestPath = join(recordingDirectory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.sessionId !== sessionId || !Array.isArray(manifest.chunks)) {
  throw new Error("The recording manifest does not match the requested session.");
}

const sessionStartMs = Date.parse(manifest.startedAt);
const sessionEndMs = Date.parse(manifest.endedAt ?? new Date().toISOString());
if (!Number.isFinite(sessionStartMs) || !Number.isFinite(sessionEndMs)) {
  throw new Error("The session has invalid start or end timestamps.");
}

const repairs = [];
for (const chunk of manifest.chunks) {
  if (!String(chunk.id).startsWith("recovered-") || chunk.startedOffsetMs !== 0) continue;
  const audioPath = resolve(recordingDirectory, chunk.file);
  if (!audioPath.startsWith(`${recordingDirectory}\\`) && audioPath !== recordingDirectory) {
    throw new Error(`Unsafe audio path in manifest: ${chunk.file}`);
  }
  const file = await stat(audioPath);
  const inferredStart = Math.round(file.birthtimeMs - sessionStartMs);
  if (inferredStart < 0 || file.birthtimeMs > sessionEndMs + 60_000) {
    throw new Error(`WAV creation time is outside the session: ${chunk.file}`);
  }
  const durationMs = Math.max(0, Number(chunk.endedOffsetMs) - Number(chunk.startedOffsetMs));
  repairs.push({
    chunk,
    jobId: `${sessionId}:${chunk.id}`,
    previousStartOffsetMs: chunk.startedOffsetMs,
    previousEndOffsetMs: chunk.endedOffsetMs,
    startedOffsetMs: inferredStart,
    endedOffsetMs: inferredStart + durationMs,
  });
}

if (repairs.length === 0) {
  console.log(JSON.stringify({ sessionId, repaired: 0, message: "No recovered zero-offset chunks found." }, null, 2));
  process.exit(0);
}

const databasePath = join(dataDirectory, "transcriber.db");
const database = new Database(databasePath);
const existingJobs = database.prepare(
  "SELECT id,start_offset_ms FROM transcription_job WHERE id LIKE ? ESCAPE '\\'",
).all(`${sessionId.replaceAll("%", "\\%").replaceAll("_", "\\_")}:%`);
const jobOffsets = new Map(existingJobs.map((job) => [job.id, job.start_offset_ms]));
const missingJobs = repairs.filter((repair) => !jobOffsets.has(repair.jobId));
if (missingJobs.length > 0) {
  database.close();
  throw new Error(`${missingJobs.length} transcription jobs are missing; refusing a partial repair.`);
}

const summary = {
  sessionId,
  recoveredChunks: repairs.length,
  inferredStartMinMs: Math.min(...repairs.map((repair) => repair.startedOffsetMs)),
  inferredStartMaxMs: Math.max(...repairs.map((repair) => repair.startedOffsetMs)),
  applied: apply,
};
if (!apply) {
  database.close();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupDirectory = join(dataDirectory, "repair-backups", `${sessionId}-${timestamp}`);
await mkdir(backupDirectory, { recursive: true });
await cp(manifestPath, join(backupDirectory, "manifest.json"));
const exportsDirectory = join(dataDirectory, "exports", sessionId);
await cp(exportsDirectory, join(backupDirectory, "exports"), { recursive: true, force: true }).catch(() => undefined);
for (const name of ["transcript_full.json", "transcript_full.txt", "bitacora.json", "voice_metrics.json"]) {
  await cp(join(recordingDirectory, name), join(backupDirectory, name)).catch(() => undefined);
}
await writeFile(
  join(backupDirectory, "job-offsets.json"),
  `${JSON.stringify(repairs.map((repair) => ({
    id: repair.jobId,
    start_offset_ms: jobOffsets.get(repair.jobId),
  })), null, 2)}\n`,
  "utf8",
);

for (const repair of repairs) {
  repair.chunk.startedOffsetMs = repair.startedOffsetMs;
  repair.chunk.endedOffsetMs = repair.endedOffsetMs;
}
manifest.chunks.sort((left, right) =>
  left.startedOffsetMs - right.startedOffsetMs || left.endedOffsetMs - right.endedOffsetMs,
);

const updateJob = database.prepare(
  "UPDATE transcription_job SET start_offset_ms=?, updated_at=? WHERE id=?",
);
const updateJobs = database.transaction(() => {
  const now = new Date().toISOString();
  for (const repair of repairs) {
    const result = updateJob.run(repair.startedOffsetMs, now, repair.jobId);
    if (result.changes !== 1) throw new Error(`Could not update job ${repair.jobId}`);
  }
});
updateJobs();
database.close();

const temporaryManifest = join(dirname(manifestPath), `.${basename(manifestPath)}.${randomUUID()}.tmp`);
const displacedManifest = `${manifestPath}.${randomUUID()}.bak`;
await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
await rename(manifestPath, displacedManifest);
try {
  await rename(temporaryManifest, manifestPath);
} catch (error) {
  await rename(displacedManifest, manifestPath).catch(() => undefined);
  throw error;
} finally {
  await rm(temporaryManifest, { force: true }).catch(() => undefined);
}
await rm(displacedManifest, { force: true });

console.log(JSON.stringify({ ...summary, backupDirectory }, null, 2));
