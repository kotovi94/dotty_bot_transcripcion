import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type TextChannel,
} from "discord.js";
import type { Logger } from "pino";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { RecordingManifest } from "../recording/voice-capture-manager.ts";
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import { writeJsonAtomically } from "../recording/atomic-json-file.ts";
import {
  addTranscriptCorrection,
  countCorrectionMatches,
} from "../transcription/transcript-corrections.ts";
import type { ManagedSession } from "./session-repository.ts";
import type { SessionService } from "./session-service.ts";

const buttonPrefix = "dotty:session-delete:";
const campaignButtonPrefix = "dotty:campaign-delete:";
const reprocessButtonPrefix = "dotty:session-reprocess:";

export class SessionAdministration {
  constructor(
    private readonly client: Client,
    private readonly campaigns: CampaignService,
    private readonly sessions: SessionService,
    private readonly recordings: VoiceCaptureManager,
    private readonly recordingsRoot: string,
    private readonly exportsRoot: string,
    private readonly transcriberBaseUrl: string,
    private readonly transcriberSecret: string,
    private readonly logger: Logger,
  ) {}

  async deleteCampaign(
    campaignId: string,
    discordGuildId: string,
  ): Promise<{ campaignName: string; sessionCount: number }> {
    const campaign = await this.campaigns.findById(campaignId);
    if (campaign === null || campaign.discordGuildId !== discordGuildId) {
      throw new SessionDeletionError("La campaña ya no existe.");
    }
    const sessions = await this.sessions.listByCampaignId(campaign.id);
    for (const session of sessions) {
      await this.delete(session.id, discordGuildId);
    }
    await this.campaigns.deleteById(campaign.id);
    this.logger.info(
      { campaignId, sessionCount: sessions.length },
      "Campaña eliminada por un administrador",
    );
    return { campaignName: campaign.name, sessionCount: sessions.length };
  }

  async delete(sessionId: string, discordGuildId: string): Promise<ManagedSession> {
    const session = await this.sessions.findById(sessionId);
    if (session === null || session.discordGuildId !== discordGuildId) {
      throw new SessionDeletionError("La sesión ya no existe.");
    }

    if (session.status === "recording" || session.status === "paused") {
      await this.recordings.cancel(discordGuildId);
    }

    await this.deleteTranscriberJobs(session.id, false);
    await this.deleteDiscordPublication(session);
    await fs.rm(join(this.recordingsRoot, session.id), {
      recursive: true,
      force: true,
    });
    await fs.rm(join(this.exportsRoot, session.id), {
      recursive: true,
      force: true,
    });
    await this.sessions.deleteById(session.id);
    this.logger.info(
      { sessionId: session.id, sequenceNumber: session.sequenceNumber },
      "Sesion eliminada por un administrador",
    );
    return session;
  }

  async reprocess(sessionId: string, discordGuildId: string): Promise<ManagedSession> {
    const session = await this.sessions.findById(sessionId);
    if (session === null || session.discordGuildId !== discordGuildId) {
      throw new SessionDeletionError("La sesión ya no existe.");
    }
    if (session.status !== "completed" && session.status !== "failed") {
      throw new SessionDeletionError("Solo se pueden recuperar sesiones completadas o fallidas.");
    }
    const directory = join(this.recordingsRoot, session.id);
    const manifest = await this.readManifest(session.id);
    if (manifest === null || manifest.chunks.length === 0) {
      throw new SessionDeletionError("La sesión ya no conserva audio para reprocesar.");
    }
    if (session.status === "failed") {
      manifest.status = "completed";
      manifest.endedAt ??= new Date().toISOString();
      const recovered = await this.sessions.recoverFailed(
        session.id,
        new Date(manifest.endedAt),
      );
      if (!recovered) {
        throw new SessionDeletionError("La sesión cambió mientras se intentaba recuperar.");
      }
    }

    await this.deleteTranscriberJobs(session.id, true);

    await this.prepareRepublication(session, manifest);
    await fs.rm(join(directory, ".transcription-enqueued"), { force: true });
    await fs.rm(join(directory, ".transcription-failed"), { force: true });
    await fs.rm(join(directory, ".transcription-jobs"), { recursive: true, force: true });
    this.logger.info({ sessionId }, "Sesion preparada para reprocesamiento");
    return session;
  }

