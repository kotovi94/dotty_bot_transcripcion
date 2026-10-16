import type { Guild } from "discord.js";

import type { CaptureShutdownReport, VoiceCaptureManager } from "../recording/voice-capture-manager.ts";
import { finalizeSessionSafely } from "./session-finalization.ts";
import { ActiveSessionNotFoundError, type ManagedSession, type PersistedSession, type StartSessionInput } from "./session-repository.ts";
import type { SessionFileCoordinator } from "./session-file-coordinator.ts";
import type { SessionService } from "./session-service.ts";

export class SessionLifecycleError extends Error {}

export interface SessionLifecycleShutdownReport {
  readonly captures: CaptureShutdownReport;
  readonly operationFailures: readonly string[];
  readonly shutdownError?: string;
  readonly clean: boolean;
}

export class SessionLifecycleCoordinator {
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopping = false;
  private shutdownTask: Promise<SessionLifecycleShutdownReport> | undefined;

  constructor(
    private readonly sessions: SessionService,
    private readonly coordinator: SessionFileCoordinator,
    private readonly recordings: VoiceCaptureManager,
  ) {}

  start(guild: Guild, input: StartSessionInput): Promise<PersistedSession> {
    return this.track(() => this.sessions.startWithCapture(input, (session) => this.recordings.start(guild, session)));
  }

  pause(discordGuildId: string, campaignName: string): Promise<PersistedSession> {
    return this.track(() => this.withActiveSession(discordGuildId, campaignName, ["recording"], "pause", async (session) => {
      this.recordings.assertTransitionAllowed(discordGuildId, session.id, "pause");
      const transitioned = await this.sessions.pause(discordGuildId, campaignName);
      await this.withFailureState(discordGuildId, campaignName, () => this.recordings.pause(discordGuildId));
      return transitioned;
    }));
  }

  resume(discordGuildId: string, campaignName: string): Promise<PersistedSession> {
    return this.track(() => this.withActiveSession(discordGuildId, campaignName, ["paused"], "resume", async (session) => {
      this.recordings.assertTransitionAllowed(discordGuildId, session.id, "resume");
      const transitioned = await this.sessions.resume(discordGuildId, campaignName);
      await this.withFailureState(discordGuildId, campaignName, () => this.recordings.resume(discordGuildId));
      return transitioned;
    }));
  }

  finish(
    discordGuildId: string,
    campaignName: string,
    occurredAt = new Date(),
  ): Promise<PersistedSession | ManagedSession> {
    return this.track(() => this.withActiveSession(discordGuildId, campaignName, ["recording", "paused"], "finish", async (session) => {
      this.recordings.assertTransitionAllowed(discordGuildId, session.id, "finish");
      return finalizeSessionSafely(
        this.sessions,
        this.recordings,
        discordGuildId,
        campaignName,
        occurredAt,
      );
    }));
  }

  shutdown(): Promise<SessionLifecycleShutdownReport> {
    if (this.shutdownTask !== undefined) return this.shutdownTask;
    this.stopping = true;
    this.shutdownTask = (async () => {
      const operations = await Promise.allSettled([...this.inFlight]);
      const operationFailures = operations.flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : [],
      );
      try {
        const captures = await this.recordings.shutdown((sessionId, action) =>
          this.coordinator.runExclusive(sessionId, action),
        );
        return {
          captures,
          operationFailures,
          clean: operationFailures.length === 0 &&
            captures.failedCaptures.length === 0 &&
            captures.uncertainCaptures.length === 0,
        };
      } catch (error) {
        return {
          captures: { closedSessionIds: [], failedCaptures: [], uncertainCaptures: [] },
          operationFailures,
          shutdownError: error instanceof Error ? error.message : String(error),
          clean: false,
        };
      }
    })();
    return this.shutdownTask;
  }

  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new SessionLifecycleError("Dotty está cerrando y no acepta nuevas transiciones de sesión."));
    const operation = Promise.resolve().then(action);
    this.inFlight.add(operation);
    void operation.finally(() => this.inFlight.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async withActiveSession<T>(
    discordGuildId: string,
    campaignName: string,
    allowedStatuses: readonly ManagedSession["status"][],
    operation: string,
    action: (session: ManagedSession) => Promise<T>,
  ): Promise<T> {
    const candidate = await this.sessions.findActive(discordGuildId, campaignName);
    if (candidate === null) throw new ActiveSessionNotFoundError(campaignName);
    if (!allowedStatuses.includes(candidate.status)) {
      throw new SessionLifecycleError(`No se puede ${operation} una sesión desde el estado ${candidate.status}.`);
    }

    return this.coordinator.runExclusive(candidate.id, async () => {
      const [current, active] = await Promise.all([
        this.sessions.findById(candidate.id),
        this.sessions.findActive(discordGuildId, campaignName),
      ]);
      if (
        current === null || current.id !== candidate.id ||
        current.discordGuildId !== discordGuildId ||
        current.campaignName !== candidate.campaignName ||
        current.status !== candidate.status ||
        active?.id !== candidate.id || active.status !== candidate.status ||
        !allowedStatuses.includes(current.status)
      ) {
        throw new SessionLifecycleError("La sesión cambió antes de completar la transición; vuelve a intentarlo.");
      }
      return action(current);
    });
  }

  private async withFailureState<T>(
    discordGuildId: string,
    campaignName: string,
    captureOperation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await captureOperation();
    } catch (captureError) {
      try {
        await this.sessions.fail(discordGuildId, campaignName, new Date());
      } catch (databaseError) {
        throw new AggregateError(
          [captureError, databaseError],
          "La captura falló y no se pudo registrar el estado fallido de la sesión.",
          { cause: captureError },
        );
      }
      throw captureError;
    }
  }
}
