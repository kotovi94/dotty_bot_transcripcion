import type { Logger } from "pino";

import { NarrativeGenerator, type NarrativeStatus } from "./narrative-generator.ts";
import { NarrativePublicationService } from "./narrative-publication.ts";

export class NarrativeManager {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly generator: NarrativeGenerator,
    private readonly publication: NarrativePublicationService,
    private readonly logger: Logger,
  ) {}

  status(sessionId: string): Promise<NarrativeStatus> {
    return this.generator.getStatus(sessionId);
  }

  async start(sessionId: string): Promise<{ started: boolean; status: NarrativeStatus }> {
    const running = this.active.get(sessionId);
    if (running !== undefined) {
      return { started: false, status: await this.generator.getStatus(sessionId) };
    }
    const task = this.generator.generate(sessionId)
      .then(() => {
        this.logger.info({ sessionId }, "Guion narrativo local generado");
      })
      .catch((error) => {
        this.logger.error({ sessionId, error }, "Fallo al generar el guion narrativo local");
      })
      .finally(() => {
        this.active.delete(sessionId);
      });
    this.active.set(sessionId, task);
    return {
      started: true,
      status: {
        state: "queued",
        sessionId,
        model: (await this.generator.getStatus(sessionId)).model,
        progress: 0,
        phase: "Generación puesta en cola",
        updatedAt: new Date().toISOString(),
      },
    };
  }

  publish(sessionId: string, discordGuildId: string) {
    return this.publication.publish(sessionId, discordGuildId);
  }
}
