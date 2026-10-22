import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { shell } from "electron";

import type { SetupConfig, SetupResult, SetupSafetyStatus, SetupStatus, TranscriptionMode } from "../shared/contracts.js";
import { SetupOperationLock } from "./setup-operation-lock.js";
import { inspectSetupSafety } from "./setup-safety.js";

const execFileAsync = promisify(execFile);
const snowflake = /^\d{17,20}$/;

class SetupSafetyError extends Error {}

function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
  }
  return values;
}

function mergeEnv(raw: string, updates: Map<string, string>): string {
  const separator = raw.includes("\r\n") ? "\r\n" : "\n";
  const seen = new Set<string>();
  const lines = raw ? raw.split(/\r?\n/) : [];
  const merged = lines.flatMap((line) => {
    const key = /^\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (!key || !updates.has(key)) return [line];
    if (seen.has(key)) return [];
    seen.add(key);
    return [`${key}=${updates.get(key)}`];
  });
  for (const [key, value] of updates) if (!seen.has(key)) merged.push(`${key}=${value}`);
  return merged.join(separator).replace(/(?:\r?\n)*$/u, separator);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function findCommand(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true });
    return stdout.split(/\r?\n/).find(Boolean)?.trim() ?? "";
  } catch { return ""; }
}

export class SetupManager {
  private readonly envPath: string;
  private readonly lock: SetupOperationLock;

  constructor(private readonly projectRoot: string,
    private readonly inspect: typeof inspectSetupSafety = inspectSetupSafety) {
    this.envPath = join(projectRoot, ".env");
    this.lock = new SetupOperationLock(projectRoot);
  }

  async getSafety(config: SetupConfig): Promise<SetupSafetyStatus> {
    if (await exists(join(this.projectRoot, ".setup-operation.lock"))) return {
      status: "blocked", message: "Ya hay una operación de configuración o arranque en curso.",
      action: "Espera a que termine. Si el candado sobrevivió a una caída, revísalo antes de retirarlo manualmente.",
    };
    return this.checkActivity(config);
  }

