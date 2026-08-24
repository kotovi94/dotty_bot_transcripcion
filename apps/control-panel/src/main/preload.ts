import { contextBridge, ipcRenderer } from "electron";

import type {
  DottyDesktopApi,
  EditorialScope,
  DottyState,
  LogKind,
  MaintenanceAction,
  OperationKind,
  SetupBrowseKind,
  SetupConfig,
} from "../shared/contracts.js";

const api: DottyDesktopApi = {
  getState: () => ipcRenderer.invoke("dotty:get-state"),
  getEditorialLearning: (sessionId: string) => ipcRenderer.invoke("dotty:editorial-state", sessionId),
  submitEditorialFeedback: (sessionId: string, comment: string, editedVersion: string) => ipcRenderer.invoke("dotty:editorial-submit", sessionId, comment, editedVersion),
  decideEditorialRule: (ruleId: string, decision: "approve" | "reject" | "deprecate", scope?: EditorialScope) => ipcRenderer.invoke("dotty:editorial-decide", ruleId, decision, scope),
  rollbackEditorialRule: (ruleId: string) => ipcRenderer.invoke("dotty:editorial-rollback", ruleId),
  getSystemStatus: () => ipcRenderer.invoke("dotty:get-system-status"),
  getSessionDetails: (sessionId: string) => ipcRenderer.invoke("dotty:get-session-details", sessionId),
  getSessionProcessingStatus: (sessionId: string) => ipcRenderer.invoke("dotty:get-session-processing-status", sessionId),
  onState: (callback: (state: DottyState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DottyState) => callback(state);
    ipcRenderer.on("dotty:state", listener);
    return () => ipcRenderer.removeListener("dotty:state", listener);
  },
  runOperation: (kind: OperationKind) => ipcRenderer.invoke("dotty:operation", kind),
  disconnect: () => ipcRenderer.invoke("dotty:disconnect"),
  restoreBotIcon: () => ipcRenderer.invoke("dotty:restore-icon"),
  listTranscripts: () => ipcRenderer.invoke("dotty:list-transcripts"),
  readTranscript: (sessionId: string) =>
    ipcRenderer.invoke("dotty:read-transcript", sessionId),
  saveTranscript: (sessionId: string, content: string) =>
    ipcRenderer.invoke("dotty:save-transcript", sessionId, content),
  saveNarrative: (sessionId: string, content: string) =>
    ipcRenderer.invoke("dotty:save-narrative", sessionId, content),
  generateNarrative: (sessionId: string) =>
    ipcRenderer.invoke("dotty:generate-narrative", sessionId),
  publishNarrative: (sessionId: string) =>
    ipcRenderer.invoke("dotty:publish-narrative", sessionId),
  openTranscript: (sessionId: string) =>
    ipcRenderer.invoke("dotty:open-transcript", sessionId),
  openTranscriptFolder: (sessionId: string) =>
    ipcRenderer.invoke("dotty:open-transcript-folder", sessionId),
  openDiscord: (sessionId: string) => ipcRenderer.invoke("dotty:open-discord", sessionId),
  openDataFolder: () => ipcRenderer.invoke("dotty:open-data"),
  readLogs: (kind: LogKind) => ipcRenderer.invoke("dotty:read-logs", kind),
  getMaintenanceState: () => ipcRenderer.invoke("dotty:maintenance-state"),
  runMaintenanceAction: (action: MaintenanceAction, sessionId: string) =>
    ipcRenderer.invoke("dotty:maintenance-action", action, sessionId),
  getSetupStatus: () => ipcRenderer.invoke("dotty:setup-status"),
  browseSetupPath: (kind: SetupBrowseKind) =>
    ipcRenderer.invoke("dotty:setup-browse", kind),
  validateDiscord: (config: SetupConfig) =>
    ipcRenderer.invoke("dotty:setup-validate-discord", config),
  saveSetup: (config: SetupConfig) => ipcRenderer.invoke("dotty:setup-save", config),
  prepareSetup: (config: SetupConfig) =>
    ipcRenderer.invoke("dotty:setup-prepare", config),
  openSetupLink: (kind: "discord" | "node" | "python" | "cuda") =>
    ipcRenderer.invoke("dotty:setup-link", kind),
};

contextBridge.exposeInMainWorld("dotty", api);
