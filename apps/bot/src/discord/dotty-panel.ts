import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type InteractionUpdateOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import { ActiveRecordingBackupError, type BackupManager } from "../backup/backup-manager.ts";
import { InvalidStartingSessionNumberError } from "../campaigns/campaign-repository.ts";
import { InvalidSessionTransitionError } from "../domain/session.ts";
import { formatBytes, type DottyDiagnostics } from "../diagnostics/dotty-diagnostics.ts";
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import {
  ActiveSessionExistsError,
  ActiveSessionNotFoundError,
} from "../sessions/session-repository.ts";
import type { SessionService } from "../sessions/session-service.ts";
import { finalizeSessionSafely } from "../sessions/session-finalization.ts";
import {
  campaignDeleteButtonId,
  SessionDeletionError,
  sessionDeleteButtonId,
  sessionReprocessButtonId,
  type SessionAdministration,
} from "../sessions/session-administration.ts";
import type { AudioRetentionManager } from "../storage/audio-retention-manager.ts";
import type { NarrativeManager } from "../narrative/narrative-manager.ts";
import { createPanelTutorialMessage, tutorialPageCount } from "./dotty-tutorial.ts";

export const dottyPanelCommand = new SlashCommandBuilder()
  .setName("dotty")
  .setDescription("Abre el panel privado de Dotty.")
  .setDMPermission(false);

type PanelComponentInteraction =
  | ButtonInteraction
  | ChannelSelectMenuInteraction
  | StringSelectMenuInteraction
  | UserSelectMenuInteraction
  | ModalSubmitInteraction;

interface ConfigurationDraft {
  readonly userId: string;
  readonly guildId: string;
  readonly campaignName: string;
  readonly startingSessionNumber: number;
  voiceChannelId: string | null;
  expiresAt: number;
}

const drafts = new Map<string, ConfigurationDraft>();
const draftLifetimeMs = 15 * 60 * 1000;
const panelPrefix = "dotty:ui:";

