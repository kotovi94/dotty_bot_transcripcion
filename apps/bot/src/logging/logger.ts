import pino from "pino";

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: ["token", "DISCORD_TOKEN", "authorization", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
  });
}
