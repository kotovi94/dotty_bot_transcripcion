import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeFileAtomically(path: string, content: string): Promise<void> {
  const suffix = `${process.pid}-${randomUUID()}`;
  const temporaryPath = `${path}.${suffix}.tmp`;
  const backupPath = `${path}.${suffix}.bak`;

  await fs.writeFile(temporaryPath, content, {
    encoding: "utf8",
    flag: "wx",
  });

  try {
    await fs.rename(temporaryPath, path);
    return;
  } catch (error) {
    if (!(await fileExists(path))) throw error;
  }

  // Windows does not allow rename() to replace an existing file. Move the old
  // manifest aside first so the new file can still be installed with rename().
  await fs.rename(path, backupPath);
  try {
    await fs.rename(temporaryPath, path);
  } catch (error) {
    await fs.rename(backupPath, path).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  await fs.rm(backupPath, { force: true });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