  async correct(
    sessionId: string,
    discordGuildId: string,
    from: string,
    to: string,
  ): Promise<{ session: ManagedSession; matches: number }> {
    const session = await this.requireCompletedSession(sessionId, discordGuildId);
    const exportPath = join(this.exportsRoot, session.id, "transcript.raw.json");
    let lines: readonly { text: string }[];
    try {
      const exported = JSON.parse(await fs.readFile(exportPath, "utf8")) as {
        lines: readonly { text: string }[];
      };
      lines = exported.lines;
    } catch {
      throw new SessionDeletionError("No encontré una transcripción publicada para corregir.");
    }
    const matches = lines.reduce(
      (total, line) => total + countCorrectionMatches(line.text, from),
      0,
    );
    if (matches === 0) {
      throw new SessionDeletionError(`No encontré «${from}» en la transcripción.`);
    }
    const directory = join(this.recordingsRoot, session.id);
    await addTranscriptCorrection(directory, from, to);
    const campaign = await this.campaigns.findByGuildAndName(
      session.discordGuildId,
      session.campaignName,
    );
    if (campaign !== null) {
      await addTranscriptCorrection(
        join(dirname(this.recordingsRoot), "campaigns", campaign.id),
        from,
        to,
      );
    }
    const manifest = await this.readManifest(session.id);
    if (manifest === null) {
      throw new SessionDeletionError("No encontré la grabación de esa sesión.");
    }
    await this.prepareRepublication(session, manifest);
    this.logger.info({ sessionId, matches }, "Correccion aplicada a una sesion");
    return { session, matches };
  }

  private async requireCompletedSession(
    sessionId: string,
    discordGuildId: string,
  ): Promise<ManagedSession> {
    const session = await this.sessions.findById(sessionId);
    if (session === null || session.discordGuildId !== discordGuildId) {
      throw new SessionDeletionError("La sesión ya no existe.");
    }
    if (session.status !== "completed") {
      throw new SessionDeletionError("Solo se pueden modificar sesiones completadas.");
    }
    return session;
  }

  private async prepareRepublication(
    session: ManagedSession,
    manifest: RecordingManifest,
  ): Promise<void> {
    const directory = join(this.recordingsRoot, session.id);
    await writeJsonAtomically(join(directory, "manifest.json"), manifest);
    await fs.rm(join(directory, ".transcription-published"), { force: true });
    await fs.rm(join(directory, ".transcription-ready"), { force: true });
    await fs.rm(join(this.exportsRoot, session.id), { recursive: true, force: true });
  }

  private async deleteTranscriberJobs(
    sessionId: string,
    required: boolean,
  ): Promise<void> {
    try {
      const response = await fetch(
        new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, this.transcriberBaseUrl),
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${this.transcriberSecret}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.logger.error(
        { sessionId, error },
        "No se pudieron eliminar los trabajos de la sesión en el transcriptor",
      );
      if (required) {
        throw new SessionDeletionError(
          "No se pudo conectar con el transcriptor. Intenta de nuevo en unos momentos.",
        );
      }
    }
  }

  private async deleteDiscordPublication(session: ManagedSession): Promise<void> {
    const manifest = await this.readManifest(session.id);
    const publication = manifest?.publication;
    if (publication?.threadId !== undefined) {
      const thread = await this.client.channels.fetch(publication.threadId);
      if (thread?.isThread()) await thread.delete("Sesión eliminada desde Dotty");
      await this.deleteMessage(publication.channelId, publication.starterMessageId);
      return;
    }

    if (publication !== undefined) {
      for (const messageId of publication.messageIds) {
        await this.deleteMessage(publication.channelId, messageId);
      }
      return;
    }

    if (session.logChannelId !== null) {
      await this.deleteLegacyThread(session);
    }
  }

  private async deleteLegacyThread(session: ManagedSession): Promise<void> {
    const channel = await this.client.channels.fetch(session.logChannelId!);
    if (
      channel?.type !== ChannelType.GuildText &&
      channel?.type !== ChannelType.GuildForum
    ) return;
    const expectedName = `Bitácora ${session.sequenceNumber} — ${session.campaignName}`.slice(
      0,
      100,
    );
    const active = await channel.threads.fetchActive();
    let thread = active.threads.find((candidate) => candidate.name === expectedName);
    if (thread === undefined) {
      const archived = await channel.threads.fetchArchived({ type: "public", limit: 100 });
      thread = archived.threads.find((candidate) => candidate.name === expectedName);
    }
    if (thread === undefined) return;
    const starterMessageId = thread.id;
    await thread.delete("Sesión eliminada desde Dotty");
    if (channel.type === ChannelType.GuildText) {
      await this.deleteMessage(channel.id, starterMessageId);
    }
  }

  private async deleteMessage(
    channelId: string,
    messageId: string | undefined,
  ): Promise<void> {
    if (messageId === undefined) return;
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) return;
    await (channel as TextChannel).messages.delete(messageId).catch(() => undefined);
  }

  private async readManifest(sessionId: string): Promise<RecordingManifest | null> {
    try {
      return JSON.parse(
        await fs.readFile(join(this.recordingsRoot, sessionId, "manifest.json"), "utf8"),
      ) as RecordingManifest;
    } catch {
      return null;
    }
  }
}

