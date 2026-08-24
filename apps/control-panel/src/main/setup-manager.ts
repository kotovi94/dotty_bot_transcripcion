import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { shell } from "electron";

import type { SetupConfig, SetupResult, SetupStatus, TranscriptionMode } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
const snowflake = /^\d{17,20}$/;

function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
  }
  return values;
}

function envValue(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
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

  constructor(private readonly projectRoot: string) {
    this.envPath = join(projectRoot, ".env");
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
    const old = parseEnv(await readFile(this.envPath, "utf8").catch(() => ""));
    const token = config.discordToken.trim() || (config.keepExistingToken ? old.get("DISCORD_TOKEN") || "" : "");
    if (!token) return { ok: false, message: "Falta el token de Discord." };
    const mode = config.transcriptionMode;
    const gpuDetected = mode === "auto" ? (await this.detectGpu()).detected : false;
    const device = mode === "cpu" || (mode === "auto" && !gpuDetected) ? "cpu" : "cuda";
    const compute = device === "cpu" ? "int8" : "float16";
    const secret = old.get("TRANSCRIBER_SHARED_SECRET") || randomBytes(48).toString("base64url");
    const lines = [
      "# Configuración creada por el asistente de Dotty",
      `DISCORD_TOKEN=${envValue(token)}`,
      `DISCORD_CLIENT_ID=${envValue(config.discordClientId)}`,
      `DISCORD_GUILD_ID=${envValue(config.discordGuildId)}`,
      "",
      "# Rutas y servicios locales",
      `DATABASE_URL=file:${join(config.dataDirectory, "dotty.db").replace(/\\/g, "/")}`,
      "TRANSCRIBER_BASE_URL=http://127.0.0.1:8765",
      `TRANSCRIBER_SHARED_SECRET=${secret}`,
      `DOTTY_DATA_DIR=${envValue(config.dataDirectory)}`,
      `DOTTY_PYTHON_EXECUTABLE=${envValue(config.pythonExecutable)}`,
      `DOTTY_NPM_EXECUTABLE=${envValue(config.npmExecutable)}`,
      "DOTTY_LOG_LEVEL=info",
      "OLLAMA_BASE_URL=http://127.0.0.1:11434",
      `OLLAMA_MODEL=${old.get("OLLAMA_MODEL") || "qwen3:4b"}`,
      `DOTTY_OLLAMA_EXECUTABLE=${old.get("DOTTY_OLLAMA_EXECUTABLE") || "./runtime/ollama/ollama.exe"}`,
      `OLLAMA_MODELS=${old.get("OLLAMA_MODELS") || join(config.dataDirectory, "models", "ollama")}`,
      "",
      "# Transcripción local",
      `DOTTY_TRANSCRIPTION_MODE=${mode}`,
      `WHISPER_MODEL=${envValue(config.whisperModel)}`,
      `WHISPER_DEVICE=${device}`,
      `WHISPER_COMPUTE_TYPE=${compute}`,
      "WHISPER_LANGUAGE=es",
      "WHISPER_INITIAL_PROMPT=Dotty es un bot de Discord que transcribe sesiones de juegos de rol.",
      "",
    ];
    await mkdir(config.dataDirectory, { recursive: true });
    await writeFile(this.envPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    try {
      await this.run(config.npmExecutable, ["run", "db:deploy"], this.projectRoot);
      await this.run(config.npmExecutable, ["run", "commands:deploy"], this.projectRoot);
      return { ok: true, message: "Configuración guardada y comando /dotty registrado en tu servidor." };
    } catch (error) {
      return { ok: false, message: `La configuración se guardó, pero no se pudo terminar el registro en Discord: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async prepare(config: SetupConfig): Promise<SetupResult> {
    const validation = await this.validateLocal(config);
    if (!validation.ok) return validation;
    const details: string[] = [];
    try {
      const venvPython = join(this.projectRoot, "services", "transcriber", ".venv", "Scripts", "python.exe");
      if (!await exists(venvPython)) {
        await this.run(config.pythonExecutable, ["-m", "venv", join(this.projectRoot, "services", "transcriber", ".venv")]);
        details.push("Entorno aislado de Python creado.");
      }
      await this.run(venvPython, ["-m", "pip", "install", "-r", join(this.projectRoot, "services", "transcriber", "requirements.txt")]);
      details.push("Motor de transcripción instalado.");
      await this.run(config.npmExecutable, ["install"], this.projectRoot);
      details.push("Componentes del bot instalados.");
      return { ok: true, message: "Todos los archivos necesarios están preparados.", details };
    } catch (error) {
      return { ok: false, message: `La preparación se detuvo: ${error instanceof Error ? error.message : String(error)}`, details };
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
    if (!snowflake.test(config.discordClientId) || !snowflake.test(config.discordGuildId)) {
      return { ok: false, message: "Revisa los IDs de Discord: deben tener entre 17 y 20 números." };
    }
    if (!config.dataDirectory.trim() || !isAbsolute(config.dataDirectory)) {
      return { ok: false, message: "Elige una carpeta de datos completa." };
    }
    if (!await exists(config.pythonExecutable)) return { ok: false, message: "No se encontró Python en la ruta elegida." };
    if (!await exists(config.npmExecutable)) return { ok: false, message: "No se encontró npm en la ruta elegida." };
    if (!["auto", "cuda", "cpu"].includes(config.transcriptionMode)) return { ok: false, message: "El modo de transcripción no es válido." };
    return { ok: true, message: "Rutas correctas." };
  }

  private async detectGpu(): Promise<SetupStatus["gpu"]> {
    try {
      const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 5_000 });
      const [name = "GPU NVIDIA", driver = ""] = stdout.trim().split(",").map((part) => part.trim());
      return { detected: true, name, driver, cudaRecommended: true };
    } catch { return { detected: false, name: null, driver: null, cudaRecommended: false }; }
  }

  private run(executable: string, args: string[], cwd = dirname(executable)): Promise<void> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(executable, args, { cwd, windowsHide: true, stdio: "pipe" });
      const errors: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(Buffer.concat(errors).toString("utf8").trim().slice(-1200) || `código ${code}`)));
    });
  }
}
