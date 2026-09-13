import { resolve } from "node:path";

import { Client, GatewayIntentBits } from "discord.js";

import { readEnvironment } from "../src/config/environment.ts";
import { NarrativeGenerator } from "../src/narrative/narrative-generator.ts";
import { NarrativePublicationService } from "../src/narrative/narrative-publication.ts";
import {
  approveNarrativeReview,
  readNarrativeReview,
  refreshNarrativeReview,
} from "../src/narrative/narrative-review.ts";
import { resolveTranscriberSecret } from "../src/transcription/transcription-dispatcher.ts";
import { createDatabaseClient } from "../src/database/client.ts";
import { EditorialLearningService } from "../src/editorial/editorial-learning-service.ts";

const [action, sessionId] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId ?? "")) {
  throw new Error("Indica una sesión válida.");
}

const environment = readEnvironment();
const database = createDatabaseClient(environment.DATABASE_URL);
const editorialLearning = new EditorialLearningService(database);
const recordingsRoot = resolve(environment.DOTTY_DATA_DIR, "recordings");
const exportsRoot = resolve(environment.DOTTY_DATA_DIR, "exports");
const exportDirectory = resolve(exportsRoot, sessionId!);
const transcriberSecret = resolveTranscriberSecret(
  environment.DOTTY_DATA_DIR,
  environment.TRANSCRIBER_SHARED_SECRET,
);
const generator = new NarrativeGenerator(
  recordingsRoot,
  exportsRoot,
  environment.OLLAMA_BASE_URL,
  environment.OLLAMA_MODEL,
  environment.TRANSCRIBER_BASE_URL,
  transcriberSecret,
  editorialLearning,
);

if (action === "generate") {
  const result = await generator.generate(sessionId!);
  const review = await refreshNarrativeReview(exportDirectory, sessionId!);
  console.log(JSON.stringify({ ok: true, action, sessionId, status: result.status, review }));
} else if (action === "status") {
  console.log(JSON.stringify({
    ok: true,
    action,
    sessionId,
    status: await generator.getStatus(sessionId!),
    review: await readNarrativeReview(exportDirectory, sessionId!),
  }));
} else if (action === "review") {
  const review = await readNarrativeReview(exportDirectory, sessionId!);
  if (review === null) {
    throw new Error("El guion todavía no tiene revisión editorial. Genéralo o verifícalo primero.");
  }
  console.log(JSON.stringify({ ok: true, action, sessionId, review }));
} else if (action === "approve") {
  const review = await approveNarrativeReview(exportDirectory, sessionId!, "panel/manual");
  console.log(JSON.stringify({ ok: true, action, sessionId, review }));
} else if (action === "publish") {
  const review = await readNarrativeReview(exportDirectory, sessionId!);
  if (review === null) {
    throw new Error("El guion todavía no tiene revisión editorial. Genéralo o verifícalo antes de publicar.");
  }
  if (review.state === "NEEDS_REVIEW") {
    throw new Error("El guion tiene escenas o errores editoriales pendientes. Revísalos antes de publicar.");
  }
  if (review.state === "READY_FOR_REVIEW") {
    await approveNarrativeReview(exportDirectory, sessionId!, "publish-action");
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(environment.DISCORD_TOKEN);
  try {
    const publication = new NarrativePublicationService(client, recordingsRoot, exportsRoot);
    const result = await publication.publish(sessionId!);
    console.log(JSON.stringify({ ok: true, action, sessionId, result }));
  } finally {
    client.destroy();
  }
} else {
  throw new Error("Acción narrativa desconocida. Usa generate, status, review, approve o publish.");
}
