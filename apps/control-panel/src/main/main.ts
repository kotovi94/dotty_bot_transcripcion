import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
} from "electron";

import type { LogKind, MaintenanceAction, OperationKind, SetupBrowseKind, SetupConfig } from "../shared/contracts.js";
import { SetupManager } from "./setup-manager.js";
import { DottySupervisor } from "./supervisor.js";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pollTimer: NodeJS.Timeout | null = null;

const e2eMode = process.env.DOTTY_E2E === "1";
const gotLock = e2eMode || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function findProjectRoot(): string {
  const starts = [
    process.env.DOTTY_PROJECT_ROOT,
    app.isPackaged ? resolve(process.resourcesPath, "project") : undefined,
    process.cwd(),
    app.getAppPath(),
  ].filter(
    (value): value is string => Boolean(value),
  );
  for (const start of starts) {
    let current = resolve(start);
    while (dirname(current) !== current) {
      if (
        existsSync(resolve(current, "tools", "start-dotty.ps1")) &&
        existsSync(resolve(current, "apps", "bot", "package.json"))
      ) {
        return current;
      }
      current = dirname(current);
    }
  }
  throw new Error("No se pudo localizar la carpeta principal de Dotty.");
}

const projectRoot = findProjectRoot();
const supervisor = new DottySupervisor(projectRoot);
const setupManager = new SetupManager(projectRoot);
const dottyIconPath = resolve(
  app.getAppPath(),
  "resources",
  "dotty-icon.png",
);

function createFallbackIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
      <rect width="32" height="32" rx="9" fill="#6d5efc"/>
      <path d="M8 8h8.2c5.1 0 8.8 3.1 8.8 8s-3.7 8-8.8 8H8V8zm6 5v6h2.2c1.8 0 2.8-1.1 2.8-3s-1-3-2.8-3H14z" fill="white"/>
    </svg>`;
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
}

function createDottyIcon(size: number) {
  const image = nativeImage.createFromPath(dottyIconPath);
  const source = image.isEmpty() ? createFallbackIcon() : image;
  return source.resize({ width: size, height: size, quality: "best" });
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: "#0b0d12",
    title: "Dotty",
    icon: createDottyIcon(64),
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(resolve(__dirname, "../../renderer/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray(): void {
  tray = new Tray(createDottyIcon(32));
  tray.setToolTip("Dotty - Panel de control");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Dotty", click: showWindow },
      { type: "separator" },
      { label: "Encender", click: () => void supervisor.runOperation("start") },
      { label: "Reiniciar", click: () => void supervisor.runOperation("restart") },
      { label: "Apagar", click: () => void supervisor.runOperation("stop") },
      { type: "separator" },
      {
        label: "Salir del panel",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", showWindow);
}

function registerIpc(): void {
  ipcMain.handle("dotty:get-state", () => supervisor.getState());
  ipcMain.handle("dotty:get-system-status", () => supervisor.getSystemStatus());
  ipcMain.handle("dotty:get-session-details", (_event, sessionId: string) =>
    supervisor.getSessionDetails(String(sessionId)),
  );
  ipcMain.handle("dotty:get-session-processing-status", (_event, sessionId: string) =>
    supervisor.getSessionProcessingStatus(String(sessionId)),
  );
  ipcMain.handle("dotty:operation", (_event, kind: OperationKind) => {
    if (!["start", "stop", "restart"].includes(kind)) {
      throw new Error("Operacion no permitida.");
    }
    return supervisor.runOperation(kind);
  });
  ipcMain.handle("dotty:disconnect", () => supervisor.disconnect());
  ipcMain.handle("dotty:restore-icon", () => supervisor.restoreBotIcon());
  ipcMain.handle("dotty:list-transcripts", () => supervisor.listTranscripts());
  ipcMain.handle("dotty:read-transcript", (_event, sessionId: string) =>
    supervisor.readTranscript(String(sessionId)),
  );
  ipcMain.handle(
    "dotty:save-transcript",
    (_event, sessionId: string, content: string) =>
      supervisor.saveTranscript(String(sessionId), String(content)),
  );
  ipcMain.handle(
    "dotty:save-narrative",
    (_event, sessionId: string, content: string) =>
      supervisor.saveNarrative(String(sessionId), String(content)),
  );
  ipcMain.handle("dotty:generate-narrative", (_event, sessionId: string) =>
    supervisor.generateNarrative(String(sessionId)),
  );
  ipcMain.handle("dotty:publish-narrative", (_event, sessionId: string) =>
    supervisor.publishNarrative(String(sessionId)),
  );
  ipcMain.handle("dotty:open-transcript", (_event, sessionId: string) =>
    supervisor.openTranscript(String(sessionId)),
  );
  ipcMain.handle("dotty:open-transcript-folder", (_event, sessionId: string) =>
    supervisor.openTranscriptFolder(String(sessionId)),
  );
  ipcMain.handle("dotty:open-discord", (_event, sessionId: string) =>
    supervisor.openDiscord(String(sessionId)),
  );
  ipcMain.handle("dotty:open-data", () => supervisor.openDataFolder());
  ipcMain.handle("dotty:read-logs", (_event, kind: LogKind) => {
    if (!["bot", "transcriber", "lifecycle", "panel"].includes(kind)) {
      throw new Error("Registro no permitido.");
    }
    return supervisor.readLogs(kind);
  });
  ipcMain.handle("dotty:maintenance-state", () => supervisor.getMaintenanceState());
  ipcMain.handle(
    "dotty:maintenance-action",
    (_event, action: MaintenanceAction, sessionId: string) => {
      if (!["recover-session", "retry-failed"].includes(action)) {
        throw new Error("Acción de mantenimiento no permitida.");
      }
      return supervisor.runMaintenanceAction(action, String(sessionId));
    },
  );
  ipcMain.handle("dotty:setup-status", () => setupManager.getStatus());
  ipcMain.handle("dotty:setup-browse", async (_event, kind: SetupBrowseKind) => {
    if (!['python', 'npm', 'data'].includes(kind)) throw new Error("Selector no permitido.");
    const options: Electron.OpenDialogOptions = {
      title: kind === "data" ? "Elige dónde guardar los datos de Dotty" : `Localiza ${kind === "python" ? "Python" : "npm"}`,
      properties: kind === "data" ? ["openDirectory", "createDirectory"] : ["openFile"],
    };
    if (kind !== "data") options.filters = [{ name: "Ejecutable", extensions: ["exe", "cmd", "bat"] }];
    const result = await dialog.showOpenDialog(mainWindow!, options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("dotty:setup-validate-discord", (_event, config: SetupConfig) =>
    setupManager.validateDiscord(config),
  );
  ipcMain.handle("dotty:setup-save", async (_event, config: SetupConfig) => {
    const result = await setupManager.save(config);
    if (result.ok) supervisor.reloadConfiguration();
    return result;
  });
  ipcMain.handle("dotty:setup-prepare", (_event, config: SetupConfig) =>
    setupManager.prepare(config),
  );
  ipcMain.handle("dotty:setup-link", (_event, kind: "discord" | "node" | "python" | "cuda") =>
    setupManager.openLink(kind),
  );
}

async function broadcastState(): Promise<void> {
  const state = await supervisor.getState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("dotty:state", state);
  }
}

if (gotLock) {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    if (pollTimer) clearInterval(pollTimer);
  });
  app.on("window-all-closed", () => {
    // El supervisor permanece disponible en la bandeja de Windows.
  });

  void app.whenReady().then(async () => {
    app.setName("Dotty");
    app.setAppUserModelId("com.dotty.control-panel");
    await supervisor.initialize();
    registerIpc();
    createWindow();
    createTray();
    pollTimer = setInterval(() => void broadcastState(), 1_000);
    await broadcastState();
  });
}
