import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SetupSafetyStatus } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
const allowed: SetupSafetyStatus = {
  status: "allowed", message: "No se detectó actividad incompatible con la configuración.",
  action: "Puedes continuar. El estado se comprobará otra vez antes de cada cambio.",
};
const blocked = (message: string): SetupSafetyStatus => ({ status: "blocked", message,
  action: "Finaliza la actividad y detén Dotty de forma explícita antes de volver a intentarlo." });
const unknown = (message: string): SetupSafetyStatus => ({ status: "unknown", message,
  action: "Revisa el estado de Dotty y los archivos de coordinación antes de volver a intentarlo." });

export function classifySetupProcesses(value: unknown): SetupSafetyStatus {
  const processes = Array.isArray(value) ? value : value === null ? [] : [value];
  if (processes.some((item) => !item || typeof item !== "object" ||
      typeof (item as { CommandLine?: unknown }).CommandLine !== "string")) {
    return unknown("No se pudo identificar uno de los procesos Node o Python.");
  }
  if (processes.some((item) => {
    const command = (item as { CommandLine: string }).CommandLine;
    return /dotty_transcriber\.main:app|recover-session-(?:audio|transcript)\.py/iu.test(command) ||
      /(?:^|[\\/])(?:src[\\/])?index\.ts\b/iu.test(command);
  })) return blocked("Hay un proceso de Dotty o del transcriptor en ejecución.");
  return allowed;
}

async function entries(path: string): Promise<string[]> {
  try { return await readdir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function inspectSetupSafety(dataDirs: string[]): Promise<SetupSafetyStatus> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|python|uvicorn)(\\.exe)?$' } | Select-Object Name,CommandLine | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 5_000, maxBuffer: 2_000_000 });
    const value = stdout.trim() ? JSON.parse(stdout) as unknown : [];
    const processes = classifySetupProcesses(value);
    if (processes.status !== "allowed") return processes;

    return await inspectSetupArtifacts(dataDirs);
  } catch {
    return unknown("No se pudo comprobar con fiabilidad si Dotty está inactivo.");
  }
}

export async function inspectSetupArtifacts(dataDirs: string[]): Promise<SetupSafetyStatus> {
  try {
    for (const dataDir of new Set(dataDirs)) {
      for (const name of await entries(join(dataDir, "reprocess-intents"))) {
        if (name) return blocked("Hay una intención administrativa de reprocesamiento pendiente.");
      }
      for (const name of await entries(join(dataDir, "session-locks"))) {
        if (name) return unknown("Existe un candado de sesión que requiere revisión.");
      }
      for (const session of await entries(join(dataDir, "recordings"))) {
        const directory = join(dataDir, "recordings", session);
        let raw: string;
        try { raw = await readFile(join(directory, "manifest.json"), "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") continue;
          throw error;
        }
        const manifest = JSON.parse(raw) as { status?: unknown };
        if (["recording", "paused", "finalizing"].includes(String(manifest.status))) {
          return blocked("Hay una grabación activa o en cierre.");
        }
        if ((await entries(directory)).includes(".transcription-regenerating")) {
          return blocked("Hay una retranscripción en preparación.");
        }
      }
      for (const session of await entries(join(dataDir, "recovered-audio"))) {
        try {
          const raw = await readFile(join(dataDir, "recovered-audio", session, "transcription.status.json"), "utf8");
          const recovery = JSON.parse(raw) as { phase?: unknown };
          if (["validating", "enqueuing", "transcribing", "preparing"].includes(String(recovery.phase))) {
            return blocked("Hay una recuperación de transcripción en curso.");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return allowed;
  } catch {
    return unknown("No se pudo comprobar con fiabilidad si Dotty está inactivo.");
  }
}