  private async checkActivity(config: SetupConfig): Promise<SetupSafetyStatus> {
    let raw = "";
    try { raw = await readFile(this.envPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return {
      status: "unknown", message: "No se pudo leer la configuración actual.",
      action: "Comprueba el acceso a .env antes de continuar.",
    }; }
    const oldData = parseEnv(raw).get("DOTTY_DATA_DIR");
    const dirs = [config.dataDirectory, oldData ? resolve(this.projectRoot, oldData) : join(this.projectRoot, "data")];
    return this.inspect(dirs);
  }

  async getStatus(): Promise<SetupStatus> {
    const raw = await readFile(this.envPath, "utf8").catch(() => "");
    const env = parseEnv(raw);
    const python = env.get("DOTTY_PYTHON_EXECUTABLE") || await findCommand("python.exe");
    const npm = env.get("DOTTY_NPM_EXECUTABLE") || await findCommand("npm.cmd");
    const defaultData = join(process.env.LOCALAPPDATA || this.projectRoot, "Dotty", "data");
    const dataSetting = env.get("DOTTY_DATA_DIR") || defaultData;
    const dataDirectory = isAbsolute(dataSetting) ? dataSetting : resolve(this.projectRoot, dataSetting);
    const mode = (env.get("DOTTY_TRANSCRIPTION_MODE") || "auto") as TranscriptionMode;
    const gpu = await this.detectGpu();
    const hasToken = Boolean(env.get("DISCORD_TOKEN"));
    const clientId = env.get("DISCORD_CLIENT_ID") || "";
    const guildId = env.get("DISCORD_GUILD_ID") || "";
    return {
      configured: hasToken && snowflake.test(clientId) && snowflake.test(guildId),
      hasDiscordToken: hasToken,
      discordClientId: clientId,
      discordGuildId: guildId,
      dataDirectory,
      pythonExecutable: python,
      npmExecutable: npm,
      transcriptionMode: ["auto", "cuda", "cpu"].includes(mode) ? mode : "auto",
      whisperModel: env.get("WHISPER_MODEL") || "large-v3-turbo",
      gpu,
      checks: {
        python: Boolean(python) && await exists(python),
        npm: Boolean(npm) && await exists(npm),
        transcriberEnvironment: await exists(join(this.projectRoot, "services", "transcriber", ".venv", "Scripts", "python.exe")),
        nodeModules: await exists(join(this.projectRoot, "node_modules")),
      },
    };
  }

  async validateDiscord(config: SetupConfig): Promise<SetupResult> {
    const token = config.discordToken.trim();
    if (!token && config.keepExistingToken) {
      return { ok: true, message: "Se conservará el token que ya está guardado." };
    }
    if (!token) return { ok: false, message: "Pega el token del bot para comprobarlo." };
    if (!snowflake.test(config.discordClientId) || !snowflake.test(config.discordGuildId)) {
      return { ok: false, message: "Los IDs deben contener entre 17 y 20 números, sin espacios." };
    }
    try {
      const headers = { Authorization: `Bot ${token}` };
      const [botResponse, guildResponse] = await Promise.all([
        fetch("https://discord.com/api/v10/users/@me", { headers, signal: AbortSignal.timeout(10_000) }),
        fetch(`https://discord.com/api/v10/guilds/${config.discordGuildId}`, { headers, signal: AbortSignal.timeout(10_000) }),
      ]);
      if (!botResponse.ok) return { ok: false, message: "Discord rechazó el token. Regénéralo en la sección Bot del portal." };
      const bot = await botResponse.json() as { id?: string; username?: string };
      if (bot.id !== config.discordClientId) {
        return { ok: false, message: "El ID de aplicación no corresponde al bot de ese token." };
      }
      if (!guildResponse.ok) {
        return { ok: false, message: "El bot es válido, pero todavía no puede ver ese servidor. Invítalo y revisa el ID." };
      }
      const guild = await guildResponse.json() as { name?: string };
      return { ok: true, message: `Conexión correcta: ${bot.username ?? "el bot"} puede acceder a ${guild.name ?? "tu servidor"}.` };
    } catch {
      return { ok: false, message: "No se pudo contactar a Discord. Revisa Internet e inténtalo otra vez." };
    }
  }

  async save(config: SetupConfig): Promise<SetupResult> {
    const validation = await this.validateLocal(config);
    if (!validation.ok) return validation;
    try {
      return await this.lock.run(async () => {
        await this.requireSafe(config);
        let raw = "";
        try { raw = await readFile(this.envPath, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const old = parseEnv(raw);
        const priorData = old.get("DOTTY_DATA_DIR");
        if (priorData && resolve(this.projectRoot, priorData) !== resolve(config.dataDirectory)) {
          return { ok: false, message: "El cambio de carpeta de datos requiere un traslado manual y verificado.",
            details: ["Conserva la carpeta actual o realiza el traslado con Dotty detenido."] };
        }
        const token = config.discordToken.trim() || (config.keepExistingToken ? old.get("DISCORD_TOKEN") || "" : "");
        if (!token) return { ok: false, message: "Falta el token de Discord." };
        const mode = config.transcriptionMode;
        const gpuDetected = mode === "auto" ? (await this.detectGpu()).detected : false;
        const device = mode === "cpu" || (mode === "auto" && !gpuDetected) ? "cpu" : "cuda";
        const updates = new Map<string, string>([
          ["DISCORD_TOKEN", token], ["DISCORD_CLIENT_ID", config.discordClientId],
          ["DISCORD_GUILD_ID", config.discordGuildId], ["DOTTY_DATA_DIR", config.dataDirectory],
          ["DOTTY_PYTHON_EXECUTABLE", config.pythonExecutable], ["DOTTY_NPM_EXECUTABLE", config.npmExecutable],
          ["DOTTY_TRANSCRIPTION_MODE", mode], ["WHISPER_MODEL", config.whisperModel],
          ["WHISPER_DEVICE", device], ["WHISPER_COMPUTE_TYPE", device === "cpu" ? "int8" : "float16"],
        ]);
        const defaults = new Map<string, string>([
          ["DATABASE_URL", `file:${join(config.dataDirectory, "dotty.db").replace(/\\/g, "/")}`],
          ["TRANSCRIBER_BASE_URL", "http://127.0.0.1:8765"],
          ["TRANSCRIBER_SHARED_SECRET", randomBytes(48).toString("base64url")],
          ["DOTTY_LOG_LEVEL", "info"], ["OLLAMA_BASE_URL", "http://127.0.0.1:11434"],
          ["OLLAMA_MODEL", "qwen3:4b"], ["DOTTY_OLLAMA_EXECUTABLE", "./runtime/ollama/ollama.exe"],
          ["OLLAMA_MODELS", join(config.dataDirectory, "models", "ollama")],
          ["WHISPER_LANGUAGE", "es"],
          ["WHISPER_INITIAL_PROMPT", "Dotty es un bot de Discord que transcribe sesiones de juegos de rol."],
        ]);
        for (const [key, value] of defaults) if (!old.has(key)) updates.set(key, value);
        const next = mergeEnv(raw, updates);
        const migrationNeeded = raw === "" && !await exists(join(config.dataDirectory, "dotty.db"));
        await this.requireSafe(config);
        if (migrationNeeded) {
          await mkdir(config.dataDirectory, { recursive: true });
          await this.run(config.npmExecutable, ["run", "db:deploy"], this.projectRoot,
            { DATABASE_URL: old.get("DATABASE_URL") || defaults.get("DATABASE_URL")! });
        }
        await this.requireSafe(config);
        await this.run(config.npmExecutable, ["run", "commands:deploy"], this.projectRoot,
          { DISCORD_TOKEN: token, DISCORD_CLIENT_ID: config.discordClientId, DISCORD_GUILD_ID: config.discordGuildId });
        await this.requireSafe(config);
        const currentRaw = await readFile(this.envPath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        if (currentRaw !== raw) throw new Error("La configuración cambió durante la operación; vuelve a revisarla.");
        await this.writeEnvSafely(next, raw !== "");
        return { ok: true, message: "Configuración guardada y comando /dotty registrado.",
          details: migrationNeeded ? ["Base de datos inicial preparada."] :
            ["La base de datos existente no se migró automáticamente. Revisa cualquier actualización de esquema por separado."] };
      });
    } catch (error) {
      const conflict = (error as NodeJS.ErrnoException).code === "EEXIST";
      return { ok: false, message: error instanceof SetupSafetyError ? error.message : conflict ?
        "Otra operación de configuración o arranque está en curso; no se aplicó el cambio." : "No se aplicó la configuración.",
        details: [error instanceof Error && error.message.startsWith("La configuración cambió") ? error.message :
          "Revisa la actividad de Dotty, los permisos y los registros del sistema antes de reintentar."] };
    }
  }

  async prepare(config: SetupConfig): Promise<SetupResult> {
    const validation = await this.validateLocal(config);
    if (!validation.ok) return validation;
    const details: string[] = [];
    try {
      return await this.lock.run(async () => {
        await this.requireSafe(config);
        const venvPython = join(this.projectRoot, "services", "transcriber", ".venv", "Scripts", "python.exe");
        if (!await exists(venvPython)) {
          await this.requireSafe(config);
          await this.run(config.pythonExecutable, ["-m", "venv", join(this.projectRoot, "services", "transcriber", ".venv")]);
          details.push("Entorno aislado de Python creado.");
        }
        await this.requireSafe(config);
        await this.run(venvPython, ["-m", "pip", "install", "-r", join(this.projectRoot, "services", "transcriber", "requirements.txt")]);
        details.push("Motor de transcripción instalado.");
        await this.requireSafe(config);
        await this.run(config.npmExecutable, ["install"], this.projectRoot);
        details.push("Componentes del bot instalados.");
        return { ok: true, message: "Todos los archivos necesarios están preparados.", details };
      });
    } catch (error) {
      const conflict = (error as NodeJS.ErrnoException).code === "EEXIST";
      return { ok: false, message: error instanceof SetupSafetyError ? error.message : conflict ?
        "Otra operación de configuración o arranque está en curso." :
        "La preparación se detuvo antes de continuar con seguridad.",
        details: [...details, "Comprueba que Dotty esté detenido y revisa los permisos y registros locales."] };
    }
  }

  private async requireSafe(config: SetupConfig): Promise<void> {
    const safety = await this.checkActivity(config);
    if (safety.status !== "allowed") throw new SetupSafetyError(`${safety.message} ${safety.action}`);
  }

  private async writeEnvSafely(content: string, hadPrevious: boolean): Promise<void> {
    const temporary = `${this.envPath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      if (hadPrevious) {
        await copyFile(this.envPath, `${this.envPath}.backup-${randomUUID()}`, constants.COPYFILE_EXCL);
      }
      await rename(temporary, this.envPath);
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async openLink(kind: "discord" | "node" | "python" | "cuda"): Promise<void> {
    const links = {
      discord: "https://discord.com/developers/applications",
      node: "https://nodejs.org/en/download",
      python: "https://www.python.org/downloads/windows/",
      cuda: "https://www.nvidia.com/Download/index.aspx",
    };
    await shell.openExternal(links[kind]);
  }

  private async validateLocal(config: SetupConfig): Promise<SetupResult> {
    for (const value of [config.discordToken, config.dataDirectory, config.pythonExecutable,
      config.npmExecutable, config.whisperModel]) {
      if (/[\r\n\0]/u.test(value)) return { ok: false, message: "Los valores no pueden contener saltos de línea ni caracteres de control." };
    }
    if (!snowflake.test(config.discordClientId) || !snowflake.test(config.discordGuildId)) {
      return { ok: false, message: "Revisa los IDs de Discord: deben tener entre 17 y 20 números." };
    }
    if (!config.dataDirectory.trim() || !isAbsolute(config.dataDirectory)) {
      return { ok: false, message: "Elige una carpeta de datos completa." };
    }
    if (!await exists(config.pythonExecutable)) return { ok: false, message: "No se encontró Python en la ruta elegida." };
    if (!await exists(config.npmExecutable)) return { ok: false, message: "No se encontró npm en la ruta elegida." };
    if (!["auto", "cuda", "cpu"].includes(config.transcriptionMode)) return { ok: false, message: "El modo de transcripción no es válido." };
    if (!["small", "medium", "large-v3-turbo", "large-v3"].includes(config.whisperModel)) {
      return { ok: false, message: "El modelo de voz no es válido." };
    }
    return { ok: true, message: "Rutas correctas." };
  }

  private async detectGpu(): Promise<SetupStatus["gpu"]> {
    try {
      const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 5_000 });
      const [name = "GPU NVIDIA", driver = ""] = stdout.trim().split(",").map((part) => part.trim());
      return { detected: true, name, driver, cudaRecommended: true };
    } catch { return { detected: false, name: null, driver: null, cudaRecommended: false }; }
  }

  private run(executable: string, args: string[], cwd = dirname(executable), variables: Record<string, string> = {}): Promise<void> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(executable, args, { cwd, windowsHide: true, stdio: "pipe", env: { ...process.env, ...variables } });
      child.stderr.resume();
      child.stdout.resume();
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(`El comando terminó con código ${code ?? "desconocido"}.`)));
    });
  }
}
