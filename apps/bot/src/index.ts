import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

import { PrismaCampaignRepository } from "./campaigns/campaign-repository.ts";
import { CampaignService } from "./campaigns/campaign-service.ts";
import { BackupManager } from "./backup/backup-manager.ts";
import { AutomaticBackups } from "./backup/automatic-backups.ts";
import { readEnvironment } from "./config/environment.ts";
import { createDatabaseClient } from "./database/client.ts";
import { DottyDiagnostics } from "./diagnostics/dotty-diagnostics.ts";
import { BotStatusPublisher } from "./diagnostics/bot-status-publisher.ts";
import { TranscriptionReportService } from "./diagnostics/transcription-report-service.ts";
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
import { ReprocessIntentStore } from "./sessions/reprocess-intent-store.ts";
import { ReprocessIntentEligibility } from "./sessions/reprocess-intent-eligibility.ts";
import { SessionFileCoordinator } from "./sessions/session-file-coordinator.ts";
import { CampaignFileCoordinator } from "./sessions/campaign-file-coordinator.ts";
import { SessionLifecycleCoordinator } from "./sessions/session-lifecycle-coordinator.ts";
import { recoverClosedRecordings } from "./sessions/closed-recording-recovery.ts";
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
import { TranscriberWatchdog } from "./transcription/transcriber-watchdog.ts";
import { AdaptiveVocabularyStore } from "./transcription/adaptive-vocabulary.ts";
import { NarrativeGenerator } from "./narrative/narrative-generator.ts";
import { NarrativePublicationService } from "./narrative/narrative-publication.ts";
import { NarrativeManager } from "./narrative/narrative-manager.ts";
import { AutomaticNarrative } from "./pipeline/automatic-narrative.ts";
import { EditorialLearningService } from "./editorial/editorial-learning-service.ts";
import { runShutdownActions } from "./shutdown.ts";

const environment = readEnvironment();
const logger = createLogger(environment.DOTTY_LOG_LEVEL);
const botStatusPath = resolve(environment.DOTTY_DATA_DIR, "dotty.status.json");
const database = createDatabaseClient(environment.DATABASE_URL);
const editorialLearning = new EditorialLearningService(database);
await editorialLearning.ensureCriticalRules();
const campaigns = new CampaignService(new PrismaCampaignRepository(database));
const sessionRepository = new PrismaSessionRepository(database);
const campaignCoordinator = new CampaignFileCoordinator(resolve(environment.DOTTY_DATA_DIR, "campaign-locks"));
const sessionCoordinator = new SessionFileCoordinator(resolve(environment.DOTTY_DATA_DIR, "session-locks"));
const sessions = new SessionService(sessionRepository, campaigns, campaignCoordinator, sessionCoordinator);
const reprocessIntents = new ReprocessIntentStore(
  resolve(environment.DOTTY_DATA_DIR, "reprocess-intents"),
  sessionCoordinator,
  new ReprocessIntentEligibility(sessions, resolve(environment.DOTTY_DATA_DIR, "recordings")),
);
const diagnostics = new DottyDiagnostics(
  campaigns,
  sessions,
  environment.TRANSCRIBER_BASE_URL,
  environment.DOTTY_DATA_DIR,
);
const activityDiagnostics = environment.DOTTY_DIAGNOSTICS_ENABLED ? diagnostics : undefined;
const recordings = new VoiceCaptureManager(environment.DOTTY_DATA_DIR, logger, {
  targetMs: environment.RECORDING_CLIP_TARGET_MINUTES * 60_000,
  searchStartMs: environment.RECORDING_CLIP_SEARCH_START_MINUTES * 60_000,
  maxMs: environment.RECORDING_CLIP_MAX_MINUTES * 60_000,
  overlapMs: environment.RECORDING_CLIP_OVERLAP_SECONDS * 1_000,
}, {}, campaigns);
const sessionLifecycle = new SessionLifecycleCoordinator(sessions, sessionCoordinator, recordings);
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
  sessions,
  sessionCoordinator,
  reprocessIntents,
  activityDiagnostics,
);
const recoveredRecordings = await recordings.recoverInterrupted();
if (recoveredRecordings.length > 0) {
  await sessions.failInterrupted(recoveredRecordings, new Date());
  logger.warn(
    { count: recoveredRecordings.length },
    "Grabaciones interrumpidas cerradas; sesiones marcadas como fallidas para preservar el audio",
  );
}
const closedRecovery = await recoverClosedRecordings(
  sessions,
  sessionCoordinator,
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
);
if (closedRecovery.recovered.length > 0 || closedRecovery.skipped.length > 0) {
  logger.warn({ ...closedRecovery }, "Conciliación de sesiones con manifiestos cerrados");
}
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const botStatus = new BotStatusPublisher(botStatusPath, () => client.isReady());
await botStatus.start();
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
const automaticNarrative = new AutomaticNarrative(
  environment.DOTTY_DATA_DIR,
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
  environment.TRANSCRIBER_BASE_URL,
  narratives,
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
  sessions,
  sessionCoordinator,
  reprocessIntents,
  activityDiagnostics,
);
const transcriberWatchdog = new TranscriberWatchdog(
  new URL("/health", environment.TRANSCRIBER_BASE_URL).toString(),
  () => {
    const projectRoot = resolve(import.meta.dirname, "../../..");
    const recoveryScript = resolve(projectRoot, "tools", "recover-dotty.ps1");
    if (!existsSync(recoveryScript)) throw new Error(`No existe el recuperador: ${recoveryScript}`);
    logger.error({ recoveryScript }, "El transcriptor no responde; iniciando recuperación automática de Dotty");
    const recovery = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", recoveryScript,
    ], { cwd: projectRoot, windowsHide: true, detached: false, stdio: "ignore" });
    recovery.on("error", (error) => logger.error({ error }, "No se pudo iniciar la recuperación automática"));
    recovery.on("exit", (code, signal) => logger.error({ code, signal }, "El recuperador terminó antes de detener el bot"));
    recovery.unref();
  },
);
const transcriptionReports = new TranscriptionReportService(
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
  environment.DOTTY_DATA_DIR,
  diagnostics,
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
  reprocessIntents,
  sessionCoordinator,
  campaignCoordinator,
);
const audioRetention = new AudioRetentionManager(
  campaigns,
  resolve(environment.DOTTY_DATA_DIR, "recordings"),
  resolve(environment.DOTTY_DATA_DIR, "exports"),
  logger,
  reprocessIntents,
  sessionCoordinator,
);
const backups = new BackupManager(environment.DOTTY_DATA_DIR, environment.DATABASE_URL);
const automaticBackups = new AutomaticBackups(environment.DOTTY_DATA_DIR, backups, logger);
automaticBackups.start();
transcriptions.start();
if (environment.DOTTY_DIAGNOSTICS_ENABLED) transcriptionReports.start();
audioRetention.start();

