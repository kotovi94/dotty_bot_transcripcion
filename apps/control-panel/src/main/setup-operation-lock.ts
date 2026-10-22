import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export class SetupOperationLock {
  private readonly path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, ".setup-operation.lock");
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    const handle = await open(this.path, "wx", 0o600);
    try {
      await handle.writeFile(owner, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      return await action();
    } finally {
      // Un archivo superviviente o sustituido requiere inspección manual.
      if ((await readFile(this.path, "utf8").catch(() => "")) === owner) {
        await unlink(this.path);
      }
    }
  }
}
