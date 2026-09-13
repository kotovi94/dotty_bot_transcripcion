import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";

import type { RecordingManifest } from "../recording/voice-capture-manager.ts";
import { writeFileAtomically } from "../recording/atomic-json-file.ts";
import { splitMessage } from "../transcription/transcription-publisher.ts";
import { assertNarrativeApproved } from "./narrative-review.ts";

export class NarrativePublicationService {
  private readonly active = new Map<
    string,
    Promise<{ threadId?: string; messageCount: number; updated: boolean }>
  >();

  constructor(
    private readonly client: Client,
    private readonly recordingsRoot: string,
    private readonly exportsRoot: string,
  ) {}

  async publish(
    sessionId: string,
    discordGuildId?: string,
  ): Promise<{ threadId?: string; messageCount: number; updated: boolean }> {
    const running = this.active.get(sessionId);
    if (running !== undefined) return running;
    const task = this.publishInternal(sessionId, discordGuildId).finally(() => {
      this.active.delete(sessionId);
    });
    this.active.set(sessionId, task);
    return task;
  }

  private async publishInternal(
    sessionId: string,
    discordGuildId?: string,
  ): Promise<{ threadId?: string; messageCount: number; updated: boolean }> {
    const manifestPath = join(this.sessionDirectory(sessionId), "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RecordingManifest;
    if (discordGuildId !== undefined && manifest.discordGuildId !== discordGuildId) {
      throw new Error("La sesión no pertenece a este servidor.");
    }
    const exportDirectory = this.exportDirectory(sessionId);
    const scriptPath = join(exportDirectory, "guion.md");
    const scriptExists = await fs.access(scriptPath).then(() => true).catch(() => false);
    if (!scriptExists) {
      throw new Error("El guion todavía no existe. Genera uno antes de publicarlo.");
    }

    let narrativeStatus: { state?: string } = { state: "ready" };
    try {
      narrativeStatus = JSON.parse(
        await fs.readFile(join(exportDirectory, "guion.estado.json"), "utf8"),
      ) as { state?: string };
    } catch {
      // La aprobación editorial explícita es la barrera definitiva de publicación.
    }
    if (narrativeStatus.state !== undefined && narrativeStatus.state !== "ready") {
      throw new Error("El guion no superó la revisión de calidad y no puede publicarse.");
    }

    try {
      const verification = JSON.parse(await fs.readFile(join(exportDirectory, "guion.verificacion.json"), "utf8")) as { valid?: boolean; issues?: Array<{ severity?: string; reason?: string }> };
      const critical = verification.issues?.filter((issue) => issue.severity === "error") ?? [];
      if (verification.valid === false || critical.length > 0) throw new Error(`El verificador editorial detectó ${critical.length || 1} error(es) crítico(s). Corrige el guion antes de publicarlo.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("El verificador editorial")) throw error;
    }

    const rawScript = await fs.readFile(scriptPath, "utf8");
    const script = rawScript.trim();
    if (script.length < 100) throw new Error("El guion todavía no está listo para publicarse.");
    await assertNarrativeApproved(exportDirectory, sessionId, rawScript);

    const chunks = splitMessage(script, 1_900);
    const existing = manifest.publication;

    if (existing !== undefined) {
      const updated = await this.updateExisting(existing, chunks, scriptPath).catch(() => null);
      if (updated !== null) {
        manifest.publication = { ...existing, messageIds: updated };
        await this.persistPublication(manifestPath, manifest);
        return {
          ...(existing.threadId === undefined ? {} : { threadId: existing.threadId }),
          messageCount: updated.length,
          updated: true,
        };
      }
    }

    const created = await this.createPublication(manifest, chunks, scriptPath);
    manifest.publication = created;
    await this.persistPublication(manifestPath, manifest);
    return {
      ...(created.threadId === undefined ? {} : { threadId: created.threadId }),
      messageCount: created.messageIds.length,
      updated: false,
    };
  }

  private async updateExisting(
    publication: NonNullable<RecordingManifest["publication"]>,
    chunks: readonly string[],
    scriptPath: string,
  ): Promise<string[]> {
    const channel = await this.client.channels.fetch(
      publication.threadId ?? publication.channelId,
    );
    if (channel === null || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error("La publicación anterior ya no existe.");
    }
    if (channel.isThread() && channel.archived) {
      await channel.setArchived(false, "Actualización manual del guion");
    }

    const currentIds = [...publication.messageIds];
    const nextIds: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const currentId = currentIds[index];
      if (currentId !== undefined) {
        const message = await channel.messages.fetch(currentId);
        if (index === 0) {
          await message.edit({
            content: chunk,
            attachments: [],
            files: [{ attachment: scriptPath, name: "guion.md" }],
          });
        } else {
          await message.edit(chunk);
        }
        nextIds.push(message.id);
      } else {
        const message = index === 0
          ? await channel.send({ content: chunk, files: [{ attachment: scriptPath, name: "guion.md" }] })
          : await channel.send(chunk);
        nextIds.push(message.id);
      }
    }
    const obsoleteIds = currentIds
      .slice(chunks.length)
      .filter((messageId) => messageId !== publication.starterMessageId);
    if (obsoleteIds.length > 0 && "bulkDelete" in channel) {
      const obsolete = new Set(obsoleteIds);
      const recent = await channel.messages.fetch({ limit: 100 });
      const existing = recent.filter((message) => obsolete.has(message.id));
      if (existing.size > 0) await channel.bulkDelete(existing, true);
    } else {
      await Promise.all(obsoleteIds.map((messageId) =>
        channel.messages.delete(messageId).catch(() => undefined),
      ));
    }
    return nextIds;
  }

  private async createPublication(
    manifest: RecordingManifest,
    chunks: readonly string[],
    scriptPath: string,
  ): Promise<NonNullable<RecordingManifest["publication"]>> {
    const title = manifest.campaignName ?? "Campaña";
    const voiceChannel = await this.client.channels.fetch(manifest.voiceChannelId);
    if (voiceChannel === null || !voiceChannel.isTextBased() || voiceChannel.isDMBased()) {
      throw new Error("El canal de voz de la sesión ya no puede recibir mensajes.");
    }

    if (manifest.logChannelId !== null && manifest.logChannelId !== undefined) {
      const logChannel = await this.client.channels.fetch(manifest.logChannelId);
      if (logChannel?.type === ChannelType.GuildForum) {
        const preferredTag = logChannel.availableTags.find((tag) =>
          tag.name.toLocaleLowerCase("es").includes("bitacora"),
        ) ?? logChannel.availableTags[0];
        const thread = await logChannel.threads.create({
          name: `Sesión ${manifest.sequenceNumber} — ${title}`.slice(0, 100),
          autoArchiveDuration: 10080,
          message: {
            content: chunks[0] ?? "*(Guion vacío)*",
            files: [{ attachment: scriptPath, name: "guion.md" }],
          },
          ...(preferredTag === undefined ? {} : { appliedTags: [preferredTag.id] }),
          reason: `Publicación narrativa manual de la sesión ${manifest.sequenceNumber}`,
        });
        const messageIds = [thread.id];
        for (const chunk of chunks.slice(1)) messageIds.push((await thread.send(chunk)).id);
        await voiceChannel.send(`🎬 El guion narrativo quedó publicado en ${thread}.`).catch(() => undefined);
        return {
          channelId: logChannel.id,
          threadId: thread.id,
          starterMessageId: thread.id,
          messageIds,
        };
      }
      if (logChannel?.type === ChannelType.GuildText) {
        const starter = await logChannel.send(`🎬 **${title} — Sesión ${manifest.sequenceNumber}**`);
        const thread = await starter.startThread({
          name: `Guion ${manifest.sequenceNumber} — ${title}`.slice(0, 100),
          autoArchiveDuration: 10080,
        });
        const messageIds = await sendChunks(thread, chunks, scriptPath);
        await voiceChannel.send(`🎬 El guion narrativo quedó publicado en ${thread}.`).catch(() => undefined);
        return {
          channelId: logChannel.id,
          threadId: thread.id,
          starterMessageId: starter.id,
          messageIds,
        };
      }
    }

    const messageIds = await sendChunks(
      voiceChannel as GuildTextBasedChannel,
      splitMessage(`🎬 **${title} — Sesión ${manifest.sequenceNumber}**\n${chunks.join("\n")}`, 1_900),
      scriptPath,
    );
    return { channelId: voiceChannel.id, messageIds };
  }

  private async persistPublication(
    manifestPath: string,
    manifest: RecordingManifest,
  ): Promise<void> {
    await writeFileAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFileAtomically(
      join(dirname(manifestPath), ".transcription-published"),
      `${new Date().toISOString()}\n`,
    );
  }

  private sessionDirectory(sessionId: string): string {
    validateSessionId(sessionId);
    return resolve(this.recordingsRoot, basename(sessionId));
  }

  private exportDirectory(sessionId: string): string {
    validateSessionId(sessionId);
    return resolve(this.exportsRoot, basename(sessionId));
  }
}

async function sendChunks(
  channel: GuildTextBasedChannel,
  chunks: readonly string[],
  scriptPath?: string,
): Promise<string[]> {
  const messageIds: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const message = index === 0 && scriptPath !== undefined
      ? await channel.send({ content: chunk, files: [{ attachment: scriptPath, name: "guion.md" }] })
      : await channel.send(chunk);
    messageIds.push(message.id);
  }
  return messageIds;
}

function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error("Sesión inválida.");
}
