import { mkdtempSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const testDataRoot = resolve("../../data");
const temporaryDirectory = mkdtempSync(join(testDataRoot, "dotty-tests-"));
const databaseUrl = `file:../../data/${basename(temporaryDirectory)}/dotty-test.db`;
const testEnvironment = {
  ...process.env,
  // Prisma's Windows schema engine is more reliable when its log channel is initialized.
  RUST_LOG: "info",
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
};

const prismaCli = resolve("../../node_modules/prisma/build/index.js");
const tsxCli = resolve("../../node_modules/tsx/dist/cli.mjs");

try {
  run(process.execPath, [prismaCli, "generate"], testEnvironment);
  runWithRetries(
    process.execPath,
    [prismaCli, "migrate", "deploy"],
    testEnvironment,
    3,
  );
  run(
    process.execPath,
    [
      tsxCli,
      "--test",
      "--test-concurrency=1",
      "src/domain/session.test.ts",
      "src/config/environment.test.ts",
      "src/diagnostics/dotty-diagnostics.test.ts",
      "src/discord/dotty-panel.test.ts",
      "src/backup/backup-manager.test.ts",
      "src/campaigns/campaign-repository.test.ts",
      "src/campaigns/campaign-repository.integration.test.ts",
      "src/sessions/session-repository.integration.test.ts",
      "src/sessions/session-administration.test.ts",
      "src/sessions/session-finalization.test.ts",
      "src/recording/atomic-json-file.test.ts",
      "src/recording/wav-writer.test.ts",
      "src/recording/clip-rotation.test.ts",
      "src/storage/audio-retention-manager.test.ts",
      "src/narrative/narrative-generator.test.ts",
      "src/narrative/narrative-guards.test.ts",
      "src/editorial/editorial-learning.integration.test.ts",
      "src/transcription/transcription-dispatcher.test.ts",
      "src/transcription/base-vocabulary.test.ts",
      "src/transcription/transcription-publisher.test.ts",
      "src/transcription/overlap-deduplication.test.ts",
      "src/transcription/transcript-corrections.test.ts",
      "src/transcription/transcript-quality.test.ts",
      "src/transcription/smart-chronicle.test.ts",
      "src/transcription/adaptive-vocabulary.test.ts",
    ],
    testEnvironment,
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status ?? 1}.`);
  }
}

function runWithRetries(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  attempts: number,
): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(command, args, environment);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`Prisma migration startup failed; retrying (${attempt}/${attempts}).`);
      }
    }
  }
  throw lastError;
}
