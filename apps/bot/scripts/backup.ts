import Database from "better-sqlite3";
import { join } from "node:path";
import { access, writeFile } from "node:fs/promises";
import { readEnvironment } from "../src/config/environment.ts";
import { BackupManager } from "../src/backup/backup-manager.ts";
import { AutomaticBackups } from "../src/backup/automatic-backups.ts";
import { createLogger } from "../src/logging/logger.ts";

const environment = readEnvironment();
const manager = new BackupManager(environment.DOTTY_DATA_DIR, environment.DATABASE_URL);
const automation = new AutomaticBackups(environment.DOTTY_DATA_DIR, manager, createLogger(environment.DOTTY_LOG_LEVEL));
const covered = await automation.completions();
console.log("Creando respaldo completo de datos y bases SQLite…");
const summary = await manager.create({ reason: "manual-full" });
console.log(JSON.stringify(summary));
console.log("Verificando todos los archivos…");
const verification = await manager.verify(summary.name);
if (!verification.valid) throw new Error("El respaldo no pasó la verificación");
const databases: Record<string, unknown> = {};
for (const name of ["dotty.db", "transcriber.db"]) {
  if (!await access(join(summary.path, name)).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  })) continue;
  let db;
  try {
    db = new Database(join(summary.path, name), { readonly: true, fileMustExist: true });
    const result = db.pragma("quick_check") as Array<{ quick_check: string }>;
    if (result.some((row) => row.quick_check !== "ok")) throw new Error(`SQLite integrity failed: ${name}`);
    databases[name] = result;
  } finally { db?.close(); }
}
await writeFile(join(summary.path, "verification.json"), JSON.stringify({ checkedAt: new Date().toISOString(), verification, databases }, null, 2));
await automation.seedFromFullBackup(summary.name, covered);
console.log(JSON.stringify({ ...summary, verification, databases, automaticBaselineSaved: true }));
