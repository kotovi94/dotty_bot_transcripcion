import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DottyState } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
export interface BotProcessIdentity { pid: number; name: string; commandLine: string; createdAt: string }
export interface CachedBotIdentity { identity: BotProcessIdentity; at: number }
type BotState = DottyState["bot"];
const empty = (status: NonNullable<BotState["status"]>, reason: string): BotState =>
  ({ running: false, connected: false, pid: null, connectedAt: null, status, reason });

export function recentBotIdentity(previous: CachedBotIdentity | null, pid: number, now = Date.now()): BotProcessIdentity | null {
  return previous?.identity.pid === pid && now >= previous.at && now - previous.at <= 5_000
    ? previous.identity : null;
}

export async function inspectBotProcess(pid: number): Promise<BotProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if ($null -ne $p) { [pscustomobject]@{ pid=[int]$p.ProcessId; name=[string]$p.Name; commandLine=[string]$p.CommandLine; createdAt=([datetime]$p.CreationDate).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 2_500 });
  return stdout.trim() ? JSON.parse(stdout) as BotProcessIdentity : null;
}

export function evaluateBotHealth(raw: unknown, processInfo: BotProcessIdentity | null,
  now = Date.now()): BotState {
  if (!raw || typeof raw !== "object") return empty("unknown", "El estado del bot no se pudo interpretar.");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.instanceId !== "string" || !value.instanceId ||
      !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
      typeof value.processStartedAt !== "string" || typeof value.heartbeatAt !== "string" ||
      typeof value.status !== "string") {
    return empty("unknown", "El archivo de estado no contiene identidad y heartbeat verificables.");
  }
  const started = Date.parse(value.processStartedAt);
  const heartbeat = Date.parse(value.heartbeatAt);
  if (!Number.isFinite(started) || !Number.isFinite(heartbeat) || heartbeat < started || heartbeat > now + 2_000)
    return empty("unknown", "Las fechas de estado del bot no son válidas.");
  if (!processInfo) return empty(value.status === "stopping" ? "stopped" : "error", "El proceso de Dotty ya no existe.");
  const processStarted = Date.parse(processInfo.createdAt);
  if (processInfo.pid !== value.pid || !/^node(?:\.exe)?$/i.test(processInfo.name) ||
      !/(?:src[\\/])?index\.ts(?:["'\s]|$)/i.test(processInfo.commandLine) ||
      !Number.isFinite(processStarted) || Math.abs(processStarted - started) > 2_000) {
    return empty("unknown", "El PID pertenece a un proceso distinto de la instancia registrada.");
  }
  const common = { running: true, connected: false, pid: value.pid as number, instanceId: value.instanceId as string,
    connectedAt: null, heartbeatAt: value.heartbeatAt as string };
  if (now - heartbeat > 7_000) return { ...common, status: "unknown", reason: "La señal del bot está desactualizada." };
  switch (value.status) {
    case "starting": return { ...common, status: "starting", reason: "El cliente Discord se está iniciando." };
    case "ready": return typeof value.connectedAt === "string" && Number.isFinite(Date.parse(value.connectedAt)) &&
      Date.parse(value.connectedAt) >= started && Date.parse(value.connectedAt) <= heartbeat
      ? { ...common, connected: true, connectedAt: value.connectedAt, status: "connected", reason: null }
      : { ...common, status: "unknown", reason: "Falta la confirmación de conexión a Discord." };
    case "disconnected": return { ...common, status: "disconnected", reason: "Se perdió la conexión con Discord." };
    case "reconnecting": return { ...common, status: "reconnecting", reason: "Discord se está reconectando." };
    case "error": return { ...common, status: "error", reason: "El bot informó un error de arranque o conexión." };
    case "stopping": return { ...common, status: "active", reason: "El bot se está cerrando." };
    default: return { ...common, status: "unknown", reason: "Estado de Discord no reconocido." };
  }
}
