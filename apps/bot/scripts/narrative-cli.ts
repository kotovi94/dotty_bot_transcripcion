import { resolve } from "node:path";

import { Client, GatewayIntentBits } from "discord.js";

import { readEnvironment } from "../src/config/environment.ts";
import { NarrativeGenerator } from "../src/narrative/narrative-generator.ts";
import { NarrativePublicationService } from "../src/narrative/narrative-publication.ts";
import { resolveTranscriberSecret } from "../src/transcription/transcription-dispatcher.ts";

const [action, sessionId] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId ?? "")) {
  throw new Error("Indica una sesión válida.");
}

const environment = readEnvironment();
const recordingsRoot = resolve(environment.DOTTY_DATA_DIR, "recordings");
const exportsRoot = resolve(environment.DOTTY_DATA_DIR, "exports");
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
);

if (action === "generate") {
  const result = await generator.generate(sessionId!);
  console.log(JSON.stringify({ ok: true, action, sessionId, status: result.status }));
} else if (action === "status") {
  console.log(JSON.stringify({ ok: true, action, sessionId, status: await generator.getStatus(sessionId!) }));
} else if (action === "publish") {
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
  throw new Error("Acción narrativa desconocida. Usa generate, status o publish.");
}
