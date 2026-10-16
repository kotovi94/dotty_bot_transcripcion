import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../../..");
const electronPath = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const entryPath = join(projectRoot, "apps", "control-panel", "dist", "main", "main", "main.js");
const screenshotPath = resolve(process.argv[2] ?? join(projectRoot, "data", "panel-review-smoke.png"));
const debuggingPort = 14_000 + Math.floor(Math.random() * 1_000);

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check().catch(() => false);
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
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
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("error", reject);
    socket.addEventListener("open", () => resolvePromise({
      socket,
      call(method, params = {}) {
        const id = ++sequence;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveCall, rejectCall) => pending.set(id, { resolve: resolveCall, reject: rejectCall }));
      },
    }));
  });
}

const profile = await mkdtemp(join(tmpdir(), "dotty-review-panel-"));
const application = spawn(electronPath, [
  `--remote-debugging-port=${debuggingPort}`,
  `--user-data-dir=${profile}`,
  entryPath,
], {
  cwd: projectRoot,
  env: { ...process.env, DOTTY_E2E: "1" },
  windowsHide: true,
  stdio: "ignore",
});

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
    if (response.exceptionDetails) throw new Error("La interfaz produjo una excepción.");
    return response.result.value;
  };
  const contains = (text) => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
  const click = (text) => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes(${JSON.stringify(text)})); if (!button) return false; button.click(); return true; })()`);

  await waitFor(() => contains("Dashboard"), 10_000, "interfaz principal");
  if (!(await click("Sesiones"))) throw new Error("No se encontró la navegación de sesiones.");
  await waitFor(() => contains("Transcripción"), 15_000, "detalle de la sesión");
  if (!(await click("Guion"))) throw new Error("No se encontró la pestaña de guion.");
  await waitFor(() => contains("REVISIÓN DEL GUION"), 15_000, "panel de revisión");

  const snapshot = await evaluate(`(() => {
    const buttonState = (label) => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim().includes(label));
      return button ? { found: true, disabled: button.disabled } : { found: false, disabled: null };
    };
    const pending = [...document.querySelectorAll('.scene-review-item.needs_review')];
    const firstPending = pending[0];
    if (firstPending) firstPending.open = true;
    const structuralBlocked = pending.filter((item) => item.querySelector('.scene-blockers'));
    const blockedOverrideAction = structuralBlocked.some((item) => item.querySelector('.review-scene-button'));
    const editorialPending = pending.find((item) => !item.querySelector('.scene-blockers'));
    const manualReviewAction = editorialPending
      ? [...editorialPending.querySelectorAll('button')].some((button) => button.textContent.includes('Aceptar revisión editorial'))
      : false;
    return {
      text: document.body.innerText,
      verify: buttonState('Verificar'),
      approve: buttonState('Aprobar'),
      publish: buttonState('Publicar'),
      pendingScenes: document.querySelectorAll('.scene-review-item.needs_review').length,
      sceneCount: document.querySelectorAll('.scene-review-item').length,
      structuralBlocked: structuralBlocked.length,
      blockedOverrideAction,
      editorialReviewAvailable: Boolean(editorialPending),
      manualReviewAction,
    };
  })()`);
  if (!snapshot.verify.found || snapshot.verify.disabled) throw new Error("Verificar no está disponible.");
  if (!snapshot.approve.found || !snapshot.approve.disabled) throw new Error("Aprobar debería estar bloqueado mientras hay escenas pendientes.");
  if (!snapshot.publish.found || !snapshot.publish.disabled) throw new Error("Publicar debería estar bloqueado hasta la aprobación.");
  if (snapshot.sceneCount === 0 || snapshot.pendingScenes === 0) throw new Error("No se cargó la revisión por escenas.");
  if (snapshot.structuralBlocked === 0) throw new Error("No se mostraron los bloqueos estructurales.");
  if (snapshot.blockedOverrideAction) throw new Error("Una escena estructuralmente inválida permite aprobación manual.");
  if (snapshot.editorialReviewAvailable && !snapshot.manualReviewAction) throw new Error("Falta la acción para incidencias editoriales revisables.");

  const capture = await debuggerClient.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(capture.data, "base64"));
  console.log(JSON.stringify({ ok: true, screenshotPath, sceneCount: snapshot.sceneCount, pendingScenes: snapshot.pendingScenes }));
} finally {
  debuggerClient?.socket.close();
  if (application.exitCode === null && application.signalCode === null) application.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
