import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

import { splitMessage } from "../src/transcription/transcription-publisher.ts";

interface PublicationManifest {
  readonly sessionId: string;
  readonly sequenceNumber: number;
  publication?: {
    readonly channelId: string;
    readonly threadId?: string;
    readonly starterMessageId?: string;
    messageIds: string[];
  };
}

const [manifestArgument, sourceArgument] = process.argv.slice(2);
if (manifestArgument === undefined || sourceArgument === undefined) {
  throw new Error("Uso: replace-discord-publication.ts <manifest.json> <publicacion.md>");
}

dotenv.config({ path: resolve(".env") });
const token = process.env.DISCORD_TOKEN;
if (token === undefined || token.trim() === "") {
  throw new Error("Falta DISCORD_TOKEN en .env");
}

const manifestPath = resolve(manifestArgument);
const sourcePath = resolve(sourceArgument);
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as PublicationManifest;
const publication = manifest.publication;
if (publication?.threadId === undefined) {
  throw new Error("La sesión no tiene un hilo de Discord registrado.");
}

const source = await fs.readFile(sourcePath, "utf8");
const correctedSource = source.replace(
  /^(##\s+Sesi[oó]n\s+)\d+(\b.*)$/mu,
  `$1${manifest.sequenceNumber}$2`,
);
const chunks = splitMessage(correctedSource.trim(), 1_900);
if (chunks.length === 0) throw new Error("El guion está vacío.");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);

try {
  const channel = await client.channels.fetch(publication.threadId);
  if (channel === null || !channel.isThread()) {
    throw new Error("El hilo registrado ya no existe o no es accesible.");
  }
  if (channel.archived) await channel.setArchived(false, "Actualización manual de la bitácora");

  const previousMessages: Array<{ id: string; content: string }> = [];
  for (const messageId of publication.messageIds) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message !== null) previousMessages.push({ id: message.id, content: message.content });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupDirectory = join(
    dirname(dirname(dirname(manifestPath))),
    "republication-backups",
    `${manifest.sessionId}-${timestamp}-manual-script`,
  );
  await fs.mkdir(backupDirectory, { recursive: true });
  await fs.writeFile(
    join(backupDirectory, "discord-publication-before.json"),
    `${JSON.stringify({ manifest, messages: previousMessages }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(join(backupDirectory, "replacement.md"), `${correctedSource.trim()}\n`, "utf8");

  const currentIds = [...publication.messageIds];
  const nextIds: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const existingId = currentIds[index];
    if (existingId !== undefined) {
      const message = await channel.messages.fetch(existingId);
      await message.edit(chunk);
      nextIds.push(message.id);
    } else {
      const message = await channel.send(chunk);
      nextIds.push(message.id);
    }
  }

  const surplusIds = currentIds.slice(chunks.length).filter((id) => id !== publication.starterMessageId);
  for (const messageId of surplusIds) {
    await channel.messages.delete(messageId).catch(() => undefined);
  }

  publication.messageIds = nextIds;
  const temporaryManifestPath = `${manifestPath}.manual-publication.tmp`;
  await fs.writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(temporaryManifestPath, manifestPath);

  console.log(JSON.stringify({
    sessionId: manifest.sessionId,
    sequenceNumber: manifest.sequenceNumber,
    threadId: publication.threadId,
    previousMessageCount: currentIds.length,
    currentMessageCount: nextIds.length,
    backupDirectory,
  }));
} finally {
  client.destroy();
}
