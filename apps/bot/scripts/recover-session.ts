import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { createDatabaseClient } from "../src/database/client.ts";
import { writeJsonAtomically } from "../src/recording/atomic-json-file.ts";
import { PrismaSessionRepository } from "../src/sessions/session-repository.ts";
import { SessionService } from "../src/sessions/session-service.ts";
import { resolveTranscriberSecret } from "../src/transcription/transcription-dispatcher.ts";

const sessionId = process.argv[2] ?? "";
if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Identificador de sesión inválido.");

const projectRoot = resolve(import.meta.dirname, "../../..");
loadDotenv({ path: join(projectRoot, ".env") });
const configuredData = process.env.DOTTY_DATA_DIR?.trim() || "./data";
const dataRoot = resolve(projectRoot, configuredData);
const recordingRoot = join(dataRoot, "recordings", basename(sessionId));
const manifestPath = join(recordingRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  status: string;
  endedAt: string | null;
  chunks: unknown[];
  publication?: unknown;
};
if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
  throw new Error("La sesión no conserva audio recuperable.");
}
if (manifest.publication !== undefined) {
  throw new Error("La sesión ya está publicada; usa Reprocesar desde Discord.");
}

const statusFile = join(dataRoot, "dotty.status.json");
let botRunning = false;
try {
  const status = JSON.parse(await readFile(statusFile, "utf8")) as { pid?: number };
  if (Number.isInteger(status.pid)) {
    process.kill(status.pid!, 0);
    botRunning = true;
  }
} catch {
  botRunning = false;
}
if (botRunning && ["recording", "paused", "finalizing"].includes(manifest.status)) {
  throw new Error("La grabación todavía está activa. Apaga Dotty antes de forzar su recuperación.");
}

const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const backupRoot = join(dataRoot, "recovery-backups", sessionId, stamp);
await mkdir(backupRoot, { recursive: true });
await copyFile(manifestPath, join(backupRoot, "manifest.json"));

const databaseUrl = process.env.DATABASE_URL ?? "file:../../data/dotty.db";
const database = createDatabaseClient(databaseUrl);
try {
  const sessions = new SessionService(new PrismaSessionRepository(database));
  const session = await sessions.findById(sessionId);
  if (session === null) throw new Error("La sesión no existe en la base de datos.");

  const secret = resolveTranscriberSecret(
    dataRoot,
    process.env.TRANSCRIBER_SHARED_SECRET ?? "",
  );
  const baseUrl = process.env.TRANSCRIBER_BASE_URL ?? "http://127.0.0.1:8765";
  const response = await fetch(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, baseUrl), {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`El transcriptor respondió HTTP ${response.status}.`);

  const endedAt = manifest.endedAt ? new Date(manifest.endedAt) : new Date();
  if (session.status === "failed") await sessions.recoverFailed(sessionId, endedAt);
  else if (["recording", "paused", "finalizing"].includes(session.status)) {
    await sessions.recoverInterrupted([sessionId], endedAt);
  }

  manifest.status = "completed";
  manifest.endedAt = endedAt.toISOString();
  await Promise.all([
    rm(join(recordingRoot, ".transcription-enqueued"), { force: true }),
    rm(join(recordingRoot, ".transcription-jobs"), { recursive: true, force: true }),
    rm(join(recordingRoot, ".transcription-failed"), { force: true }),
    rm(join(recordingRoot, ".transcription-published"), { force: true }),
    rm(join(dataRoot, "exports", sessionId), { recursive: true, force: true }),
  ]);
  await writeJsonAtomically(manifestPath, manifest);
  await stat(manifestPath);
  console.log(JSON.stringify({ ok: true, sessionId, chunks: manifest.chunks.length, backupRoot }));
} finally {
  await database.$disconnect();
}
