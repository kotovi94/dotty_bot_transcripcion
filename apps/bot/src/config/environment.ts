import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const projectRoot = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);

loadDotEnv({ path: resolve(projectRoot, ".env"), quiet: true });

const environmentSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  DATABASE_URL: z.string().min(1).default("file:../../data/dotty.db"),
  DOTTY_DATA_DIR: z.string().min(1).default("./data"),
  TRANSCRIBER_BASE_URL: z.string().url().default("http://127.0.0.1:8765"),
  TRANSCRIBER_SHARED_SECRET: z.string().default(""),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen3:4b"),
  DOTTY_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DOTTY_DIAGNOSTICS_ENABLED: z
    .string()
    .default("true")
    .transform((value) => !["0", "false", "no", "off"].includes(value.trim().toLowerCase())),
  RECORDING_CLIP_TARGET_MINUTES: z.coerce.number().positive().default(60),
  RECORDING_CLIP_SEARCH_START_MINUTES: z.coerce.number().positive().default(55),
  RECORDING_CLIP_MAX_MINUTES: z.coerce.number().positive().default(65),
  RECORDING_CLIP_OVERLAP_SECONDS: z.coerce.number().min(0).max(10).default(1.5),
});

export type Environment = z.infer<typeof environmentSchema>;

export function readEnvironment(
  values: NodeJS.ProcessEnv = process.env,
): Environment {
  const result = environmentSchema.safeParse(values);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Dotty configuration: ${details}`);
  }
  return {
    ...result.data,
    DOTTY_DATA_DIR: resolve(projectRoot, result.data.DOTTY_DATA_DIR),
  };
}
