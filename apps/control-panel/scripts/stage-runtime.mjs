import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const panelRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(panelRoot, "..", "..");
const stagingRoot = join(panelRoot, "installer-project");

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

for (const file of ["package.json", "package-lock.json", "tsconfig.base.json", ".env.example"]) {
  await cp(join(projectRoot, file), join(stagingRoot, file));
}

const shouldCopy = (source) =>
  !source.includes(join("services", "transcriber", ".venv")) &&
  !source.includes("__pycache__") &&
  !source.includes(".pytest_cache") &&
  !source.includes(".mypy_cache") &&
  !source.includes(".ruff_cache") &&
  !source.endsWith(".pyc");

for (const folder of [join("apps", "bot"), "packages", "services", "tools"]) {
  await cp(join(projectRoot, folder), join(stagingRoot, folder), {
    recursive: true,
    filter: shouldCopy,
  });
}

// El lockfile conserva la definición del workspace del panel. Solo hace falta
// un manifiesto mínimo para resolver el árbol al preparar el bot instalado.
const panelPackageTarget = join(stagingRoot, "apps", "control-panel", "package.json");
await mkdir(dirname(panelPackageTarget), { recursive: true });
const panelPackage = JSON.parse(await readFile(join(panelRoot, "package.json"), "utf8"));
await writeFile(panelPackageTarget, JSON.stringify({
  name: panelPackage.name,
  version: panelPackage.version,
  private: true,
}, null, 2));