client.once(Events.ClientReady, async (readyClient) => {
  logger.info({ userId: readyClient.user.id }, "Dotty conectado a Discord");
  await botStatus.setPhase("ready", readyClient.user.id).catch((error) => logger.warn({ error }, "No se pudo guardar el estado del bot"));
  publisher.start();
  automaticNarrative.start();
  transcriberWatchdog.start();
});
function updateBotPhase(phase: "ready" | "disconnected" | "reconnecting"): void {
  void botStatus.setPhase(phase, client.user?.id).catch((error) =>
    logger.warn({ error }, "No se pudo actualizar el estado de Discord"));
}
client.on(Events.ShardDisconnect, () => updateBotPhase("disconnected"));
client.on(Events.ShardReconnecting, () => updateBotPhase("reconnecting"));
client.on(Events.ShardResume, () => updateBotPhase("ready"));
client.on(Events.ShardReady, () => updateBotPhase("ready"));
client.on(Events.Error, (error) => {
  logger.warn({ error }, "Error del cliente Discord");
  if (!client.isReady()) void botStatus.setPhase("error").catch(() => undefined);
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
        sessionLifecycle,
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
      sessionLifecycle,
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
const stopRequestPath = resolve(environment.DOTTY_DATA_DIR, "dotty.stop-request.json");
const stopRequestTimer = setInterval(() => {
  void readFile(stopRequestPath, "utf8").then(async (content) => {
    const request = JSON.parse(content) as { pid?: number; instanceId?: string };
    if (request.pid !== process.pid || request.instanceId !== botStatus.instanceId) return;
    await shutdown("local-stop-request");
    await rm(stopRequestPath, { force: true });
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.error({ error }, "No se pudo completar la solicitud de apagado");
  });
}, 500);
stopRequestTimer.unref();
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(stopRequestTimer);
  logger.info({ signal }, "Cerrando Dotty");
  await botStatus.stop().catch((error) => logger.warn({ error }, "No se pudo actualizar el estado de cierre"));
  let lifecycleReport: Awaited<ReturnType<typeof sessionLifecycle.shutdown>> | undefined;
  const failures = await runShutdownActions([
    { resource: "transcriptions", run: () => transcriptions.stop() },
    { resource: "transcriptionReports", run: () => transcriptionReports.stop() },
    { resource: "publisher", run: () => publisher.stop() },
    { resource: "transcriberWatchdog", run: () => transcriberWatchdog.stop() },
    { resource: "automaticNarrative", run: () => automaticNarrative.stop() },
    { resource: "audioRetention", run: () => audioRetention.stop() },
    { resource: "automaticBackups", run: () => automaticBackups.stop() },
    { resource: "sessionLifecycle", run: async () => { lifecycleReport = await sessionLifecycle.shutdown(); } },
    { resource: "discord", run: () => client.destroy() },
    { resource: "prisma", run: () => database.$disconnect() },
  ], (failure, error) => {
    logger.error({ signal, resource: failure.resource, error }, "No se pudo cerrar un recurso durante el apagado");
  });

  const clean = lifecycleReport?.clean === true && failures.length === 0;
  if (clean) {
    failures.push(...await runShutdownActions([
      { resource: "botStatus", run: () => botStatus.removeIfOwned() },
    ], (failure, error) => {
      logger.error({ signal, resource: failure.resource, error }, "No se pudo limpiar el estado del bot");
    }));
  }
  if (!clean || failures.length > 0) {
    const report = {
      ...botStatus.snapshot(),
      status: "shutdown-incomplete",
      pid: process.pid,
      signal,
      completedAt: new Date().toISOString(),
      lifecycle: lifecycleReport ?? null,
      failures,
    };
    const reportWriteFailures = await runShutdownActions([
      { resource: "botStatus", run: () => botStatus.reportIfOwned(report) },
    ], (failure, error) => {
      logger.error({ signal, resource: failure.resource, error }, "No se pudo persistir el diagnóstico de apagado");
    });
    failures.push(...reportWriteFailures);
    logger.error(report, "Apagado incompleto; alguna captura puede seguir activa o incierta");
  } else {
    logger.info({ signal, captures: lifecycleReport?.captures }, "Apagado limpio de Dotty");
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await client.login(environment.DISCORD_TOKEN);
} catch (error) {
  await botStatus.setPhase("error");
  throw error;
}
