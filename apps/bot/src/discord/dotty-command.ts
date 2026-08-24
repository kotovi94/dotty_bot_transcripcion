import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type Guild,
  type VoiceBasedChannel,
} from "discord.js";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import {
  CampaignNotConfiguredError,
  InvalidStartingSessionNumberError,
} from "../campaigns/campaign-repository.ts";
import { InvalidSessionTransitionError } from "../domain/session.ts";
import {
  formatBytes,
  type DottyDiagnostics,
} from "../diagnostics/dotty-diagnostics.ts";
import {
  ActiveSessionExistsError,
  ActiveSessionNotFoundError,
  CampaignNotFoundError,
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
import type { VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import type { AudioRetentionManager } from "../storage/audio-retention-manager.ts";
import { createTutorialReply } from "./dotty-tutorial.ts";

export const dottyCommand = new SlashCommandBuilder()
  .setName("dotty_admin")
  .setDescription("Comandos avanzados y de respaldo de Dotty.")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("configurar")
      .setDescription("Registra una campaña en este servidor.")
      .addStringOption((option) =>
        option
          .setName("campaña")
          .setDescription("Nombre de la campaña de rol.")
          .setMinLength(1)
          .setMaxLength(80)
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("voz")
          .setDescription("Canal de voz predeterminado para esta campaña.")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(true),
      )
      .addStringOption(destinationOption)
      .addIntegerOption((option) =>
        option
          .setName("sesión_inicial")
          .setDescription("Número de la próxima sesión; por ejemplo, 40.")
          .setMinValue(1)
          .setMaxValue(1_000_000),
      )
      .addChannelOption(logChannelOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("estado")
      .setDescription("Muestra las campañas configuradas en este servidor."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("diagnóstico")
      .setDescription("Comprueba si Dotty está preparado para grabar y publicar.")
      .addStringOption(campaignOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("almacenamiento")
      .setDescription("Muestra cuánto espacio ocupan los datos de una campaña.")
      .addStringOption(campaignOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("retención")
      .setDescription("Configura cuánto tiempo se conservarán los audios publicados.")
      .addStringOption(campaignOption)
      .addStringOption((option) =>
        option
          .setName("política")
          .setDescription("Las transcripciones siempre se conservarán.")
          .addChoices(
            { name: "Conservar audio siempre", value: "siempre" },
            { name: "Eliminar después de 7 días", value: "7" },
            { name: "Eliminar después de 30 días", value: "30" },
            { name: "Eliminar después de 90 días", value: "90" },
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("tutorial")
      .setDescription("Aprende a configurar, grabar y leer una sesión con Dotty."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("privacidad")
      .setDescription("Explica cómo Dotty graba, conserva y elimina los datos."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("vocabulario")
      .setDescription("Consulta o actualiza términos propios de una campaña.")
      .addStringOption(campaignOption)
      .addStringOption((option) =>
        option
          .setName("términos")
          .setDescription("Nombres, lugares y palabras separados por comas.")
          .setMaxLength(1000),
      )
      .addBooleanOption((option) =>
        option
          .setName("limpiar")
          .setDescription("Elimina el vocabulario personalizado existente."),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("iniciar")
      .setDescription("Inicia una sesión en un canal de voz.")
      .addStringOption(campaignOption)
      .addStringOption((option) =>
        option
          .setName("consentimiento")
          .setDescription("Confirma que los participantes saben que serán grabados.")
          .addChoices({
            name: "Sí, todos fueron informados",
            value: "confirmado",
          })
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("voz")
          .setDescription("Canal de voz que usará la sesión.")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addStringOption((option) => destinationOption(option).setRequired(false))
      .addChannelOption(logChannelOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("personaje")
      .setDescription("Asocia un usuario de Discord con su personaje.")
      .addStringOption(campaignOption)
      .addUserOption((option) =>
        option
          .setName("usuario")
          .setDescription("Usuario cuya voz identificará Dotty.")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("nombre")
          .setDescription("Nombre del personaje que aparecerá en la transcripción.")
          .setMinLength(1)
          .setMaxLength(80)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("jugador")
          .setDescription("Nombre real o apodo del jugador (opcional).")
          .setMinLength(1)
          .setMaxLength(80),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("personajes")
      .setDescription("Muestra los personajes configurados en una campaña.")
      .addStringOption(campaignOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("borrar_personaje")
      .setDescription("Elimina la relación entre un usuario y su personaje.")
      .addStringOption(campaignOption)
      .addUserOption((option) =>
        option
          .setName("usuario")
          .setDescription("Usuario cuya asignación quieres eliminar.")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("borrar_campaña")
      .setDescription("Elimina una campaña y todos sus datos con confirmación.")
      .addStringOption(campaignOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("sesiones")
      .setDescription("Muestra las últimas sesiones guardadas de una campaña.")
      .addStringOption(campaignOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("borrar_sesión")
      .setDescription("Cancela o elimina una sesión y permite reutilizar su número.")
      .addStringOption(campaignOption)
      .addIntegerOption((option) =>
        option
          .setName("número")
          .setDescription("Número de la sesión que quieres eliminar.")
          .setMinValue(1)
          .setMaxValue(1_000_000)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reprocesar")
      .setDescription("Transcribe nuevamente una sesión conservando su audio y número.")
      .addStringOption(campaignOption)
      .addIntegerOption((option) =>
        option
          .setName("número")
          .setDescription("Número de la sesión que quieres volver a transcribir.")
          .setMinValue(1)
          .setMaxValue(1_000_000)
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("corregir")
      .setDescription("Corrige texto de una sesión antes de generar un guion nuevo.")
      .addStringOption(campaignOption)
      .addIntegerOption((option) =>
        option
          .setName("número")
          .setDescription("Número de la sesión que quieres corregir.")
          .setMinValue(1)
          .setMaxValue(1_000_000)
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("buscar")
          .setDescription("Palabra o frase incorrecta tal como aparece.")
          .setMinLength(1)
          .setMaxLength(200)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("reemplazar")
          .setDescription("Texto correcto que debe aparecer.")
          .setMinLength(1)
          .setMaxLength(200)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("pausar")
      .setDescription("Pausa la sesión activa.")
      .addStringOption(campaignOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reanudar")
      .setDescription("Reanuda la sesión pausada.")
      .addStringOption(campaignOption),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("finalizar")
      .setDescription("Finaliza la sesión activa.")
      .addStringOption(campaignOption),
  );

export async function handleDottyCommand(
  interaction: ChatInputCommandInteraction,
  campaigns: CampaignService,
  sessions: SessionService,
  recordings: VoiceCaptureManager,
  administration: SessionAdministration,
  diagnostics: DottyDiagnostics,
  audioRetention: AudioRetentionManager,
): Promise<void> {
  if (interaction.commandName !== dottyCommand.name) {
    return;
  }
  if (interaction.guildId === null || interaction.guild === null) {
    await interaction.reply({
      content: "Dotty solo puede configurarse dentro de un servidor.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "diagnóstico") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const campaignName = interaction.options.getString("campaña", true).trim();
    const report = await diagnostics.run(interaction.guild, campaignName);
    const icon = { ok: "✅", warning: "⚠️", error: "❌" } as const;
    await interaction.editReply(
      [
        `**Diagnóstico de ${escapeMarkdown(report.campaignName)}**`,
        "",
        ...report.checks.map(
          (check) => `${icon[check.level]} **${check.label}:** ${check.detail}`,
        ),
        "",
        report.ready
          ? "**Dotty puede iniciar una sesión.** Revisa las advertencias si aparece alguna."
          : "**Dotty todavía no está listo.** Corrige los elementos marcados con ❌.",
      ].join("\n"),
    );
    return;
  }
  if (subcommand === "almacenamiento") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const campaignName = interaction.options.getString("campaña", true).trim();
    const campaign = await campaigns.findByGuildAndName(interaction.guildId, campaignName);
    if (campaign === null) {
      await interaction.editReply("No encontré esa campaña.");
      return;
    }
    const report = await audioRetention.report(campaign.id);
    await interaction.editReply(
      [
        `**Almacenamiento de ${escapeMarkdown(campaign.name)}**`,
        `🎙️ Audio: **${formatBytes(report.audioBytes)}** en ${report.sessionsWithAudio} sesiones.`,
        `📄 Transcripciones: **${formatBytes(report.exportBytes)}**.`,
        `🧹 Sesiones cuyo audio ya fue limpiado: **${report.sessionsWithoutAudio}**.`,
        report.retentionDays === null
          ? "♾️ Política: conservar los audios siempre."
          : `🗓️ Política: eliminar audios ${report.retentionDays} días después de publicarlos.`,
        report.eligibleForCleanup === 0
          ? "No hay audios pendientes de limpieza."
          : `⚠️ Hay **${report.eligibleForCleanup}** sesiones que se limpiarán en la próxima revisión automática.`,
      ].join("\n"),
    );
    return;
  }
  if (subcommand === "retención") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas **Gestionar servidor** para cambiar la retención.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignName = interaction.options.getString("campaña", true).trim();
    const policy = interaction.options.getString("política", true);
    const days = policy === "siempre" ? null : Number.parseInt(policy, 10);
    try {
      const updated = await campaigns.setAudioRetention(
        interaction.guildId,
        campaignName,
        days,
      );
      await interaction.reply({
        content:
          updated.audioRetentionDays === null
            ? `♾️ Los audios de **${escapeMarkdown(updated.name)}** se conservarán hasta que borres sus sesiones manualmente.`
            : `🧹 Los WAV de **${escapeMarkdown(updated.name)}** se eliminarán ${updated.audioRetentionDays} días después de publicarse. Las transcripciones y correcciones permanecerán. La limpieza se revisa cada hora.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      if (!(error instanceof CampaignNotConfiguredError)) throw error;
      await interaction.reply({
        content: "No encontré esa campaña.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }
  if (subcommand === "tutorial") {
    await interaction.reply(createTutorialReply());
    return;
  }
  if (subcommand === "privacidad") {
    await interaction.reply({
      content: [
        "**Privacidad y grabación de Dotty**",
        "",
        "- Dotty solo graba después de iniciar desde `/dotty` y confirmar que todos fueron informados.",
        "- El canal de voz recibe avisos visibles al iniciar, pausar, reanudar y finalizar.",
        "- El audio y las transcripciones se procesan y guardan localmente en este computador.",
        "- `/dotty_admin retención` controla cuánto tiempo se conservan los archivos WAV.",
        "- `/dotty_admin borrar_sesión` elimina audio, transcripción, registro y publicación.",
        "- `/dotty_admin borrar_campaña` elimina todos los datos locales y publicaciones de la campaña.",
        "- Quien administra el servidor es responsable de informar a los participantes y respetar las reglas locales aplicables.",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (subcommand === "vocabulario") {
    const campaignName = interaction.options.getString("campaña", true).trim();
    const terms = interaction.options.getString("términos")?.trim();
    const clear = interaction.options.getBoolean("limpiar") ?? false;
    const campaign = await campaigns.findByGuildAndName(interaction.guildId, campaignName);
    if (campaign === null) {
      await interaction.reply({
        content: "No encontré esa campaña.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (terms === undefined && !clear) {
      await interaction.reply({
        content: campaign.transcriptionVocabulary
          ? `📚 Vocabulario de **${escapeMarkdown(campaign.name)}**:\n${escapeMarkdown(campaign.transcriptionVocabulary)}`
          : `La campaña **${escapeMarkdown(campaign.name)}** no tiene vocabulario personalizado.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas **Gestionar servidor** para cambiar el vocabulario.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const updated = await campaigns.setVocabulary(
      interaction.guildId,
      campaignName,
      clear ? "" : terms ?? "",
    );
    await interaction.reply({
      content: updated.transcriptionVocabulary
        ? `📚 Vocabulario actualizado para **${escapeMarkdown(updated.name)}**. Se aplicará en las próximas transcripciones y al reprocesar sesiones.`
        : `El vocabulario personalizado de **${escapeMarkdown(updated.name)}** fue eliminado.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (subcommand === "configurar") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas el permiso **Gestionar servidor** para configurar Dotty.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const campaignName = interaction.options.getString("campaña", true).trim();
    const selectedVoiceChannel = interaction.options.getChannel("voz", true);
    const voiceChannel = interaction.guild.channels.resolve(selectedVoiceChannel.id);
    if (voiceChannel === null || !voiceChannel.isVoiceBased()) {
      await interaction.reply({
        content: "Selecciona un canal de voz o escenario válido.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let logChannelId: string | null;
    try {
      logChannelId = await resolveLogChannel(
        interaction,
        interaction.guild,
        voiceChannel,
        campaignName,
        interaction.options.getString("destino", true),
      );
    } catch (error) {
      if (!(error instanceof UserFacingCommandError)) throw error;
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const startingSessionNumber = interaction.options.getInteger("sesión_inicial");
    let campaign;
    try {
      campaign = await campaigns.configure({
        discordGuildId: interaction.guildId,
        guildName: interaction.guild.name,
        campaignName,
        defaultVoiceChannelId: voiceChannel.id,
        defaultLogChannelId: logChannelId,
        ...(startingSessionNumber === null
          ? {}
          : { startingSessionNumber }),
      });
    } catch (error) {
      if (!(error instanceof InvalidStartingSessionNumberError)) throw error;
      await interaction.reply({
        content: `El número debe ser **${error.minimum}** o mayor porque la campaña ya tiene sesiones guardadas.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: [
        `Campaña **${escapeMarkdown(campaign.name)}** configurada correctamente.`,
        `🔊 Voz predeterminada: <#${campaign.defaultVoiceChannelId}>`,
        campaign.defaultLogChannelId === null
          ? "📝 Bitácora: chat del canal de voz"
          : `📝 Bitácora: hilo en <#${campaign.defaultLogChannelId}>`,
        `🔢 Próxima sesión: **${campaign.nextSessionNumber}**`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "personaje") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas el permiso **Gestionar servidor** para asignar personajes.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignName = interaction.options.getString("campaña", true).trim();
    const user = interaction.options.getUser("usuario", true);
    const characterName = interaction.options.getString("nombre", true).trim();
    const playerName =
      interaction.options.getString("jugador")?.trim() ||
      interaction.guild.members.resolve(user.id)?.displayName ||
      user.globalName ||
      user.username;
    try {
      const member = await campaigns.configureMember({
        discordGuildId: interaction.guildId,
        campaignName,
        discordUserId: user.id,
        playerName,
        characterName,
      });
      await interaction.reply({
        content: `🎭 **${escapeMarkdown(member.characterName ?? characterName)}** quedó asociado a **${escapeMarkdown(member.playerName)}**. Sus intervenciones aparecerán con el nombre del personaje.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      if (!(error instanceof CampaignNotConfiguredError)) throw error;
      await interaction.reply({
        content: "No encontré esa campaña. Configúrala primero desde `/dotty`.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (subcommand === "personajes") {
    const campaignName = interaction.options.getString("campaña", true).trim();
    const campaign = await campaigns.findByGuildAndName(interaction.guildId, campaignName);
    if (campaign === null) {
      await interaction.reply({
        content: "No encontré esa campaña. Configúrala primero desde `/dotty`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const members = await campaigns.listMembersByCampaignId(campaign.id);
    await interaction.reply({
      content:
        members.length === 0
          ? `La campaña **${escapeMarkdown(campaign.name)}** todavía no tiene personajes asignados.`
          : [
              `**Personajes de ${escapeMarkdown(campaign.name)}:**`,
              ...members.map(
                (member) =>
                  `- **${escapeMarkdown(member.characterName ?? "Sin personaje")}** — ${escapeMarkdown(member.playerName)}`,
              ),
            ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "borrar_personaje") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas **Gestionar servidor** para borrar personajes.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignName = interaction.options.getString("campaña", true).trim();
    const user = interaction.options.getUser("usuario", true);
    const deleted = await campaigns.deleteMember(
      interaction.guildId,
      campaignName,
      user.id,
    );
    await interaction.reply({
      content: deleted
        ? `🗑️ Se eliminó la asignación de personaje de **${escapeMarkdown(user.globalName ?? user.username)}** en **${escapeMarkdown(campaignName)}**. Las transcripciones anteriores no cambian.`
        : "Ese usuario no tenía un personaje configurado en la campaña indicada.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "borrar_campaña") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas **Gestionar servidor** para borrar campañas.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignName = interaction.options.getString("campaña", true).trim();
    const campaign = await campaigns.findByGuildAndName(interaction.guildId, campaignName);
    if (campaign === null) {
      await interaction.reply({
        content: "No encontré esa campaña.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignSessions = await sessions.listByCampaignId(campaign.id);
    const members = await campaigns.listMembersByCampaignId(campaign.id);
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(campaignDeleteButtonId("cancelar", campaign.id, interaction.user.id))
        .setLabel("Conservar campaña")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(campaignDeleteButtonId("confirmar", campaign.id, interaction.user.id))
        .setLabel("Eliminar definitivamente")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({
      content: [
        `⚠️ ¿Eliminar completamente la campaña **${escapeMarkdown(campaign.name)}**?`,
        `Contiene **${campaignSessions.length} sesiones** y **${members.length} personajes configurados**.`,
        "También se eliminarán sus publicaciones, audios y transcripciones. Esta acción no se puede deshacer.",
      ].join("\n"),
      components: [controls],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "sesiones") {
    const campaignName = interaction.options.getString("campaña", true).trim();
    const recent = await sessions.listRecent(interaction.guildId, campaignName, 10);
    await interaction.reply({
      content:
        recent.length === 0
          ? `No hay sesiones guardadas para **${escapeMarkdown(campaignName)}**.`
          : [
              `**Últimas sesiones de ${escapeMarkdown(campaignName)}:**`,
              ...recent.map(
                (session) =>
                  `- Sesión **${session.sequenceNumber}** — ${sessionStatusLabel(session.status)}${session.startedAt === null ? "" : ` — ${session.startedAt.toLocaleString("es-CL")}`}`,
              ),
              "",
              "Para eliminar una, usa `/dotty_admin borrar_sesión`.",
            ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "borrar_sesión") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas el permiso **Gestionar servidor** para borrar sesiones.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignName = interaction.options.getString("campaña", true).trim();
    const sequenceNumber = interaction.options.getInteger("número", true);
    const session = await sessions.findBySequence(
      interaction.guildId,
      campaignName,
      sequenceNumber,
    );
    if (session === null) {
      await interaction.reply({
        content: "No encontré esa sesión. Consulta `/dotty_admin sesiones` para revisar los números.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(sessionDeleteButtonId("cancelar", session.id, interaction.user.id))
        .setLabel("Conservar sesión")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(sessionDeleteButtonId("confirmar", session.id, interaction.user.id))
        .setLabel("Eliminar definitivamente")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({
      content: [
        `⚠️ ¿Eliminar la sesión **${session.sequenceNumber}** de **${escapeMarkdown(session.campaignName)}**?`,
        `Estado: ${sessionStatusLabel(session.status)}.`,
        "Se borrarán el hilo publicado, el audio, la transcripción y el registro local.",
      ].join("\n"),
      components: [controls],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "reprocesar") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas **Gestionar servidor** para reprocesar sesiones.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignName = interaction.options.getString("campaña", true).trim();
    const sequenceNumber = interaction.options.getInteger("número", true);
    const session = await sessions.findBySequence(
      interaction.guildId,
      campaignName,
      sequenceNumber,
    );
    if (session === null) {
      await interaction.reply({
        content: "No encontré esa sesión. Consulta `/dotty_admin sesiones`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(sessionReprocessButtonId("cancelar", session.id, interaction.user.id))
        .setLabel("Conservar versión actual")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(sessionReprocessButtonId("confirmar", session.id, interaction.user.id))
        .setLabel("Reprocesar transcripción")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({
      content: [
        `🔄 ¿Volver a transcribir la sesión **${session.sequenceNumber}** de **${escapeMarkdown(session.campaignName)}**?`,
        "La publicación actual se conservará hasta que generes y publiques manualmente el guion nuevo. El audio y el número de sesión no cambian.",
        "Antes de confirmar, puedes actualizar `/dotty_admin vocabulario` y `/dotty_admin personaje`.",
      ].join("\n"),
      components: [controls],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "corregir") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas **Gestionar servidor** para corregir sesiones.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const campaignName = interaction.options.getString("campaña", true).trim();
    const sequenceNumber = interaction.options.getInteger("número", true);
    const from = interaction.options.getString("buscar", true).trim();
    const to = interaction.options.getString("reemplazar", true).trim();
    const session = await sessions.findBySequence(
      interaction.guildId,
      campaignName,
      sequenceNumber,
    );
    if (session === null) {
      await interaction.reply({
        content: "No encontré esa sesión. Consulta `/dotty_admin sesiones`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await administration.correct(
        session.id,
        interaction.guildId,
        from,
        to,
      );
      await interaction.editReply(
        `✏️ Corregí **${result.matches}** coincidencia${result.matches === 1 ? "" : "s"}: «${escapeMarkdown(from)}» → «${escapeMarkdown(to)}». Cuando termine el reprocesamiento, genera y publica manualmente el guion nuevo desde /dotty.`,
      );
    } catch (error) {
      if (!(error instanceof SessionDeletionError)) throw error;
      await interaction.editReply(error.message);
    }
    return;
  }

  if (["iniciar", "pausar", "reanudar", "finalizar"].includes(subcommand)) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Necesitas el permiso **Gestionar servidor** para controlar sesiones.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await handleSessionCommand(
      interaction,
      campaigns,
      sessions,
      recordings,
      subcommand,
      interaction.guildId,
      interaction.guild,
    );
    return;
  }

  const configuredCampaigns = await campaigns.listByGuild(interaction.guildId);
  const content =
    configuredCampaigns.length === 0
      ? "Dotty está conectado, pero aún no hay campañas configuradas."
      : [
          "**Dotty está listo.**",
          ...configuredCampaigns.map(
            (campaign) =>
              `- **${escapeMarkdown(campaign.name)}**: ${campaign.memberCount} participantes, ${campaign.sessionCount} sesiones${formatCampaignDefaults(campaign)}`,
          ),
        ].join("\n");

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export async function handleDottyAutocomplete(
  interaction: AutocompleteInteraction,
  campaigns: CampaignService,
  sessions: SessionService,
): Promise<void> {
  if (interaction.commandName !== dottyCommand.name || interaction.guildId === null) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused(true);
  if (focused.name === "campaña") {
    const query = String(focused.value).trim().normalize("NFKC").toLocaleLowerCase("es");
    const configured = await campaigns.listByGuild(interaction.guildId);
    await interaction.respond(
      configured
        .filter((campaign) => campaign.name.normalize("NFKC").toLocaleLowerCase("es").includes(query))
        .slice(0, 25)
        .map((campaign) => ({ name: campaign.name, value: campaign.name })),
    );
    return;
  }

  if (focused.name === "número") {
    const campaignName = interaction.options.getString("campaña");
    if (!campaignName) {
      await interaction.respond([]);
      return;
    }

    const campaign = await campaigns.findByGuildAndName(interaction.guildId, campaignName);
    if (campaign === null) {
      await interaction.respond([]);
      return;
    }

    const sessionRows = await sessions.listByCampaignId(campaign.id);
    const candidates = sessionRows
      .map((session) => session.sequenceNumber)
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 25)
      .map((number) => ({ name: String(number), value: number }));
    await interaction.respond(candidates);
    return;
  }

  await interaction.respond([]);
}

function campaignOption(option: import("discord.js").SlashCommandStringOption) {
  return option
    .setName("campaña")
    .setDescription("Nombre exacto de la campaña configurada.")
    .setMinLength(1)
    .setMaxLength(80)
    .setAutocomplete(true)
    .setRequired(true);
}

function destinationOption(option: import("discord.js").SlashCommandStringOption) {
  return option
    .setName("destino")
    .setDescription("Dónde publicar la bitácora de esta campaña.")
    .addChoices(
      { name: "Chat del canal de voz", value: "voz" },
      { name: "Hilo en el canal actual", value: "actual" },
      { name: "Crear canal de bitácora", value: "crear" },
      { name: "Elegir otro canal", value: "elegir" },
    )
    .setRequired(true);
}

function logChannelOption(option: import("discord.js").SlashCommandChannelOption) {
  return option
    .setName("canal_bitacora")
    .setDescription("Canal de texto o Foro; úsalo con «Elegir otro canal».")
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum);
}

async function handleSessionCommand(
  interaction: ChatInputCommandInteraction,
  campaigns: CampaignService,
  sessions: SessionService,
  recordings: VoiceCaptureManager,
  subcommand: string,
  discordGuildId: string,
  guild: Guild,
): Promise<void> {
  const campaignName = interaction.options.getString("campaña", true).trim();
  try {
    let session;
    if (subcommand === "iniciar") {
      if (interaction.options.getString("consentimiento", true) !== "confirmado") {
        throw new UserFacingCommandError(
          "Debes confirmar que todos los participantes fueron informados antes de grabar.",
        );
      }
      const configuredCampaign = await campaigns.findByGuildAndName(
        discordGuildId,
        campaignName,
      );
      if (configuredCampaign === null) throw new CampaignNotFoundError(campaignName);
      const selectedVoiceChannel = interaction.options.getChannel("voz");
      const voiceChannelId =
        selectedVoiceChannel?.id ?? configuredCampaign.defaultVoiceChannelId;
      if (voiceChannelId === null) {
        throw new UserFacingCommandError(
          "Esta campaña no tiene un canal de voz predeterminado. Vuelve a configurarla desde `/dotty`.",
        );
      }
      const voiceChannel = guild.channels.resolve(voiceChannelId);
      if (voiceChannel === null || !voiceChannel.isVoiceBased()) {
        throw new UserFacingCommandError(
          "El canal de voz configurado ya no existe. Vuelve a configurar la campaña o elige otro canal.",
        );
      }
      const destination = interaction.options.getString("destino");
      const logChannelId =
        destination === null
          ? configuredCampaign.defaultLogChannelId
          : await resolveLogChannel(
              interaction,
              guild,
              voiceChannel,
              campaignName,
              destination,
            );
      session = await sessions.start({
            discordGuildId,
            campaignName,
            voiceChannelId: voiceChannel.id,
            logChannelId,
            occurredAt: new Date(),
          });
      try {
        await recordings.start(guild, session);
      } catch (error) {
        await sessions.fail(discordGuildId, campaignName, new Date());
        throw error;
      }
    } else if (subcommand === "pausar") {
      session = await sessions.pause(discordGuildId, campaignName);
      await recordings.pause(discordGuildId);
    } else if (subcommand === "reanudar") {
      session = await sessions.resume(discordGuildId, campaignName);
      await recordings.resume(discordGuildId);
    } else {
      session = await finalizeSessionSafely(
        sessions,
        recordings,
        discordGuildId,
        campaignName,
      );
    }

    const action = {
      iniciar: "iniciada",
      pausar: "pausada",
      reanudar: "reanudada",
      finalizar: "finalizada",
    }[subcommand];
    const notice =
      subcommand === "iniciar"
        ? "\n🔴 **Grabación activa:** las voces se guardarán localmente por hablante. El organizador confirmó que todos fueron informados."
        : "";
    await interaction.reply({
      content: `Sesión ${session.sequenceNumber} de **${escapeMarkdown(session.campaignName)}** ${action}.${notice}`,
    });
    await notifyVoiceChannel(
      guild,
      session.voiceChannelId,
      interaction.channelId,
      session.sequenceNumber,
      session.campaignName,
      subcommand,
      interaction.user.globalName ?? interaction.user.username,
    );
  } catch (error) {
    const content =
      error instanceof UserFacingCommandError
        ? error.message
        : error instanceof CampaignNotFoundError
        ? "No encontré esa campaña en este servidor. Revisa las campañas desde `/dotty`."
        : error instanceof ActiveSessionExistsError
          ? "Ya existe una sesión activa en este servidor. Finalízala antes de iniciar otra."
          : error instanceof ActiveSessionNotFoundError
            ? "Esa campaña no tiene una sesión activa."
            : error instanceof InvalidSessionTransitionError
              ? "La sesión no admite esa acción en su estado actual."
              : null;
    if (content === null) throw error;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

async function resolveLogChannel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  campaignName: string,
  destination: string,
): Promise<string | null> {
  if (destination === "voz") return null;

  if (destination === "actual") {
    if (interaction.channel?.type !== ChannelType.GuildText) {
      throw new UserFacingCommandError(
        "Para usar el canal actual, ejecuta el comando dentro de un canal de texto.",
      );
    }
    return interaction.channel.id;
  }

  if (destination === "elegir") {
    const selected = interaction.options.getChannel("canal_bitacora");
    if (
      selected?.type !== ChannelType.GuildText &&
      selected?.type !== ChannelType.GuildForum
    ) {
      throw new UserFacingCommandError(
        "Selecciona un canal de texto o Foro en `canal_bitacora`.",
      );
    }
    return selected.id;
  }

  const channelName = `bitacora-${slugifyChannelName(campaignName)}`.slice(0, 100);
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === channelName &&
      channel.parentId === voiceChannel.parentId,
  );
  if (existing !== undefined) return existing.id;

  try {
    const created = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: voiceChannel.parentId,
      reason: `Bitácora de la campaña ${campaignName}`,
    });
    return created.id;
  } catch (error) {
    throw new UserFacingCommandError(
      "No pude crear el canal de bitácora. Concede a Dotty el permiso **Gestionar canales** o elige un canal existente.",
      { cause: error },
    );
  }
}

function formatCampaignDefaults(campaign: {
  defaultVoiceChannelId: string | null;
  defaultLogChannelId: string | null;
  nextSessionNumber: number;
}): string {
  if (campaign.defaultVoiceChannelId === null) {
    return ` · próxima sesión ${campaign.nextSessionNumber} · sin canales predeterminados`;
  }
  const logDestination =
    campaign.defaultLogChannelId === null
      ? "chat de voz"
      : `<#${campaign.defaultLogChannelId}>`;
  return ` · próxima sesión ${campaign.nextSessionNumber} · voz <#${campaign.defaultVoiceChannelId}> · bitácora ${logDestination}`;
}

class UserFacingCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserFacingCommandError";
  }
}

function slugifyChannelName(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("es")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "campana"
  );
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, "\\$&");
}

function sessionStatusLabel(status: string): string {
  return (
    {
      scheduled: "programada",
      recording: "grabando",
      paused: "pausada",
      finalizing: "finalizando",
      completed: "completada",
      failed: "con error",
    }[status] ?? status
  );
}

async function notifyVoiceChannel(
  guild: Guild,
  voiceChannelId: string | null,
  interactionChannelId: string,
  sequenceNumber: number,
  campaignName: string,
  action: string,
  requestedBy: string,
): Promise<void> {
  if (voiceChannelId === null || voiceChannelId === interactionChannelId) return;
  const channel = guild.channels.resolve(voiceChannelId);
  if (channel === null || !channel.isTextBased()) return;
  const message = {
    iniciar: `🔴 **Grabación iniciada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**. ${escapeMarkdown(requestedBy)} confirmó que los participantes fueron informados.`,
    pausar: `⏸️ **Grabación pausada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**.`,
    reanudar: `🔴 **Grabación reanudada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**.`,
    finalizar: `⏹️ **Grabación finalizada** — Sesión ${sequenceNumber} de **${escapeMarkdown(campaignName)}**. Dotty procesará la transcripción.`,
  }[action];
  if (message !== undefined) await channel.send(message).catch(() => undefined);
}
