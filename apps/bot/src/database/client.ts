import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "../generated/prisma/client.ts";

export function createDatabaseClient(databaseUrl: string): PrismaClient {
  ensureSqliteDirectory(databaseUrl);
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

function ensureSqliteDirectory(databaseUrl: string): void {
  if (!databaseUrl.startsWith("file:") || databaseUrl.includes(":memory:")) {
    return;
  }

  const rawPath = databaseUrl.slice("file:".length).split("?")[0];
  if (rawPath === undefined || rawPath === "") {
    return;
  }

  const databasePath = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  mkdirSync(dirname(databasePath), { recursive: true });
}