export async function handleDottyPanelCommand(
  interaction: ChatInputCommandInteraction,
  campaigns: CampaignService,
): Promise<void> {
  if (interaction.commandName !== dottyPanelCommand.name) return;
  if (interaction.guildId === null) {
    await interaction.reply({
      content: "Dotty solo funciona dentro de un servidor.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    ...(await createHome(interaction.guildId, campaigns)),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleDottyPanelInteraction(
  interaction: PanelComponentInteraction,
  campaigns: CampaignService,
  sessions: SessionService,
  recordings: VoiceCaptureManager,
  administration: SessionAdministration,
  diagnostics: DottyDiagnostics,
  audioRetention: AudioRetentionManager,
  backups: BackupManager,
  narratives: NarrativeManager,
): Promise<boolean> {
  if (!interaction.customId.startsWith(panelPrefix)) return false;
  if (interaction.guildId === null || interaction.guild === null) {
    await replyOrUpdate(interaction, { content: "Dotty solo funciona dentro de un servidor.", components: [] });
    return true;
  }

  pruneDrafts();
  const action = interaction.customId.slice(panelPrefix.length);

  if (action === "home") {
    await replyOrUpdate(interaction, await createHome(interaction.guildId, campaigns));
    return true;
  }

  if (action.startsWith("tutorial:") && interaction.isButton()) {
    const requested = Number.parseInt(action.slice("tutorial:".length), 10);
    const page = Number.isInteger(requested) && requested >= 0 && requested < tutorialPageCount
      ? requested
      : 0;
    await replyOrUpdate(interaction, createPanelTutorialMessage(page));
    return true;
  }

  if (action === "config") {
    if (!interaction.isButton()) return true;
    if (!(await requireManager(interaction))) return true;
    const modal = new ModalBuilder()
      .setCustomId(`${panelPrefix}config-details`)
      .setTitle("Configurar campaña")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("campaign-name")
            .setLabel("Nombre de la campaña")
            .setPlaceholder("Ejemplo: La Maldición de Strahd")
            .setMinLength(1)
            .setMaxLength(80)
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("session-number")
            .setLabel("Número de la próxima sesión")
            .setPlaceholder("1")
            .setValue("1")
            .setMinLength(1)
            .setMaxLength(7)
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (action === "config-details" && interaction.isModalSubmit()) {
    if (!(await requireManager(interaction))) return true;
    const campaignName = interaction.fields.getTextInputValue("campaign-name").trim();
    const numberText = interaction.fields.getTextInputValue("session-number").trim();
    const startingSessionNumber = Number(numberText);
    if (!Number.isSafeInteger(startingSessionNumber) || startingSessionNumber < 1 || startingSessionNumber > 1_000_000) {
      await replyOrUpdate(interaction, {
        content: "El número de sesión debe ser un entero entre **1** y **1.000.000**.",
        components: [homeRow()],
      });
      return true;
    }
    const token = createDraftToken();
    drafts.set(token, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      campaignName,
      startingSessionNumber,
      voiceChannelId: null,
      expiresAt: Date.now() + draftLifetimeMs,
    });
    const voiceMenu = new ChannelSelectMenuBuilder()
      .setCustomId(`${panelPrefix}config-voice:${token}`)
      .setPlaceholder("Selecciona el canal de voz o escenario")
      .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setMinValues(1)
      .setMaxValues(1);
    await replyOrUpdate(interaction, {
      content: [
        "**Configurar campaña · Paso 2 de 3**",
        `Campaña: **${escapeMarkdown(campaignName)}**`,
        `Próxima sesión: **${startingSessionNumber}**`,
        "Selecciona dónde se reunirán los participantes.",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(voiceMenu),
        homeRow("Cancelar"),
      ],
    });
    return true;
  }

  if (action.startsWith("config-voice:") && interaction.isChannelSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const token = action.slice("config-voice:".length);
    const draft = await getDraft(token, interaction);
    if (draft === null) return true;
    const channel = interaction.guild.channels.resolve(interaction.values[0]!);
    if (channel === null || !channel.isVoiceBased()) {
      await interaction.update({ content: "Selecciona un canal de voz o escenario válido.", components: [homeRow()] });
      return true;
    }
    draft.voiceChannelId = channel.id;
    draft.expiresAt = Date.now() + draftLifetimeMs;
    const logMenu = new ChannelSelectMenuBuilder()
      .setCustomId(`${panelPrefix}config-log:${token}`)
      .setPlaceholder("Selecciona el foro o canal de bitácoras")
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)
      .setMinValues(1)
      .setMaxValues(1);
    const alternatives = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${panelPrefix}config-log-voice:${token}`)
        .setLabel("Usar chat del canal de voz")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${panelPrefix}home`)
        .setLabel("Cancelar")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.update({
      content: [
        "**Configurar campaña · Paso 3 de 3**",
        `Campaña: **${escapeMarkdown(draft.campaignName)}**`,
        `Voz: <#${draft.voiceChannelId}>`,
        "Selecciona dónde se publicará una entrada por cada sesión. Recomendado: un canal de foro.",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(logMenu),
        alternatives,
      ],
    });
    return true;
  }

  if (action.startsWith("config-log:") && interaction.isChannelSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const token = action.slice("config-log:".length);
    const draft = await getDraft(token, interaction);
    if (draft === null) return true;
    await finishConfiguration(interaction, campaigns, draft, token, interaction.values[0]!);
    return true;
  }

  if (action.startsWith("config-log-voice:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const token = action.slice("config-log-voice:".length);
    const draft = await getDraft(token, interaction);
    if (draft === null) return true;
    await finishConfiguration(interaction, campaigns, draft, token, null);
    return true;
  }

  if (action === "start") {
    if (!(await requireManager(interaction))) return true;
    await showCampaignSelection(interaction, campaigns, "start-campaign", "Iniciar grabación");
    return true;
  }

  if (action === "manage") {
    if (!(await requireManager(interaction))) return true;
    await showCampaignSelection(interaction, campaigns, "manage-campaign", "Controlar sesión");
    return true;
  }

  if (action === "tools") {
    if (!(await requireManager(interaction))) return true;
    await showCampaignSelection(interaction, campaigns, "tools-campaign", "Herramientas de campaña");
    return true;
  }

  if (action.startsWith("tools-campaign:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(interaction.values[0]!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.update({
      content: `**Herramientas · ${escapeMarkdown(campaign.name)}**\nElige qué configuración o comprobación quieres realizar.`,
      components: [toolsRow(campaign.id), backupRow(), homeRow()],
    });
    return true;
  }

  if (action.startsWith("tools-open:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("tools-open:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.update({
      content: `**Herramientas · ${escapeMarkdown(campaign.name)}**\nElige qué configuración o comprobación quieres realizar.`,
      components: [toolsRow(campaign.id), backupRow(), homeRow()],
    });
    return true;
  }

  if (action.startsWith("vocabulary:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("vocabulary:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const input = new TextInputBuilder()
      .setCustomId("terms")
      .setLabel("Nombres y términos separados por comas")
      .setPlaceholder("Strahd, Barovia, tiefling, drow...")
      .setMaxLength(1000)
      .setRequired(false)
      .setStyle(TextInputStyle.Paragraph);
    if (campaign.transcriptionVocabulary.length > 0) input.setValue(campaign.transcriptionVocabulary);
    const modal = new ModalBuilder()
      .setCustomId(`${panelPrefix}vocabulary-save:${campaign.id}`)
      .setTitle("Vocabulario de la campaña")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return true;
  }

  if (action.startsWith("vocabulary-save:") && interaction.isModalSubmit()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("vocabulary-save:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await replyOrUpdate(interaction, { content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const terms = interaction.fields.getTextInputValue("terms").trim();
    const updated = await campaigns.setVocabulary(interaction.guildId, campaign.name, terms);
    await replyOrUpdate(interaction, {
      content: updated.transcriptionVocabulary.length === 0
        ? `🧹 Se eliminó el vocabulario personalizado de **${escapeMarkdown(updated.name)}**.`
        : `📚 Vocabulario actualizado para **${escapeMarkdown(updated.name)}**. Se aplicará en grabaciones nuevas y al reprocesar.`,
      components: [toolsBackRow(campaign.id)],
    });
    return true;
  }

  if (action.startsWith("diagnostics:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("diagnostics:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.deferUpdate();
    const report = await diagnostics.run(interaction.guild, campaign.name);
    const icon = { ok: "✅", warning: "⚠️", error: "❌" } as const;
    await interaction.editReply({
      content: [
        `**Diagnóstico de ${escapeMarkdown(report.campaignName)}**`,
        ...report.checks.map((check) => `${icon[check.level]} **${check.label}:** ${check.detail}`),
        "",
        report.ready ? "**Dotty está preparado para grabar.**" : "**Dotty todavía no está listo.** Corrige los elementos marcados con ❌.",
      ].join("\n"),
      components: [toolsBackRow(campaign.id)],
    });
    return true;
  }

  if (action.startsWith("storage:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("storage:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.deferUpdate();
    const report = await audioRetention.report(campaign.id);
    await interaction.editReply({
      content: [
        `**Almacenamiento · ${escapeMarkdown(campaign.name)}**`,
        `🎙️ Audio: **${formatBytes(report.audioBytes)}** en ${report.sessionsWithAudio} sesiones.`,
        `📄 Transcripciones: **${formatBytes(report.exportBytes)}**.`,
        `🧹 Sesiones cuyo audio fue limpiado: **${report.sessionsWithoutAudio}**.`,
        report.retentionDays === null
          ? "♾️ Los audios se conservan siempre."
          : `🗓️ Los audios se eliminan ${report.retentionDays} días después de publicarse.`,
        report.eligibleForCleanup === 0
          ? "No hay audios pendientes de limpieza."
          : `⚠️ Hay **${report.eligibleForCleanup}** sesiones pendientes de limpieza automática.`,
      ].join("\n"),
      components: [toolsBackRow(campaign.id)],
    });
    return true;
  }

  if (action.startsWith("retention:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("retention:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${panelPrefix}retention-save:${campaign.id}`)
      .setPlaceholder("Elige cuánto tiempo conservar el audio")
      .addOptions(
        { label: "Conservar siempre", value: "forever", emoji: "♾️" },
        { label: "Eliminar después de 7 días", value: "7" },
        { label: "Eliminar después de 30 días", value: "30" },
        { label: "Eliminar después de 90 días", value: "90" },
      );
    await interaction.update({
      content: `**Retención de audio · ${escapeMarkdown(campaign.name)}**\nSolo se eliminan WAV de sesiones publicadas. Las transcripciones y publicaciones siempre se conservan.`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), toolsBackRow(campaign.id)],
    });
    return true;
  }

  if (action.startsWith("retention-save:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("retention-save:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const selected = interaction.values[0]!;
    const days = selected === "forever" ? null : Number.parseInt(selected, 10);
    const updated = await campaigns.setAudioRetention(interaction.guildId, campaign.name, days);
    await interaction.update({
      content: updated.audioRetentionDays === null
        ? `♾️ Los audios de **${escapeMarkdown(updated.name)}** se conservarán hasta que elimines sus sesiones.`
        : `🧹 Los WAV de **${escapeMarkdown(updated.name)}** se eliminarán ${updated.audioRetentionDays} días después de publicarse.`,
      components: [toolsBackRow(campaign.id)],
    });
    return true;
  }

  if (action === "backup-create" && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    await interaction.deferUpdate();
    try {
      const backup = await backups.create();
      await interaction.editReply({
        content: [
          "✅ **Respaldo local creado y verificado durante la copia.**",
          `Fecha: ${backup.createdAt.toLocaleString("es-CL")}`,
          `Archivos: **${backup.fileCount}** · Tamaño: **${formatBytes(backup.totalBytes)}**`,
          `Carpeta: \`${backup.path}\``,
          "Incluye campañas, personajes, sesiones, audios, manifiestos y transcripciones. No incluye `.env`, tokens ni secretos.",
        ].join("\n"),
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${panelPrefix}backup-verify:${backup.name}`).setLabel("Verificar integridad").setEmoji("✅").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${panelPrefix}backup-list`).setLabel("Ver respaldos").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    } catch (error) {
      await interaction.editReply({
        content: error instanceof ActiveRecordingBackupError
          ? `⚠️ ${error.message}`
          : "No pude crear el respaldo. Revisa el espacio disponible y los registros de Dotty.",
        components: [homeRow()],
      });
    }
    return true;
  }

  if (action === "backup-list") {
    if (!(await requireManager(interaction))) return true;
    await interaction.deferUpdate();
    const available = await backups.list(10);
    const controls = available.length === 0
      ? [homeRow()]
      : [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${panelPrefix}backup-verify:${available[0]!.name}`).setLabel("Verificar el más reciente").setEmoji("✅").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
          ),
        ];
    await interaction.editReply({
      content: available.length === 0
        ? "Todavía no hay respaldos locales."
        : [
            "**Respaldos locales más recientes**",
            ...available.map((backup) =>
              `• ${backup.createdAt.toLocaleString("es-CL")} · **${formatBytes(backup.totalBytes)}** · ${backup.fileCount} archivos`,
            ),
            "",
            "Los respaldos se conservan hasta que los elimines manualmente desde el computador.",
          ].join("\n"),
      components: controls,
    });
    return true;
  }

  if (action.startsWith("backup-verify:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const name = action.slice("backup-verify:".length);
    await interaction.deferUpdate();
    const result = await backups.verify(name);
    await interaction.editReply({
      content: result.valid
        ? `✅ Respaldo íntegro: se comprobaron **${result.checkedFiles} archivos** y todos conservan su tamaño y huella SHA-256.`
        : `❌ El respaldo no pasó la verificación. Se comprobaron ${result.checkedFiles} archivos antes de detectar el problema. No lo uses para restaurar datos.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${panelPrefix}backup-list`).setLabel("Ver respaldos").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return true;
  }

  if (action === "privacy") {
    await replyOrUpdate(interaction, {
      content: [
        "**Privacidad y grabación de Dotty**",
        "• Dotty no entra ni graba hasta que una persona administradora confirma que todos fueron informados.",
        "• El canal de voz recibe avisos al iniciar, pausar, reanudar y finalizar.",
        "• Audio y transcripciones se procesan y guardan localmente en este computador.",
        "• La retención automática elimina solamente audios de sesiones ya publicadas.",
        "• Eliminar una sesión borra su audio, transcripción, registro y publicación.",
        "• Quien administra el servidor debe respetar las normas de privacidad aplicables.",
      ].join("\n"),
      components: [homeRow()],
    });
    return true;
  }

  if (action === "characters") {
    if (!(await requireManager(interaction))) return true;
    await showCampaignSelection(interaction, campaigns, "characters-campaign", "Administrar personajes");
    return true;
  }

  if (action.startsWith("characters-campaign:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(interaction.values[0]!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await showCharacterManager(interaction, campaigns, campaign.id, campaign.name);
    return true;
  }

  if (action.startsWith("character-upsert:") && interaction.isUserSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaignId = action.slice("character-upsert:".length);
    const campaign = await campaigns.findById(campaignId);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const userId = interaction.values[0]!;
    const members = await campaigns.listMembersByCampaignId(campaign.id);
    const existing = members.find((member) => member.discordUserId === userId);
    const discordMember = interaction.guild.members.resolve(userId);
    const modal = buildCharacterModal({
      campaignId: campaign.id,
      userId,
      characterName: existing?.characterName,
      playerName: existing?.playerName ?? discordMember?.displayName,
    });
    await interaction.showModal(modal);
    return true;
  }

  if (action.startsWith("character-save:") && interaction.isModalSubmit()) {
    if (!(await requireManager(interaction))) return true;
    const [campaignId, userId] = action.slice("character-save:".length).split(":");
    const campaign = await campaigns.findById(campaignId!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId || userId === undefined) {
      await replyOrUpdate(interaction, { content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const characterName = interaction.fields.getTextInputValue("character-name").trim();
    const discordMember = interaction.guild.members.resolve(userId);
    const playerName = interaction.fields.getTextInputValue("player-name").trim()
      || discordMember?.displayName
      || `Usuario ${userId}`;
    const saved = await campaigns.configureMember({
      discordGuildId: interaction.guildId,
      campaignName: campaign.name,
      discordUserId: userId,
      playerName,
      characterName,
    });
    await replyOrUpdate(interaction, {
      content: `✅ **${escapeMarkdown(saved.characterName ?? characterName)}** quedó asociado a <@${userId}> en **${escapeMarkdown(campaign.name)}**. Si ya existía, sus datos fueron actualizados.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${panelPrefix}characters-open:${campaign.id}`).setLabel("Volver a personajes").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return true;
  }

  if (action.startsWith("character-delete:") && interaction.isUserSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaignId = action.slice("character-delete:".length);
    const campaign = await campaigns.findById(campaignId);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const userId = interaction.values[0]!;
    const existing = (await campaigns.listMembersByCampaignId(campaign.id)).find((member) => member.discordUserId === userId);
    if (existing === undefined) {
      await interaction.update({
        content: `El usuario <@${userId}> no tiene un personaje asignado en **${escapeMarkdown(campaign.name)}**.`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${panelPrefix}characters-open:${campaign.id}`).setLabel("Volver").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return true;
    }
    const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${panelPrefix}character-delete-confirm:${campaign.id}:${userId}`)
        .setLabel("Eliminar asignación")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${panelPrefix}characters-open:${campaign.id}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: `⚠️ ¿Eliminar la asignación de <@${userId}> como **${escapeMarkdown(existing.characterName ?? "Sin personaje")}**? Las transcripciones anteriores no cambiarán.`,
      components: [confirm],
    });
    return true;
  }

  if (action.startsWith("character-delete-confirm:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const [campaignId, userId] = action.slice("character-delete-confirm:".length).split(":");
    const campaign = await campaigns.findById(campaignId!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId || userId === undefined) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const deleted = await campaigns.deleteMember(interaction.guildId, campaign.name, userId);
    await interaction.update({
      content: deleted
        ? `🗑️ Se eliminó la asignación de <@${userId}> en **${escapeMarkdown(campaign.name)}**.`
        : "La asignación ya no existía.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${panelPrefix}characters-open:${campaign.id}`).setLabel("Volver a personajes").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return true;
  }

  if (action.startsWith("characters-open:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("characters-open:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await showCharacterManager(interaction, campaigns, campaign.id, campaign.name);
    return true;
  }

  if (action === "sessions") {
    if (!(await requireManager(interaction))) return true;
    await showCampaignSelection(interaction, campaigns, "sessions-campaign", "Administrar sesiones guardadas");
    return true;
  }

  if (action.startsWith("sessions-campaign:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(interaction.values[0]!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const recent = await sessions.listRecent(interaction.guildId, campaign.name, 25);
    if (recent.length === 0) {
      await interaction.update({ content: `**${escapeMarkdown(campaign.name)}** todavía no tiene sesiones guardadas.`, components: [homeRow()] });
      return true;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${panelPrefix}session-select:${campaign.id}`)
      .setPlaceholder("Elige una sesión")
      .addOptions(recent.map((session) => ({
        label: `Sesión ${session.sequenceNumber}`,
        description: `${sessionStatusLabel(session.status)}${session.startedAt === null ? "" : ` · ${session.startedAt.toLocaleDateString("es-CL")}`}`.slice(0, 100),
        value: session.id,
      })));
    await interaction.update({
      content: `**Sesiones de ${escapeMarkdown(campaign.name)}**\nSelecciona una para administrarla.`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), homeRow()],
    });
    return true;
  }

  if (action.startsWith("session-select:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const session = await sessions.findById(interaction.values[0]!);
    if (session === null || session.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La sesión ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.update(await createSessionManagementMessage(session, narratives, interaction.user.id));
    return true;
  }

  if (action.startsWith("session-refresh:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const session = await sessions.findById(action.slice("session-refresh:".length));
    if (session === null || session.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La sesión ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.update(await createSessionManagementMessage(session, narratives, interaction.user.id));
    return true;
  }

  if (action.startsWith("session-narrative-generate:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const session = await sessions.findById(action.slice("session-narrative-generate:".length));
    if (session === null || session.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La sesión ya no existe.", components: [homeRow()] });
      return true;
    }
    const result = await narratives.start(session.id);
    await interaction.update({
      content: result.started
        ? `🎬 Dotty está creando localmente el guion de la sesión **${session.sequenceNumber}**. Puedes cerrar este panel y volver más tarde.`
        : `⏳ El guion de la sesión **${session.sequenceNumber}** ya se está generando.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${panelPrefix}session-refresh:${session.id}`).setLabel("Actualizar estado").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return true;
  }

  if (action.startsWith("session-narrative-publish:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const session = await sessions.findById(action.slice("session-narrative-publish:".length));
    if (session === null || session.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La sesión ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.update({
      content: `⏳ Publicando el guion de la sesión **${session.sequenceNumber}** en el hilo configurado...`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    try {
      const result = await narratives.publish(session.id, interaction.guildId);
      await interaction.editReply({
        content: `✅ Guion de la sesión **${session.sequenceNumber}** ${result.updated ? "actualizado" : "publicado"} manualmente en ${result.messageCount} mensajes.`,
        components: [homeRow()],
      });
    } catch (error) {
      await interaction.editReply({
        content: error instanceof Error ? error.message : "No se pudo publicar el guion.",
        components: [homeRow()],
      });
    }
    return true;
  }

  if (action.startsWith("session-correct:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const session = await sessions.findById(action.slice("session-correct:".length));
    if (session === null || session.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La sesión ya no existe.", components: [homeRow()] });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`${panelPrefix}session-correct-save:${session.id}`)
      .setTitle(`Corregir sesión ${session.sequenceNumber}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("from")
            .setLabel("Texto incorrecto, exactamente como aparece")
            .setMinLength(1)
            .setMaxLength(200)
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("to")
            .setLabel("Texto correcto")
            .setMinLength(1)
            .setMaxLength(200)
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  if (action.startsWith("session-correct-save:") && interaction.isModalSubmit()) {
    if (!(await requireManager(interaction))) return true;
    const session = await sessions.findById(action.slice("session-correct-save:".length));
    if (session === null || session.discordGuildId !== interaction.guildId) {
      await replyOrUpdate(interaction, { content: "La sesión ya no existe.", components: [homeRow()] });
      return true;
    }
    const from = interaction.fields.getTextInputValue("from").trim();
    const to = interaction.fields.getTextInputValue("to").trim();
    await interaction.deferUpdate();
    try {
      const result = await administration.correct(session.id, interaction.guildId, from, to);
      await interaction.editReply({
        content: `✏️ Se corrigieron **${result.matches}** coincidencia${result.matches === 1 ? "" : "s"}: «${escapeMarkdown(from)}» → «${escapeMarkdown(to)}». Cuando termine el reprocesamiento podrás generar y publicar manualmente un guion nuevo.`,
        components: [homeRow()],
      });
    } catch (error) {
      await interaction.editReply({
        content: error instanceof SessionDeletionError ? error.message : "No pude corregir esa sesión.",
        components: [homeRow()],
      });
    }
    return true;
  }

  if (action === "campaign-delete") {
    if (!(await requireManager(interaction))) return true;
    await showCampaignSelection(interaction, campaigns, "campaign-delete-select", "Eliminar una campaña");
    return true;
  }

  if (action.startsWith("campaign-delete-select:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(interaction.values[0]!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const campaignSessions = await sessions.listByCampaignId(campaign.id);
    const members = await campaigns.listMembersByCampaignId(campaign.id);
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Conservar campaña").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(campaignDeleteButtonId("confirmar", campaign.id, interaction.user.id))
        .setLabel("Eliminar definitivamente")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.update({
      content: [
        `⚠️ ¿Eliminar completamente **${escapeMarkdown(campaign.name)}**?`,
        `Contiene **${campaignSessions.length} sesiones** y **${members.length} personajes**.`,
        "Se borrarán sus publicaciones, audios, transcripciones y configuraciones. Esta acción no se puede deshacer.",
      ].join("\n"),
      components: [controls],
    });
    return true;
  }

  if (action === "campaigns") {
    const configured = await campaigns.listByGuild(interaction.guildId);
    await replyOrUpdate(interaction, {
      content: configured.length === 0
        ? "Todavía no hay campañas configuradas."
        : [
            "**Campañas configuradas**",
            ...configured.map((campaign) =>
              `• **${escapeMarkdown(campaign.name)}** · próxima sesión ${campaign.nextSessionNumber} · ${campaign.memberCount} personajes · voz ${campaign.defaultVoiceChannelId === null ? "sin configurar" : `<#${campaign.defaultVoiceChannelId}>`} · bitácora ${campaign.defaultLogChannelId === null ? "chat de voz" : `<#${campaign.defaultLogChannelId}>`}`,
            ),
          ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${panelPrefix}config`).setLabel("Añadir o editar campaña").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${panelPrefix}campaign-delete`).setLabel("Eliminar campaña").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Volver").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return true;
  }

  if (action === "help") {
    await replyOrUpdate(interaction, {
      content: [
        "**Cómo usar el panel de Dotty**",
        "1. Configura la campaña, su canal de voz y el foro de bitácoras.",
        "2. En **Personajes** puedes ver, añadir, editar o eliminar asignaciones.",
        "3. Pulsa **Iniciar grabación**, revisa la sesión y confirma el aviso de consentimiento.",
        "4. Usa **Controlar sesión** para pausar, reanudar o finalizar.",
        "",
        "En **Sesiones** puedes generar, revisar y publicar el guion, además de corregir, reprocesar o eliminar registros. En **Ver campañas** también puedes modificar o eliminar una campaña.",
        "En **Herramientas** encontrarás vocabulario, diagnóstico, almacenamiento, retención y privacidad.",
        "`/dotty_admin` permanece solamente como respaldo de emergencia.",
      ].join("\n"),
      components: [homeRow()],
    });
    return true;
  }

  if (action.startsWith("start-campaign:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(interaction.values[0]!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    const ready = campaign.defaultVoiceChannelId !== null;
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${panelPrefix}start-confirm:${campaign.id}`)
        .setLabel("Confirmo e iniciar grabación")
        .setEmoji("🔴")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!ready),
      new ButtonBuilder()
        .setCustomId(`${panelPrefix}diagnostics:${campaign.id}`)
        .setLabel("Revisar diagn\u00f3stico")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: [
        "**Confirmación obligatoria de grabación**",
        `Campaña: **${escapeMarkdown(campaign.name)}**`,
        `Próxima sesión: **${campaign.nextSessionNumber}**`,
        `Canal de voz: ${campaign.defaultVoiceChannelId === null ? "❌ Sin configurar" : `<#${campaign.defaultVoiceChannelId}>`}`,
        `Bitácora: ${campaign.defaultLogChannelId === null ? "chat del canal de voz" : `<#${campaign.defaultLogChannelId}>`}`,
        "",
        "⚠️ Antes de continuar, informa a todos los participantes que sus voces serán grabadas, transcritas y almacenadas localmente.",
        "Al pulsar el botón rojo declaras que **todos fueron informados**. Dotty no entra ni captura audio antes de esta confirmación.",
      ].join("\n"),
      components: [controls],
    });
    return true;
  }

  if (action.startsWith("start-confirm:") && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(action.slice("start-confirm:".length));
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.deferUpdate();
    try {
      if (campaign.defaultVoiceChannelId === null) throw new PanelError("La campaña no tiene canal de voz configurado.");
      const voiceChannel = interaction.guild.channels.resolve(campaign.defaultVoiceChannelId);
      if (voiceChannel === null || !voiceChannel.isVoiceBased()) throw new PanelError("El canal de voz configurado ya no existe.");
      let session = await sessions.start({
        discordGuildId: interaction.guildId,
        campaignName: campaign.name,
        voiceChannelId: voiceChannel.id,
        logChannelId: campaign.defaultLogChannelId,
        occurredAt: new Date(),
      });
      try {
        await recordings.start(interaction.guild, session);
      } catch (error) {
        await sessions.fail(interaction.guildId, campaign.name, new Date());
        throw error;
      }
      await notifyVoiceChannel(interaction.guild, session.voiceChannelId, session.sequenceNumber, session.campaignName, "iniciar", interaction.user.globalName ?? interaction.user.username);
      await interaction.editReply({
        content: `🔴 **Grabación activa**\nSesión **${session.sequenceNumber}** de **${escapeMarkdown(session.campaignName)}**. Dotty entró al canal después de tu confirmación y está guardando las voces por hablante.`,
        components: [sessionControls(campaign.id)],
      });
    } catch (error) {
      await interaction.editReply({ content: panelErrorMessage(error), components: [homeRow()] });
    }
    return true;
  }

  if (action.startsWith("manage-campaign:") && interaction.isStringSelectMenu()) {
    if (!(await requireManager(interaction))) return true;
    const campaign = await campaigns.findById(interaction.values[0]!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.update({
      content: `**Control de sesión · ${escapeMarkdown(campaign.name)}**\nElige una acción. Dotty comprobará el estado real antes de aplicarla.`,
      components: [sessionControls(campaign.id)],
    });
    return true;
  }

  const sessionAction = /^(pause|resume|finish):(.+)$/.exec(action);
  if (sessionAction !== null && interaction.isButton()) {
    if (!(await requireManager(interaction))) return true;
    const [, operation, campaignId] = sessionAction;
    const campaign = await campaigns.findById(campaignId!);
    if (campaign === null || campaign.discordGuildId !== interaction.guildId) {
      await interaction.update({ content: "La campaña ya no existe.", components: [homeRow()] });
      return true;
    }
    await interaction.deferUpdate();
    try {
      let session;
      if (operation === "pause") {
        session = await sessions.pause(interaction.guildId, campaign.name);
        await recordings.pause(interaction.guildId);
      } else if (operation === "resume") {
        session = await sessions.resume(interaction.guildId, campaign.name);
        await recordings.resume(interaction.guildId);
      } else {
        session = await finalizeSessionSafely(
          sessions,
          recordings,
          interaction.guildId,
          campaign.name,
        );
      }
      const actionName = operation === "pause" ? "pausada" : operation === "resume" ? "reanudada" : "finalizada";
      const voiceAction = operation === "pause" ? "pausar" : operation === "resume" ? "reanudar" : "finalizar";
      await notifyVoiceChannel(interaction.guild, session.voiceChannelId, session.sequenceNumber, session.campaignName, voiceAction, interaction.user.globalName ?? interaction.user.username);
      await interaction.editReply({
        content: `Sesión **${session.sequenceNumber}** de **${escapeMarkdown(session.campaignName)}** ${actionName}.${operation === "finish" ? " Dotty procesará la transcripción." : ""}`,
        components: operation === "finish" ? [homeRow()] : [sessionControls(campaign.id)],
      });
    } catch (error) {
      await interaction.editReply({ content: panelErrorMessage(error), components: [homeRow()] });
    }
    return true;
  }

  await replyOrUpdate(interaction, { content: "Este panel quedó antiguo. Ejecuta `/dotty` para abrir uno nuevo.", components: [] });
  return true;
}

export function buildCharacterModal(input: {
  readonly campaignId: string;
  readonly userId: string;
  readonly characterName?: string | null | undefined;
  readonly playerName?: string | null | undefined;
}): ModalBuilder {
  const characterName = new TextInputBuilder()
    .setCustomId("character-name")
    .setLabel("Nombre del personaje")
    .setPlaceholder("Ejemplo: Toño Máster")
    .setMinLength(1)
    .setMaxLength(80)
    .setRequired(true)
    .setStyle(TextInputStyle.Short);
  const playerName = new TextInputBuilder()
    .setCustomId("player-name")
    .setLabel("Nombre o apodo del jugador")
    .setMaxLength(80)
    .setRequired(false)
    .setStyle(TextInputStyle.Short);

  if ((input.characterName ?? "").trim() !== "") {
    characterName.setValue(input.characterName!.trim());
  }
  if ((input.playerName ?? "").trim() !== "") {
    playerName.setValue(input.playerName!.trim());
  }

  return new ModalBuilder()
    .setCustomId(`${panelPrefix}character-save:${input.campaignId}:${input.userId}`)
    .setTitle(input.characterName == null ? "Añadir personaje" : "Editar personaje")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(characterName),
      new ActionRowBuilder<TextInputBuilder>().addComponents(playerName),
    );
}

async function createHome(guildId: string, campaigns: CampaignService) {
  const configured = await campaigns.listByGuild(guildId);
  const main = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${panelPrefix}start`).setLabel("Iniciar grabación").setEmoji("🔴").setStyle(ButtonStyle.Success).setDisabled(configured.length === 0),
    new ButtonBuilder().setCustomId(`${panelPrefix}manage`).setLabel("Controlar sesión").setEmoji("🎙️").setStyle(ButtonStyle.Primary).setDisabled(configured.length === 0),
    new ButtonBuilder().setCustomId(`${panelPrefix}config`).setLabel("Configurar campaña").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
  );
  const secondary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${panelPrefix}characters`).setLabel("Personajes").setEmoji("🎭").setStyle(ButtonStyle.Primary).setDisabled(configured.length === 0),
    new ButtonBuilder().setCustomId(`${panelPrefix}sessions`).setLabel("Sesiones").setEmoji("📜").setStyle(ButtonStyle.Secondary).setDisabled(configured.length === 0),
    new ButtonBuilder().setCustomId(`${panelPrefix}tools`).setLabel("Herramientas").setEmoji("🧰").setStyle(ButtonStyle.Secondary).setDisabled(configured.length === 0),
    new ButtonBuilder().setCustomId(`${panelPrefix}campaigns`).setLabel("Ver campañas").setEmoji("📚").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${panelPrefix}help`).setLabel("Ayuda").setEmoji("❓").setStyle(ButtonStyle.Secondary),
  );
  return {
    content: [
      "# Panel de Dotty",
      "Ruta recomendada: **Configurar \u2192 Personajes \u2192 Diagn\u00f3stico \u2192 Grabar \u2192 Revisar**.",
      "Configura y controla las grabaciones sin memorizar comandos.",
      configured.length === 0
        ? "⚠️ No hay campañas configuradas. Comienza con **Configurar campaña**."
        : `✅ ${configured.length} campaña${configured.length === 1 ? " configurada" : "s configuradas"}.`,
      "Este mensaje es privado: solo tú puedes verlo.",
    ].join("\n"),
    components: [
      main,
      secondary,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${panelPrefix}tutorial:0`)
          .setLabel("Iniciar tutorial guiado")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

async function showCharacterManager(
  interaction: PanelComponentInteraction,
  campaigns: CampaignService,
  campaignId: string,
  campaignName: string,
) {
  const members = await campaigns.listMembersByCampaignId(campaignId);
  const addOrEdit = new UserSelectMenuBuilder()
    .setCustomId(`${panelPrefix}character-upsert:${campaignId}`)
    .setPlaceholder("Añadir o editar un personaje")
    .setMinValues(1)
    .setMaxValues(1);
  const remove = new UserSelectMenuBuilder()
    .setCustomId(`${panelPrefix}character-delete:${campaignId}`)
    .setPlaceholder("Eliminar la asignación de un personaje")
    .setMinValues(1)
    .setMaxValues(1);
  await replyOrUpdate(interaction, {
    content: [
      `**Personajes · ${escapeMarkdown(campaignName)}**`,
      members.length === 0
        ? "Todavía no hay personajes asignados."
        : members.map((member) =>
            `• <@${member.discordUserId}> → **${escapeMarkdown(member.characterName ?? "Sin personaje")}** (${escapeMarkdown(member.playerName)})`,
          ).join("\n"),
      "",
      "Selecciona un usuario en el primer menú para añadirlo o editar sus datos. Usa el segundo menú para eliminar su asignación.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(addOrEdit),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(remove),
      homeRow(),
    ],
  });
}

async function showCampaignSelection(
  interaction: PanelComponentInteraction,
  campaigns: CampaignService,
  action: string,
  title: string,
) {
  const configured = await campaigns.listByGuild(interaction.guildId!);
  if (configured.length === 0) {
    await replyOrUpdate(interaction, { content: "Primero debes configurar una campaña.", components: [homeRow()] });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${panelPrefix}${action}:select`)
    .setPlaceholder("Elige una campaña")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(configured.slice(0, 25).map((campaign) => ({
      label: campaign.name.slice(0, 100),
      description: `Próxima sesión ${campaign.nextSessionNumber}`.slice(0, 100),
      value: campaign.id,
    })));
  await replyOrUpdate(interaction, {
    content: `**${title}**\nSelecciona la campaña que quieres utilizar.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), homeRow()],
  });
}

async function finishConfiguration(
  interaction: ButtonInteraction | ChannelSelectMenuInteraction,
  campaigns: CampaignService,
  draft: ConfigurationDraft,
  token: string,
  logChannelId: string | null,
) {
  if (draft.voiceChannelId === null) {
    await interaction.update({ content: "Falta seleccionar el canal de voz.", components: [homeRow()] });
    return;
  }
  if (logChannelId !== null) {
    const channel = interaction.guild!.channels.resolve(logChannelId);
    if (channel === null || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
      await interaction.update({ content: "Selecciona un foro o canal de texto válido.", components: [homeRow()] });
      return;
    }
  }
  await interaction.deferUpdate();
  try {
    const campaign = await campaigns.configure({
      discordGuildId: draft.guildId,
      guildName: interaction.guild!.name,
      campaignName: draft.campaignName,
      defaultVoiceChannelId: draft.voiceChannelId,
      defaultLogChannelId: logChannelId,
      startingSessionNumber: draft.startingSessionNumber,
    });
    drafts.delete(token);
    await interaction.editReply({
      content: [
        `✅ Campaña **${escapeMarkdown(campaign.name)}** configurada.`,
        `🔊 Voz: <#${campaign.defaultVoiceChannelId}>`,
        `📝 Bitácora: ${campaign.defaultLogChannelId === null ? "chat del canal de voz" : `<#${campaign.defaultLogChannelId}>`}`,
        `🔢 Próxima sesión: **${campaign.nextSessionNumber}**`,
        "Nada se grabará hasta que uses **Iniciar grabación** y confirmes el aviso.",
      ].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${panelPrefix}characters-open:${campaign.id}`)
            .setLabel("Siguiente: personajes")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`${panelPrefix}diagnostics:${campaign.id}`)
            .setLabel("Comprobar configuraci\u00f3n")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`${panelPrefix}home`)
            .setLabel("Volver al panel")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  } catch (error) {
    const message = error instanceof InvalidStartingSessionNumberError
      ? `La campaña ya tiene sesiones. El próximo número debe ser **${error.minimum}** o mayor.`
      : "No pude guardar la campaña. Revisa los permisos y vuelve a intentarlo.";
    await interaction.editReply({ content: message, components: [homeRow()] });
  }
}

function sessionControls(campaignId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${panelPrefix}pause:${campaignId}`).setLabel("Pausar").setEmoji("⏸️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${panelPrefix}resume:${campaignId}`).setLabel("Reanudar").setEmoji("▶️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${panelPrefix}finish:${campaignId}`).setLabel("Finalizar").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel").setStyle(ButtonStyle.Secondary),
  );
}

function toolsRow(campaignId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${panelPrefix}vocabulary:${campaignId}`).setLabel("Vocabulario").setEmoji("📚").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${panelPrefix}diagnostics:${campaignId}`).setLabel("Diagnóstico").setEmoji("🩺").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${panelPrefix}storage:${campaignId}`).setLabel("Almacenamiento").setEmoji("💾").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${panelPrefix}retention:${campaignId}`).setLabel("Retención").setEmoji("🧹").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${panelPrefix}privacy`).setLabel("Privacidad").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
  );
}

function toolsBackRow(campaignId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${panelPrefix}tools-open:${campaignId}`).setLabel("Volver a herramientas").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel("Panel principal").setStyle(ButtonStyle.Secondary),
  );
}

function backupRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${panelPrefix}backup-create`).setLabel("Crear respaldo completo").setEmoji("💽").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${panelPrefix}backup-list`).setLabel("Ver respaldos").setEmoji("📦").setStyle(ButtonStyle.Secondary),
  );
}

function homeRow(label = "Volver") {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${panelPrefix}home`).setLabel(label).setStyle(ButtonStyle.Secondary),
  );
}

function createDraftToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function getDraft(token: string, interaction: PanelComponentInteraction) {
  const draft = drafts.get(token);
  if (draft !== undefined && draft.userId === interaction.user.id && draft.guildId === interaction.guildId && draft.expiresAt > Date.now()) {
    return draft;
  }
  await replyOrUpdate(interaction, {
    content: "Esta configuración caducó. Vuelve al panel para comenzar nuevamente.",
    components: [homeRow()],
  });
  return null;
}

function pruneDrafts() {
  const now = Date.now();
  for (const [token, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(token);
}

async function requireManager(interaction: PanelComponentInteraction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  await replyOrUpdate(interaction, {
    content: "Necesitas el permiso **Gestionar servidor** para realizar esta acción.",
    components: [homeRow()],
  });
  return false;
}

async function replyOrUpdate(
  interaction: PanelComponentInteraction,
  payload: {
    readonly content: string;
    readonly embeds?: NonNullable<InteractionUpdateOptions["embeds"]>;
    readonly components: NonNullable<InteractionUpdateOptions["components"]>;
  },
) {
  if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  } else if (interaction.isModalSubmit()) {
    await interaction.update(payload);
  } else {
    await interaction.update(payload);
  }
}

function panelErrorMessage(error: unknown) {
  if (error instanceof PanelError) return error.message;
  if (error instanceof ActiveSessionExistsError) return "Ya hay una sesión activa en este servidor. Finalízala antes de iniciar otra.";
  if (error instanceof ActiveSessionNotFoundError) return "Esta campaña no tiene una sesión activa.";
  if (error instanceof InvalidSessionTransitionError) return "La sesión no admite esa acción en su estado actual.";
  return "Dotty no pudo completar la operación. Revisa el panel de diagnóstico o los registros.";
}

function sessionStatusLabel(status: string) {
  return ({
    scheduled: "programada",
    recording: "grabando",
    paused: "pausada",
    finalizing: "finalizando",
    completed: "completada",
    failed: "con error",
  }[status] ?? status);
}

async function createSessionManagementMessage(
  session: {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly campaignName: string;
    readonly status: string;
  },
  narratives: NarrativeManager,
  requestedBy: string,
): Promise<InteractionUpdateOptions> {
  const narrative = await narratives.status(session.id);
  const narrativeLabel = {
    missing: "sin generar",
    queued: "en cola",
    generating: `${narrative.phase} · ${Math.round(narrative.progress * 100)} %`,
    ready: "listo para revisar o publicar",
    failed: `con error${narrative.error ? `: ${narrative.error}` : ""}`,
  }[narrative.state];
  const generating = narrative.state === "queued" || narrative.state === "generating";
  const completed = session.status === "completed";
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${panelPrefix}session-narrative-generate:${session.id}`)
      .setLabel(narrative.state === "ready" ? "Regenerar guion" : "Generar guion")
      .setEmoji("🎬")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!completed || generating),
    new ButtonBuilder()
      .setCustomId(`${panelPrefix}session-narrative-publish:${session.id}`)
      .setLabel("Publicar")
      .setEmoji("📤")
      .setStyle(ButtonStyle.Success)
      .setDisabled(narrative.state !== "ready"),
    new ButtonBuilder()
      .setCustomId(`${panelPrefix}session-correct:${session.id}`)
      .setLabel("Corregir texto")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!completed || generating),
    new ButtonBuilder()
      .setCustomId(sessionReprocessButtonId("confirmar", session.id, requestedBy))
      .setLabel(session.status === "failed" ? "Recuperar" : "Reprocesar")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled((!completed && session.status !== "failed") || generating),
    new ButtonBuilder()
      .setCustomId(sessionDeleteButtonId("confirmar", session.id, requestedBy))
      .setLabel("Eliminar")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(generating),
  );
  const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${panelPrefix}session-refresh:${session.id}`)
      .setLabel("Actualizar estado")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${panelPrefix}home`)
      .setLabel("Panel principal")
      .setStyle(ButtonStyle.Secondary),
  );
  return {
    content: [
      `**Sesión ${session.sequenceNumber} · ${escapeMarkdown(session.campaignName)}**`,
      `Transcripción: **${sessionStatusLabel(session.status)}**.`,
      `Guion narrativo: **${escapeMarkdown(narrativeLabel)}**.`,
      "Dotty no publicará nada automáticamente. Revisa el guion en la aplicación y usa **Publicar** cuando esté listo.",
    ].join("\n"),
    components: [controls, navigation],
  };
}

class PanelError extends Error {}

function escapeMarkdown(value: string) {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, "\\$&");
}

async function notifyVoiceChannel(
  guild: Guild,
  voiceChannelId: string | null,
  sequenceNumber: number,
  campaignName: string,
  action: string,
  requestedBy: string,
) {
  if (voiceChannelId === null) return;
  const channel = guild.channels.resolve(voiceChannelId);
  if (channel === null || !channel.isTextBased()) return;
  const message = {
    iniciar: `🔴 **Grabación iniciada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**. ${escapeMarkdown(requestedBy)} confirmó que todos los participantes fueron informados.`,
    pausar: `⏸️ **Grabación pausada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**.`,
    reanudar: `🔴 **Grabación reanudada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**.`,
    finalizar: `⏹️ **Grabación finalizada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**. Dotty procesará la transcripción.`,
  }[action];
  if (message !== undefined) await channel.send(message).catch(() => undefined);
}
