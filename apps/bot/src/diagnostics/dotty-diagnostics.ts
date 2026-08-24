import { promises as fs } from "node:fs";

import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
} from "discord.js";

import type { CampaignService } from "../campaigns/campaign-service.ts";
import type { SessionService } from "../sessions/session-service.ts";

export interface DiagnosticCheck {
  readonly level: "ok" | "warning" | "error";
  readonly label: string;
  readonly detail: string;
}

export interface DiagnosticReport {
  readonly campaignName: string;
  readonly checks: readonly DiagnosticCheck[];
  readonly ready: boolean;
}

export class DottyDiagnostics {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly sessions: SessionService,
    private readonly transcriberBaseUrl: string,
    private readonly dataDirectory: string,
  ) {}

  async run(guild: Guild, campaignName: string): Promise<DiagnosticReport> {
    const checks: DiagnosticCheck[] = [];
    const campaign = await this.campaigns.findByGuildAndName(guild.id, campaignName);
    if (campaign === null) {
      return {
        campaignName,
        ready: false,
        checks: [
          {
            level: "error",
            label: "Campaña",
            detail: "No está configurada en este servidor.",
          },
        ],
      };
    }

    const summary = (await this.campaigns.listByGuild(guild.id)).find(
      (candidate) => candidate.id === campaign.id,
    );
    checks.push({
      level: "ok",
      label: "Campaña",
      detail: `${campaign.name}; próxima sesión ${summary?.nextSessionNumber ?? campaign.nextSessionNumber}.`,
    });

    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    this.checkVoiceChannel(guild, botMember, campaign.defaultVoiceChannelId, checks);
    this.checkLogChannel(guild, botMember, campaign.defaultLogChannelId, checks);

    const members = await this.campaigns.listMembersByCampaignId(campaign.id);
    checks.push({
      level: members.length === 0 ? "warning" : "ok",
      label: "Personajes",
      detail:
        members.length === 0
          ? "No hay personajes asignados; se mostrarán nombres de Discord."
          : `${members.length} asignación${members.length === 1 ? "" : "es"} configurada${members.length === 1 ? "" : "s"}.`,
    });

    const recent = await this.sessions.listRecent(guild.id, campaign.name, 10);
    const active = recent.find((session) =>
      ["recording", "paused", "finalizing"].includes(session.status),
    );
    checks.push({
      level: active === undefined ? "ok" : "warning",
      label: "Sesiones",
      detail:
        active === undefined
          ? "No hay una sesión activa."
          : `La sesión ${active.sequenceNumber} está ${statusLabel(active.status)}.`,
    });

    checks.push(await this.checkTranscriber());
    checks.push(await this.checkStorage());
    return {
      campaignName: campaign.name,
      checks,
      ready: !checks.some((check) => check.level === "error"),
    };
  }

  private checkVoiceChannel(
    guild: Guild,
    botMember: GuildMember,
    channelId: string | null,
    checks: DiagnosticCheck[],
  ): void {
    if (channelId === null) {
      checks.push({
        level: "error",
        label: "Canal de voz",
        detail: "No hay un canal predeterminado.",
      });
      return;
    }
    const channel = guild.channels.resolve(channelId);
    if (channel === null || !channel.isVoiceBased()) {
      checks.push({
        level: "error",
        label: "Canal de voz",
        detail: "El canal configurado ya no existe o no es de voz.",
      });
      return;
    }
    const missing = missingPermissions(channel, botMember, [
      [PermissionFlagsBits.ViewChannel, "ver el canal"],
      [PermissionFlagsBits.Connect, "conectarse"],
      [PermissionFlagsBits.SendMessages, "publicar avisos"],
    ]);
    checks.push({
      level: missing.length === 0 ? "ok" : "error",
      label: "Canal de voz",
      detail:
        missing.length === 0
          ? `${channel.name}; Dotty puede entrar y escuchar.`
          : `Faltan permisos para ${missing.join(" y ")}.`,
    });
  }

  private checkLogChannel(
    guild: Guild,
    botMember: GuildMember,
    channelId: string | null,
    checks: DiagnosticCheck[],
  ): void {
    if (channelId === null) {
      checks.push({
        level: "warning",
        label: "Bitácora",
        detail: "Se publicará directamente en el chat del canal de voz.",
      });
      return;
    }
    const channel = guild.channels.resolve(channelId);
    if (
      channel === null ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)
    ) {
      checks.push({
        level: "error",
        label: "Bitácora",
        detail: "El canal configurado ya no existe o no admite publicaciones.",
      });
      return;
    }
    const required = [
      [PermissionFlagsBits.ViewChannel, "ver el canal"],
      [PermissionFlagsBits.SendMessages, "crear publicaciones"],
      [PermissionFlagsBits.SendMessagesInThreads, "escribir en publicaciones"],
      [PermissionFlagsBits.ReadMessageHistory, "leer el historial"],
    ] as const;
    const missing = missingPermissions(channel, botMember, required);
    const canManage = channel
      .permissionsFor(botMember)
      ?.has(PermissionFlagsBits.ManageThreads) ?? false;
    checks.push({
      level: missing.length > 0 ? "error" : canManage ? "ok" : "warning",
      label: channel.type === ChannelType.GuildForum ? "Foro de bitácoras" : "Canal de bitácoras",
      detail:
        missing.length > 0
          ? `Faltan permisos para ${missing.join(", ")}.`
          : canManage
            ? `${channel.name}; puede publicar, escribir y borrar publicaciones.`
            : `${channel.name}; puede publicar, pero falta Gestionar hilos para garantizar el borrado.`,
    });
  }

  private async checkTranscriber(): Promise<DiagnosticCheck> {
    try {
      const response = await fetch(new URL("/health", this.transcriberBaseUrl), {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = (await response.json()) as {
        model: string;
        active_device: string;
        queue: { queued: number; processing: number; failed: number };
      };
      const busy = health.queue.queued + health.queue.processing;
      return {
        level: health.queue.failed > 0 ? "warning" : "ok",
        label: "Transcriptor",
        detail: `Modelo ${health.model} en ${health.active_device}; ${busy} pendientes y ${health.queue.failed} fallidos.`,
      };
    } catch {
      return {
        level: "error",
        label: "Transcriptor",
        detail: "El servicio local no responde.",
      };
    }
  }

  private async checkStorage(): Promise<DiagnosticCheck> {
    try {
      const stats = await fs.statfs(this.dataDirectory);
      const freeBytes = stats.bavail * stats.bsize;
      return {
        level: freeBytes < 1_073_741_824 ? "error" : freeBytes < 5_368_709_120 ? "warning" : "ok",
        label: "Almacenamiento",
        detail: `${formatBytes(freeBytes)} disponibles para audios y transcripciones.`,
      };
    } catch {
      return {
        level: "warning",
        label: "Almacenamiento",
        detail: "No pude calcular el espacio disponible.",
      };
    }
  }
}

function missingPermissions(
  channel: GuildBasedChannel,
  member: GuildMember,
  required: readonly (readonly [bigint, string])[],
): string[] {
  const permissions = channel.permissionsFor(member);
  return required
    .filter(([permission]) => !permissions?.has(permission))
    .map(([, label]) => label);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function statusLabel(status: string): string {
  return (
    {
      recording: "grabándose",
      paused: "pausada",
      finalizing: "finalizando",
    }[status] ?? status
  );
}
