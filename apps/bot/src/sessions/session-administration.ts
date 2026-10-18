import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
import type { ReprocessIntentStore } from "./reprocess-intent-store.ts";
import type { SessionFileCoordinator } from "./session-file-coordinator.ts";
import type { CampaignFileCoordinator } from "./campaign-file-coordinator.ts";
import { hasVerifiedPythonInactivity, PYTHON_INACTIVITY_PENDING_CODE } from "./python-inactivity-gate.ts";

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
    private readonly intents: ReprocessIntentStore,
    private readonly coordinator: SessionFileCoordinator,
    private readonly campaignCoordinator: CampaignFileCoordinator,
  ) {}

  async deleteCampaign(
    campaignId: string,
    discordGuildId: string,
  ): Promise<{ campaignName: string; sessionCount: number }> {
    return this.campaignCoordinator.runExclusive(campaignId, async () => {
      const campaign = await this.campaigns.findById(campaignId);
      if (campaign === null || campaign.id !== campaignId || campaign.discordGuildId !== discordGuildId) {
        throw new SessionDeletionError("La campaña ya no existe.");
      }
      const listed = [...await this.sessions.listByCampaignId(campaign.id)]
        .sort((left, right) => compareIds(left.id, right.id));
      const sessionIds = listed.map((session) => session.id);

      return this.withSessionLocks(sessionIds, async () => {
        const currentCampaign = await this.campaigns.findById(campaignId);
        if (
          currentCampaign === null || currentCampaign.id !== campaignId ||
          currentCampaign.discordGuildId !== discordGuildId
        ) {
          throw new SessionDeletionError("La campaña ya no existe.");
        }

        const currentMembers = [...await this.sessions.listByCampaignId(campaignId)]
          .sort((left, right) => compareIds(left.id, right.id));
        if (!sameSessionIds(sessionIds, currentMembers.map((session) => session.id))) {
          throw new SessionDeletionError("La pertenencia de sesiones a la campaña cambió; no se borró nada.");
        }

        const validated: ManagedSession[] = [];
        for (const member of currentMembers) {
          const session = await this.sessions.findById(member.id);
          if (
            session === null || session.id !== member.id ||
            session.discordGuildId !== discordGuildId ||
            session.campaignName !== currentCampaign.name ||
            session.status !== member.status || !isKnownSessionStatus(session.status)
          ) {
            throw new SessionDeletionError(`La sesión ${member.id} cambió o tiene un estado incierto; no se borró nada.`);
          }
          await this.assertNoPendingIntent(session.id);
          await this.assertNoUncertainDispatch(session.id);
          validated.push(session);
        }

        // Preflight every member before the first cancellation, Python DELETE,
        // publication deletion, directory removal or DB deletion.
        for (const session of validated) this.assertPythonInactivity(session.id);

        const deletedSessionIds: string[] = [];
        let currentSessionId: string | undefined;
        let campaignDeleteAttempted = false;
        try {
          for (const session of validated) {
            currentSessionId = session.id;
            await this.deleteLocked(session, discordGuildId);
            deletedSessionIds.push(session.id);
          }
          currentSessionId = undefined;
          campaignDeleteAttempted = true;
          await this.campaigns.deleteById(campaignId);
        } catch (error) {
          this.logger.error(
            {
              campaignId,
              discordGuildId,
              completedSessionIds: deletedSessionIds,
              currentSessionId,
              campaignDeleteAttempted,
              error,
            },
            "Falló el borrado de campaña después de iniciar; los efectos pueden ser parciales",
          );
          throw new SessionDeletionError(
            `El borrado de la campaña se interrumpió tras iniciar. Se completaron ${deletedSessionIds.length} sesiones; puede haber efectos parciales y no se revirtió lo realizado. Revisa los registros antes de reintentar.`,
            { cause: error },
          );
        }

        this.logger.info(
          { campaignId, sessionCount: validated.length },
          "Campaña eliminada por un administrador",
        );
        return { campaignName: currentCampaign.name, sessionCount: validated.length };
      });
    });
  }

  async delete(sessionId: string, discordGuildId: string): Promise<ManagedSession> {
    return this.coordinator.runExclusive(sessionId, async () => {
      const session = await this.sessions.findById(sessionId);
      if (session === null || session.id !== sessionId || session.discordGuildId !== discordGuildId) {
        throw new SessionDeletionError("La sesión ya no existe.");
      }
      await this.assertNoPendingIntent(sessionId);
      await this.assertNoUncertainDispatch(sessionId);
      return this.deleteLocked(session, discordGuildId);
    });
  }

  private async withSessionLocks<T>(
    sessionIds: readonly string[],
    action: () => Promise<T>,
    index = 0,
  ): Promise<T> {
    if (index >= sessionIds.length) return action();
    return this.coordinator.runExclusive(sessionIds[index]!, () =>
      this.withSessionLocks(sessionIds, action, index + 1),
    );
  }

  private async assertNoPendingIntent(sessionId: string): Promise<void> {
    let pending: boolean;
    try {
      pending = await this.intents.hasPending(sessionId);
    } catch (error) {
      throw new SessionDeletionError(
        "No se pudo verificar la intención de reprocesamiento; se conserva la grabación.",
        { cause: error },
      );
    }
    if (pending) {
      throw new SessionDeletionError("La sesión tiene un reprocesamiento pendiente; se conserva la grabación.");
    }
  }

  private async assertNoUncertainDispatch(sessionId: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(join(this.recordingsRoot, sessionId, ".transcription-jobs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new SessionDeletionError("No se pudo verificar el despacho de jobs; se conserva la grabación.", { cause: error });
    }
    if (entries.some((entry) => entry.endsWith(".posting"))) {
      throw new SessionDeletionError("Un POST de transcripción tiene aceptación incierta; se conserva la grabación.");
    }
  }

  private async deleteLocked(
    session: ManagedSession,
    discordGuildId: string,
  ): Promise<ManagedSession> {
    this.assertPythonInactivity(session.id);
    const captureCancelled = await this.recordings.cancelIfActive(discordGuildId, session.id);
    if (
      !captureCancelled &&
      (session.status === "recording" || session.status === "paused" || session.status === "finalizing")
    ) {
      throw new SessionDeletionError("No se pudo confirmar el cierre de la captura; se conservan los WAV.");
    }

    await this.deleteTranscriberJobs(session.id, false);
    await this.deleteDiscordPublication(session);
    await fs.rm(join(this.recordingsRoot, session.id), { recursive: true, force: true });
    await fs.rm(join(this.exportsRoot, session.id), { recursive: true, force: true });
    await this.sessions.deleteById(session.id);
    this.logger.info(
      { sessionId: session.id, sequenceNumber: session.sequenceNumber },
      "Sesion eliminada por un administrador",
    );
    return session;
  }

  private assertPythonInactivity(sessionId: string): void {
    if (!hasVerifiedPythonInactivity(sessionId)) throw new PythonInactivityDeletionError();
  }

  async reprocess(sessionId: string, discordGuildId: string): Promise<ManagedSession> {
    return this.coordinator.runExclusive(sessionId, async () => {
      const session = await this.sessions.findById(sessionId);
      if (session === null || session.id !== sessionId || session.discordGuildId !== discordGuildId) {
        throw new SessionDeletionError("La sesión ya no existe.");
      }
      if (session.status !== "completed" && session.status !== "failed") {
        throw new SessionDeletionError("Solo se pueden recuperar sesiones completadas o fallidas.");
      }
      await this.assertNoPendingIntent(sessionId);
      await this.assertNoUncertainDispatch(sessionId);
      const directory = join(this.recordingsRoot, session.id);
      const manifest = await this.readManifest(session.id);
      const campaign = await this.campaigns.findByGuildAndName(discordGuildId, session.campaignName);
      if (manifest === null || manifest.sessionId !== session.id ||
        campaign === null || manifest.campaignId !== campaign.id ||
        manifest.campaignName !== session.campaignName || manifest.discordGuildId !== discordGuildId ||
        (manifest.status !== "completed" && manifest.status !== "interrupted") ||
        manifest.chunks.length === 0) {
        throw new SessionDeletionError("La sesión ya no conserva un manifiesto válido para reprocesar.");
      }
      for (const chunk of manifest.chunks) {
        if (typeof chunk.file !== "string") {
          throw new SessionDeletionError("La ruta del WAV no es válida; se conserva la grabación.");
        }
        const file = resolve(directory, chunk.file);
        const within = relative(directory, file);
        if (!within || within === ".." || within.startsWith(`..\\`) || within.startsWith("../") || isAbsolute(within) ||
          !chunk.file.toLowerCase().endsWith(".wav")) {
          throw new SessionDeletionError("La ruta del WAV no es válida; se conserva la grabación.");
        }
        const info = await fs.lstat(file).catch(() => null);
        if (info === null || !info.isFile() || info.size <= 44) {
          throw new SessionDeletionError("Falta un WAV válido; se conserva la grabación.");
        }
      }
      // Python DELETE only removes queued records; it does not prove an active worker has stopped.
      await this.deleteTranscriberJobs(session.id, true);

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

      await this.prepareRepublication(session, manifest);
      await fs.rm(join(directory, ".transcription-enqueued"), { force: true });
      await fs.rm(join(directory, ".transcription-failed"), { force: true });
      await fs.rm(join(directory, ".transcription-jobs"), { recursive: true, force: true });
      this.logger.info({ sessionId }, "Sesion preparada para reprocesamiento");
      return session;
    });
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

export class PythonInactivityDeletionError extends SessionDeletionError {
  readonly code = PYTHON_INACTIVITY_PENDING_CODE;

  constructor() {
    super("El borrado queda pendiente del protocolo de inactividad Python; se conservan los WAV.");
  }
}

const knownSessionStatuses = new Set<string>([
  "scheduled",
  "recording",
  "paused",
  "finalizing",
  "completed",
  "failed",
]);

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameSessionIds(expected: readonly string[], current: readonly string[]): boolean {
  return expected.length === current.length && expected.every((id, index) => id === current[index]);
}

function isKnownSessionStatus(status: string): boolean {
  return knownSessionStatuses.has(status);
}
