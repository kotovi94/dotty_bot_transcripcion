import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";

interface BackupFileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface BackupManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly files: readonly BackupFileEntry[];
  readonly totalBytes: number;
}

export interface BackupSummary {
  readonly name: string;
  readonly path: string;
  readonly createdAt: Date;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export class ActiveRecordingBackupError extends Error {
  constructor() {
    super("Finaliza o cancela la grabación activa antes de crear un respaldo.");
    this.name = "ActiveRecordingBackupError";
  }
}

export class BackupManager {
  private readonly backupsRoot: string;
  private readonly recordingsRoot: string;
  private readonly exportsRoot: string;
  private readonly databasePath: string;

  constructor(private readonly dataRoot: string) {
    this.backupsRoot = join(dataRoot, "backups");
    this.recordingsRoot = join(dataRoot, "recordings");
    this.exportsRoot = join(dataRoot, "exports");
    this.databasePath = join(dataRoot, "dotty.db");
  }

  async create(): Promise<BackupSummary> {
    if (await this.hasActiveRecording()) throw new ActiveRecordingBackupError();

    await fs.mkdir(this.backupsRoot, { recursive: true });
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}-${randomUUID().slice(0, 8)}`;
    const temporaryPath = join(this.backupsRoot, `.creating-${name}`);
    const finalPath = join(this.backupsRoot, name);

    await fs.mkdir(temporaryPath, { recursive: false });
    try {
      await this.copyIfPresent(this.databasePath, join(temporaryPath, "dotty.db"));
      await this.copyIfPresent(this.recordingsRoot, join(temporaryPath, "recordings"));
      await this.copyIfPresent(this.exportsRoot, join(temporaryPath, "exports"));

      const files = await collectFiles(temporaryPath);
      const manifest: BackupManifest = {
        version: 1,
        createdAt: now.toISOString(),
        files,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      };
      await fs.writeFile(
        join(temporaryPath, "backup-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await fs.rename(temporaryPath, finalPath);
      return toSummary(name, finalPath, manifest);
    } catch (error) {
      await fs.rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  }

  async list(limit = 10): Promise<readonly BackupSummary[]> {
    await fs.mkdir(this.backupsRoot, { recursive: true });
    const entries = await fs.readdir(this.backupsRoot, { withFileTypes: true });
    const summaries: BackupSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".creating-")) continue;
      const directory = join(this.backupsRoot, entry.name);
      try {
        const manifest = JSON.parse(
          await fs.readFile(join(directory, "backup-manifest.json"), "utf8"),
        ) as BackupManifest;
        if (manifest.version !== 1 || !Array.isArray(manifest.files)) continue;
        summaries.push(toSummary(entry.name, directory, manifest));
      } catch {
        // Una carpeta incompleta no se presenta como respaldo valido.
      }
    }
    return summaries
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, Math.max(0, limit));
  }

  async verify(name: string): Promise<{ valid: boolean; checkedFiles: number }> {
    if (basename(name) !== name || name.startsWith(".")) return { valid: false, checkedFiles: 0 };
    const directory = join(this.backupsRoot, name);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(
        await fs.readFile(join(directory, "backup-manifest.json"), "utf8"),
      ) as BackupManifest;
    } catch {
      return { valid: false, checkedFiles: 0 };
    }
    let totalBytes = 0;
    for (const expected of manifest.files) {
      const absolutePath = join(directory, ...expected.path.split("/"));
      try {
        const info = await fs.stat(absolutePath);
        if (!info.isFile() || info.size !== expected.bytes) return { valid: false, checkedFiles: totalBytes };
        if ((await sha256File(absolutePath)) !== expected.sha256) {
          return { valid: false, checkedFiles: manifest.files.indexOf(expected) };
        }
        totalBytes += 1;
      } catch {
        return { valid: false, checkedFiles: totalBytes };
      }
    }
    return { valid: true, checkedFiles: totalBytes };
  }

  private async copyIfPresent(source: string, destination: string): Promise<void> {
    try {
      await fs.cp(source, destination, { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async hasActiveRecording(): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(this.recordingsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          await fs.readFile(join(this.recordingsRoot, entry.name, "manifest.json"), "utf8"),
        ) as { status?: string };
        if (["recording", "paused", "finalizing"].includes(manifest.status ?? "")) return true;
      } catch {
        // Los manifiestos invalidos se copiaran para que puedan inspeccionarse.
      }
    }
    return false;
  }
}

async function collectFiles(root: string): Promise<BackupFileEntry[]> {
  const pending = [root];
  const files: BackupFileEntry[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile()) {
        const info = await fs.stat(absolutePath);
        files.push({
          path: relative(root, absolutePath).split("\\").join("/"),
          bytes: info.size,
          sha256: await sha256File(absolutePath),
        });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function toSummary(name: string, path: string, manifest: BackupManifest): BackupSummary {
  return {
    name,
    path,
    createdAt: new Date(manifest.createdAt),
    fileCount: manifest.files.length,
    totalBytes: manifest.totalBytes,
  };
}