export async function handleSessionDeleteButton(
  interaction: ButtonInteraction,
  administration: SessionAdministration,
): Promise<boolean> {
  if (!interaction.customId.startsWith(buttonPrefix)) return false;
  const [, sessionId, requestedBy] = interaction.customId
    .slice(buttonPrefix.length)
    .split(":");
  if (sessionId === undefined || requestedBy === undefined) return true;

  if (interaction.user.id !== requestedBy) {
    await interaction.reply({
      content: "Solo quien solicitó el borrado puede confirmarlo.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (interaction.customId.includes(":cancelar:")) {
    await interaction.update({ content: "Borrado cancelado.", components: [], embeds: [] });
    return true;
  }
  if (
    interaction.guildId === null ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "Necesitas **Gestionar servidor** para borrar sesiones.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  try {
    const deleted = await administration.delete(sessionId, interaction.guildId);
    await interaction.editReply({
      content: `🗑️ La sesión **${deleted.sequenceNumber}** de **${deleted.campaignName}** fue eliminada. Si era la última, ese número queda disponible para repetirla.`,
      components: [],
      embeds: [],
    });
  } catch (error) {
    const message =
      error instanceof SessionDeletionError
        ? error.message
        : "No pude completar el borrado. Revisa los permisos de Dotty y vuelve a intentarlo.";
    await interaction.editReply({ content: message, components: [], embeds: [] });
  }
  return true;
}

export function sessionDeleteButtonId(
  action: "confirmar" | "cancelar",
  sessionId: string,
  requestedBy: string,
): string {
  return `${buttonPrefix}${action}:${sessionId}:${requestedBy}`;
}

export async function handleCampaignDeleteButton(
  interaction: ButtonInteraction,
  administration: SessionAdministration,
): Promise<boolean> {
  if (!interaction.customId.startsWith(campaignButtonPrefix)) return false;
  const [action, campaignId, requestedBy] = interaction.customId
    .slice(campaignButtonPrefix.length)
    .split(":");
  if (action === undefined || campaignId === undefined || requestedBy === undefined) {
    return true;
  }
  if (interaction.user.id !== requestedBy) {
    await interaction.reply({
      content: "Solo quien solicitó el borrado puede confirmarlo.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (action === "cancelar") {
    await interaction.update({ content: "Borrado cancelado.", components: [], embeds: [] });
    return true;
  }
  if (
    interaction.guildId === null ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "Necesitas **Gestionar servidor** para borrar campañas.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  try {
    const deleted = await administration.deleteCampaign(campaignId, interaction.guildId);
    await interaction.editReply({
      content: `🗑️ La campaña **${deleted.campaignName}** fue eliminada junto con ${deleted.sessionCount} sesiones y todas sus asignaciones de personajes.`,
      components: [],
      embeds: [],
    });
  } catch (error) {
    const message =
      error instanceof SessionDeletionError
        ? error.message
        : "No pude eliminar toda la campaña. Revisa los permisos de Dotty y vuelve a intentarlo.";
    await interaction.editReply({ content: message, components: [], embeds: [] });
  }
  return true;
}

export function campaignDeleteButtonId(
  action: "confirmar" | "cancelar",
  campaignId: string,
  requestedBy: string,
): string {
  return `${campaignButtonPrefix}${action}:${campaignId}:${requestedBy}`;
}

export async function handleSessionReprocessButton(
  interaction: ButtonInteraction,
  administration: SessionAdministration,
): Promise<boolean> {
  if (!interaction.customId.startsWith(reprocessButtonPrefix)) return false;
  const [action, sessionId, requestedBy] = interaction.customId
    .slice(reprocessButtonPrefix.length)
    .split(":");
  if (action === undefined || sessionId === undefined || requestedBy === undefined) {
    return true;
  }
  if (interaction.user.id !== requestedBy) {
    await interaction.reply({
      content: "Solo quien solicitó el reprocesamiento puede confirmarlo.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (action === "cancelar") {
    await interaction.update({
      content: "Reprocesamiento cancelado.",
      components: [],
      embeds: [],
    });
    return true;
  }
  if (
    interaction.guildId === null ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "Necesitas **Gestionar servidor** para reprocesar sesiones.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  try {
    const session = await administration.reprocess(sessionId, interaction.guildId);
    await interaction.editReply({
      content: `🔄 La sesión **${session.sequenceNumber}** de **${session.campaignName}** entró nuevamente a la cola. La publicación actual se conservará hasta que revises y publiques manualmente el nuevo guion.`,
      components: [],
      embeds: [],
    });
  } catch (error) {
    const message =
      error instanceof SessionDeletionError
        ? error.message
        : "No pude preparar la sesión para reprocesarla.";
    await interaction.editReply({ content: message, components: [], embeds: [] });
  }
  return true;
}

export function sessionReprocessButtonId(
  action: "confirmar" | "cancelar",
  sessionId: string,
  requestedBy: string,
): string {
  return `${reprocessButtonPrefix}${action}:${sessionId}:${requestedBy}`;
}

export class SessionDeletionError extends Error {}
