import { resolve } from "node:path";
import { rm, writeFile } from "node:fs/promises";

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

import { PrismaCampaignRepository } from "./campaigns/campaign-repository.ts";
import { CampaignService } from "./campaigns/campaign-service.ts";
import { BackupManager } from "./backup/backup-manager.ts";
import { readEnvironment } from "./config/environment.ts";
import { createDatabaseClient } from "./database/client.ts";
import { DottyDiagnostics } from "./diagnostics/dotty-diagnostics.ts";
import {
  handleDottyAutocomplete,
  handleDottyCommand,
  dottyCommand,
} from "./discord/dotty-command.ts";
import {
  handleDottyPanelCommand,
  handleDottyPanelInteraction,
} from "./discord/dotty-panel.ts";
import { handleDottyTutorialButton } from "./discord/dotty-tutorial.ts";
import { createLogger } from "./logging/logger.ts";
import { VoiceCaptureManager } from "./recording/voice-capture-manager.ts";
import { AudioRetentionManager } from "./storage/audio-retention-manager.ts";
import { PrismaSessionRepository } from "./sessions/session-repository.ts";
import { SessionService } from "./sessions/session-service.ts";
import {
  handleCampaignDeleteButton,
  handleSessionDeleteButton,
  handleSessionReprocessButton,
  SessionAdministration,
} from "./sessions/session-administration.ts";
import {
  resolveTranscriberSecret,
  TranscriptionDispatcher,
} from "./transcription/transcription-dispatcher.ts";
import { TranscriptionPublisher } from "./transcription/transcription-publisher.ts";
import { AdaptiveVocabularyStore } from "./transcription/adaptive-vocabulary.ts";
import { NarrativeGenerator } from "./narrative/narrative-generator.ts";
import { NarrativePublicationService } from "./narrative/narrative-publication.ts";
import { NarrativeManager } from "./narrative/narrative-manager.ts";
import { EditorialLearningService } from "./editorial/editorial-learning-service.ts";

const environment = readEnvironment();
const logger = createLogger(environment.DOTTY_LOG_LEVEL);
const botStatusPath = resolve(environment.DOTTY_DATA_DIR, "dotty.status.json");
await rm(botStatusPath, { force: true });
const database = createDatabaseClient(environment.DATABASE_URL);
const editorialLearning = new EditorialLearningService(database);
await editorialLearning.ensureCriticalRules();
const campaigns = new CampaignService(new PrismaCampaignRepository(database));
const sessionRepository = new PrismaSessionRepository(database);
const sessions = new SessionService(sessionRepository);
const recordings = new VoiceCaptureManager(environment.DOTTY_DATA_DIR, logger, {
  targetMs: environment.RECORDING_CLIP_TARGET_MINUTES * 60_000,
  searchStartMs: environment.RECORDING_CLIP_SEARCH_START_MINUTES * 60_000,
  maxMs: environment.RECORDING_CLIP_MAX_MINUTES * 60_000,
  overlapMs: environment.RECORDING_CLIP_OVERLAP_SECONDS * 1_000,
});
const transcriberSecret = resolveTranscriberSecret(
  environment.DOTTY_DATA_DIR,
  environment.TRANSCRIBER_SHARED_SECRET,
);
const adaptiveVocabulary = new AdaptiveVocabularyStore(
  resolve(environment.DOTTY_DATA_DIR, "adaptive-vocabulary"),
);
const transcriptions = new TranscriptionDispatcher(
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  campaigns,
  environment.TRANSCRIBER_BASE_URL,
  transcriberSecret,
  adaptiveVocabulary,
  logger,
);
const recoveredRecordings = await recordings.recoverInterrupted();
if (recoveredRecordings.length > 0) {
  await sessions.recoverInterrupted(recoveredRecordings, new Date());
  logger.warn(
    { count: recoveredRecordings.length },
    "Grabaciones interrumpidas cerradas y enviadas a recuperacion automatica",
  );
}
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const narrativeGenerator = new NarrativeGenerator(
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
  environment.OLLAMA_BASE_URL,
  environment.OLLAMA_MODEL,
  environment.TRANSCRIBER_BASE_URL,
  transcriberSecret,
  editorialLearning,
);
const narrativePublication = new NarrativePublicationService(
  client,
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
);
const narratives = new NarrativeManager(
  narrativeGenerator,
  narrativePublication,
  logger,
);
const publisher = new TranscriptionPublisher(
  campaigns,
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
  environment.TRANSCRIBER_BASE_URL,
  transcriberSecret,
  adaptiveVocabulary,
  logger,
);
const sessionAdministration = new SessionAdministration(
  client,
  campaigns,
  sessions,
  recordings,
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
  environment.TRANSCRIBER_BASE_URL,
  transcriberSecret,
  logger,
);
const diagnostics = new DottyDiagnostics(
  campaigns,
  sessions,
  environment.TRANSCRIBER_BASE_URL,
  environment.DOTTY_DATA_DIR,
);
const audioRetention = new AudioRetentionManager(
  campaigns,
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
  logger,
);
const backups = new BackupManager(environment.DOTTY_DATA_DIR);
transcriptions.start();
audioRetention.start();

