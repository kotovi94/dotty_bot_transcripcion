import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../../..");
const electronPath = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const entryPath = join(projectRoot, "apps", "control-panel", "dist", "main", "main", "main.js");
const debuggingPort = 12_000 + Math.floor(Math.random() * 2_000);

async function hasActiveRecording() {
  const root = join(projectRoot, "data", "recordings");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(root, entry.name, "manifest.json"), "utf8"),
      );
      if (["recording", "paused", "finalizing"].includes(manifest.status)) return true;
    } catch {
      // Una carpeta sin manifiesto valido no representa una grabacion activa.
    }
  }
  return false;
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check().catch(() => false);
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timeout esperando: ${label}`);
}

function connectDebugger(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("error", reject);
    socket.addEventListener("close", () => {
      for (const request of pending.values()) {
        request.reject(new Error("La conexion de diagnostico se cerro."));
      }
      pending.clear();
    });
    socket.addEventListener("open", () => {
      resolvePromise({
        socket,
        call(method, params = {}) {
          const id = ++sequence;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveCall, rejectCall) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error(`Sin respuesta del protocolo: ${method}`));
            }, 7_000);
            pending.set(id, {
              resolve: (value) => { clearTimeout(timeout); resolveCall(value); },
              reject: (error) => { clearTimeout(timeout); rejectCall(error); },
            });
          });
        },
      });
    });
  });
}

async function removeTestProfile(path) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 10 || error?.code !== "EBUSY") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

async function main() {
  if (await hasActiveRecording()) {
    throw new Error("Hay una grabacion activa; la prueba no apagara Dotty.");
  }
  const testProfile = await mkdtemp(join(tmpdir(), "dotty-panel-e2e-"));
  const application = spawn(
    electronPath,
    [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${testProfile}`,
      entryPath,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, DOTTY_E2E: "1" },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  let debuggerClient;
  try {
    const target = await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json`, {
        signal: AbortSignal.timeout(2_000),
      }).then((response) => response.json());
      return targets.find((candidate) => candidate.type === "page");
    }, 15_000, "ventana Electron");
    debuggerClient = await connectDebugger(target.webSocketDebuggerUrl);

    const evaluate = async (expression) => {
      const response = await debuggerClient.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error("La interfaz produjo una excepcion.");
      return response.result.value;
    };
    const bodyContains = (text) =>
      evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
    const click = (text) =>
      evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(${JSON.stringify(text)})); if (!button || button.disabled) return false; button.click(); return true; })()`);
    const buttonEnabled = (text) =>
      evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(${JSON.stringify(text)})); return Boolean(button && !button.disabled); })()`);

    await waitFor(() => bodyContains("Dashboard"), 10_000, "interfaz principal");
    await click("Dashboard");
    await waitFor(() => bodyContains("Servicios de Dotty"), 5_000, "dashboard");

    if (await waitFor(() => buttonEnabled("Apagar"), 10_000, "boton de apagado").catch(() => false)) {
      await click("Apagar");
      await waitFor(() => bodyContains("Dotty apagado"), 30_000, "apagado desde Electron");
    }
    await waitFor(() => buttonEnabled("Encender"), 30_000, "boton de encendido");
    if (!(await click("Encender"))) throw new Error("No se pudo pulsar Encender.");
    await waitFor(() => bodyContains("Dotty operativo"), 120_000, "encendido desde Electron");

    await click("Sesiones");
    await waitFor(() => bodyContains("Transcripción"), 10_000, "lector de sesiones");
    await click("Herramientas");
    await waitFor(() => bodyContains("Reparación y mantenimiento"), 10_000, "herramientas de recuperacion");
    await click("Procesamiento");
    await waitFor(() => bodyContains("Procesamiento en curso"), 10_000, "estado de procesamiento");

    console.log("Electron smoke test: OK");
  } finally {
    debuggerClient?.socket.close();
    if (application.exitCode === null && application.signalCode === null) {
      const exited = new Promise((resolvePromise) => application.once("exit", resolvePromise));
      application.kill();
      await Promise.race([
        exited,
        new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
      ]);
    }
    await removeTestProfile(testProfile);
  }
}

await main();
process.exit(0);