client.once(Events.ClientReady, async (readyClient) => {
  logger.info({ userId: readyClient.user.id }, "Dotty conectado a Discord");
  await writeFile(
    botStatusPath,
    JSON.stringify(
      {
        status: "ready",
        pid: process.pid,
        connectedAt: new Date().toISOString(),
        userId: readyClient.user.id,
      },
      null,
      2,
    ),
    "utf8",
  ).catch((error) => logger.warn({ error }, "No se pudo guardar el estado del bot"));
  publisher.start();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isUserSelectMenu() || interaction.isModalSubmit()) &&
    interaction.customId.startsWith("dotty:ui:")
  ) {
    try {
      await handleDottyPanelInteraction(
        interaction,
        campaigns,
        sessions,
        recordings,
        sessionAdministration,
        diagnostics,
        audioRetention,
        backups,
        narratives,
      );
    } catch (error) {
      logger.error(
        { error, interactionId: interaction.id },
        "Fallo al utilizar el panel interactivo",
      );
      const response = {
        content: "El panel no pudo completar la operación. Ejecuta `/dotty` para abrirlo nuevamente.",
        components: [],
        flags: MessageFlags.Ephemeral,
      } as const;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response).catch(() => undefined);
      } else if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
        await interaction.reply(response).catch(() => undefined);
      } else {
        const updateResponse = {
          content: response.content,
          components: response.components,
        } as const;
        if (interaction.isModalSubmit()) {
          await interaction.update(updateResponse).catch(() => undefined);
        } else {
          await interaction.update(updateResponse).catch(() => undefined);
        }
      }
    }
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("dotty:session-reprocess:")
  ) {
    try {
      await handleSessionReprocessButton(interaction, sessionAdministration);
    } catch (error) {
      logger.error(
        { error, interactionId: interaction.id },
        "Fallo al reprocesar una sesión",
      );
    }
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("dotty:campaign-delete:")
  ) {
    try {
      await handleCampaignDeleteButton(interaction, sessionAdministration);
    } catch (error) {
      logger.error(
        { error, interactionId: interaction.id },
        "Fallo al eliminar una campaña",
      );
    }
    return;
  }

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("dotty:session-delete:")
  ) {
    try {
      await handleSessionDeleteButton(interaction, sessionAdministration);
    } catch (error) {
      logger.error(
        { error, interactionId: interaction.id },
        "Fallo al administrar una sesión",
      );
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("dotty:tutorial:")) {
    try {
      await handleDottyTutorialButton(interaction);
    } catch (error) {
      logger.error(
        { error, interactionId: interaction.id },
        "Fallo al navegar por el tutorial",
      );
    }
    return;
  }

  if (interaction.isAutocomplete() && interaction.commandName === dottyCommand.name) {
    try {
      await handleDottyAutocomplete(interaction, campaigns, sessions);
    } catch (error) {
      logger.error(
        { error, interactionId: interaction.id },
        "Fallo al mostrar campañas o sesiones configuradas",
      );
      await interaction.respond([]).catch(() => undefined);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === "dotty") {
      await handleDottyPanelCommand(interaction, campaigns);
      return;
    }
    if (interaction.commandName !== dottyCommand.name) return;
    await handleDottyCommand(
      interaction,
      campaigns,
      sessions,
      recordings,
      sessionAdministration,
      diagnostics,
      audioRetention,
    );
  } catch (error) {
    logger.error({ error, interactionId: interaction.id }, "Fallo al ejecutar comando");
    const response = {
      content: "Dotty no pudo completar la operación. Revisa los registros.",
      flags: MessageFlags.Ephemeral,
    } as const;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Cerrando Dotty");
  transcriptions.stop();
  publisher.stop();
  audioRetention.stop();
  await recordings.shutdown();
  client.destroy();
  await database.$disconnect();
  await rm(botStatusPath, { force: true }).catch(() => undefined);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(environment.DISCORD_TOKEN);
