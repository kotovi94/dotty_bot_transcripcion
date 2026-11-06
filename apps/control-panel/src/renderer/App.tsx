import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CirclePower,
  Cpu,
  Database,
  FileText,
  FolderOpen,
  Gauge,
  HardDrive,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";

import dottyBotImage from "./assets/dotty-bot.png";
import { SessionDetailPanel, type SessionDetailTab } from "./components/SessionDetailPanel";
import { Sidebar, type SidebarPage } from "./components/Sidebar";
import { StatusCard } from "./components/StatusCard";
import { SetupWizard } from "./SetupWizard";
import { deriveLiveProcessingStages, deriveProcessingStages } from "./processing-stages";
import { MaintenanceRequestGate } from "./maintenance-request";
import { maintenanceDisplay } from "./maintenance-display";
import { StateUpdateGate } from "./state-update-gate";

import type {
  DottyState,
  EditorialLearningState,
  EditorialScope,
  LogKind,
  MaintenanceAction,
  MaintenanceState,
  OperationKind,
  SessionDetails,
  SessionProcessingStatus,
  SetupStatus,
  SystemStatus,
  TranscriptDetail,
  TranscriptSummary,
} from "../shared/contracts";

type Page = SidebarPage;

const initialState: DottyState = {
  timestamp: new Date().toISOString(),
  bot: { running: false, connected: false, pid: null, connectedAt: null, status: "unknown", reason: "Esperando la primera comprobación del bot." },
  transcriber: {
    available: false,
    model: null,
    configuredDevice: null,
    activeDevice: null,
    computeType: null,
    queue: { queued: 0, processing: 0, completed: 0, failed: 0 },
    work: null,
  },
  operation: null,
};

const operationLabels: Record<OperationKind, string> = {
  start: "Encendiendo Dotty",
  stop: "Apagando Dotty",
  restart: "Reiniciando Dotty",
  disconnect: "Desconectando Dotty",
};

function StatusDot({ active, warning = false }: { active: boolean; warning?: boolean }) {
  return <span className={`status-dot ${active ? "online" : warning ? "warning" : "offline"}`} />;
}

function formatDate(value: string | null): string {
  if (!value) return "Sin actividad registrada";
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatSessionStatus(value: string | null): string {
  if (!value) return "Sin estado";
  const labels: Record<string, string> = {
    completed: "Completada",
    recording: "Grabando",
    paused: "Pausada",
    finalizing: "Finalizando",
    interrupted: "Interrumpida",
    failed: "Error",
  };
  return labels[value.toLocaleLowerCase("es")] ?? value;
}

function countDiscordMessages(value: string, limit = 1_900): number {
  let messages = 0;
  let currentLength = 0;
  for (const line of value.trim().split("\n")) {
    if (line.length > limit) {
      if (currentLength > 0) messages += 1;
      messages += Math.ceil(line.length / limit);
      currentLength = 0;
      continue;
    }
    if (currentLength > 0 && currentLength + line.length + 1 > limit) {
      messages += 1;
      currentLength = 0;
    }
    currentLength += (currentLength > 0 ? 1 : 0) + line.length;
  }
  return messages + (currentLength > 0 ? 1 : 0);
}

function getNarrativeStatusLabel(state: TranscriptSummary["narrativeState"]) {
  switch (state) {
    case "ready": return "Disponible";
    case "generating": return "Procesando";
    case "queued": return "Pendiente";
    case "failed": return "Error";
    case "missing": return "No disponible";
    default: return "Desconocido";
  }
}

export function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [state, setState] = useState<DottyState>(initialState);
  const [notice, setNotice] = useState("");
  const [transcripts, setTranscripts] = useState<TranscriptSummary[]>([]);
  const [selected, setSelected] = useState<TranscriptDetail | null>(null);
  const [processingError, setProcessingError] = useState(false);
  const [processingSessionId, setProcessingSessionId] = useState<string | null>(null);
  const [processingSession, setProcessingSession] = useState<SessionProcessingStatus | null>(null);
  const [processingControlBusy, setProcessingControlBusy] = useState(false);
  const [recentProcessingSessions, setRecentProcessingSessions] = useState<Array<{ sessionId: string; label: string; status: string }>>([]);
  const [pipelineMode, setPipelineModeState] = useState<"automatic" | "manual" | null>(null);
  const [pipelineModeBusy, setPipelineModeBusy] = useState(false);
  const [autostartEnabled, setAutostartEnabledState] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [readerMode, setReaderMode] = useState<"narrative" | "transcript">("narrative");
  const [narrativeBusy, setNarrativeBusy] = useState<"generate" | "verify" | "approve" | "publish" | null>(null);
  const [rawBusy, setRawBusy] = useState(false);
  const [reviewSceneBusy, setReviewSceneBusy] = useState<string | null>(null);
  const [logKind, setLogKind] = useState<LogKind>("bot");
  const [logs, setLogs] = useState("Cargando actividad...");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [sessionDetails, setSessionDetails] = useState<SessionDetails | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceState>({ checkedAt: "", issues: [] });
  const [maintenanceBusy, setMaintenanceBusy] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<SessionDetailTab>("summary");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("all");
  const [editorialState, setEditorialState] = useState<EditorialLearningState | null>(null);
  const [editorialComment, setEditorialComment] = useState("");
  const [editorialBusy, setEditorialBusy] = useState(false);
  const selectionRequest = useRef(0);
  const selectionEpoch = useRef(new StateUpdateGate());
  const selectedSessionId = useRef<string | null>(null);
  const stateRequest = useRef(new StateUpdateGate());
  const setupRequest = useRef(new StateUpdateGate());
  const systemRequest = useRef(new StateUpdateGate());
  const transcriptRequest = useRef(new StateUpdateGate());
  const detailsRequest = useRef(new StateUpdateGate());
  const editorialRequest = useRef(new StateUpdateGate());
  const logsRequest = useRef(new StateUpdateGate());
  const operationRequest = useRef(new StateUpdateGate());
  const maintenanceRequest = useRef(new MaintenanceRequestGate());
  const maintenanceInFlight = useRef<Promise<void> | null>(null);
  const panelMounted = useRef(false);

  const loadTranscripts = useCallback(async () => {
    const request = transcriptRequest.current.beginRequest();
    const next = await window.dotty.listTranscripts().catch(() => null);
    if (!next) return;
    if (!transcriptRequest.current.isCurrent(request)) return;
    setTranscripts(next);
    if (!selectedSessionId.current && next[0]) {
      selectedSessionId.current = next[0].sessionId;
      selectionEpoch.current.beginRequest();
      const request = ++selectionRequest.current;
      const detail = await window.dotty.readTranscript(next[0].sessionId).catch(() => null);
      if (request !== selectionRequest.current || selectedSessionId.current !== next[0].sessionId) return;
      if (!detail) { selectedSessionId.current = null; return; }
      setSelected(detail);
      const mode = detail.narrativeContent === null ? "transcript" : "narrative";
      setReaderMode(mode);
      setDraft(mode === "narrative" ? detail.narrativeContent ?? "" : detail.content);
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const sessionId = selected?.sessionId;
    const request = editorialRequest.current.beginRequest();
    if (!sessionId) { setEditorialState(null); return; }
    setEditorialState(null);
    void window.dotty.getEditorialLearning(sessionId).then((next) => {
      if (editorialRequest.current.isCurrent(request) && selectedSessionId.current === sessionId) setEditorialState(next);
    }).catch(() => {
      if (editorialRequest.current.isCurrent(request) && selectedSessionId.current === sessionId) setEditorialState(null);
    });
    return () => editorialRequest.current.invalidate();
  }, [selected?.sessionId]);

  const loadMaintenance = useCallback(async (force = false) => {
    if (!panelMounted.current) return;
    if (maintenanceInFlight.current) {
      if (!force) return;
      await maintenanceInFlight.current;
      if (!panelMounted.current) return;
    }
    const request = maintenanceRequest.current.begin();
    const pending = (async () => {
      try {
        const next = await window.dotty.getMaintenanceState();
        if (maintenanceRequest.current.isCurrent(request)) setMaintenance(next);
      } catch {
        if (maintenanceRequest.current.isCurrent(request)) setMaintenance((previous) => ({
          ...previous,
          checkedAt: new Date().toISOString(),
          failureQuery: {
            status: previous.failureQuery?.lastSuccessAt ? "stale" : "unavailable",
            lastSuccessAt: previous.failureQuery?.lastSuccessAt ?? null,
            reason: "network",
            detail: "No se pudo actualizar el estado de incidencias del panel.",
            action: "Comprueba el panel y el transcriptor; la consulta se reintentará automáticamente.",
          },
        }));
      }
    })();
    maintenanceInFlight.current = pending;
    try { await pending; }
    finally { if (maintenanceInFlight.current === pending) maintenanceInFlight.current = null; }
  }, []);

  useEffect(() => {
    panelMounted.current = true;
    const request = stateRequest.current.beginRequest();
    void window.dotty.getState().then((next) => { if (stateRequest.current.isCurrent(request)) setState(next); }).catch(() => undefined);
    const setupGeneration = setupRequest.current.beginRequest();
    void window.dotty.getSetupStatus().then((next) => {
      if (setupRequest.current.isCurrent(setupGeneration)) setSetupStatus(next);
    }).catch(() => undefined);
    let systemInFlight = false;
    let systemPending = false;
    let active = true;
    let currentInstanceId: string | null = null;
    const refreshSystem = () => {
      if (systemInFlight) { systemPending = true; return; }
      systemInFlight = true;
      const systemGeneration = systemRequest.current.beginRequest();
      void window.dotty.getSystemStatus().then((next) => {
        if (systemRequest.current.isCurrent(systemGeneration) && (next.bot.instanceId ?? null) === currentInstanceId) setSystemStatus(next);
      }).catch(() => undefined).finally(() => {
        systemInFlight = false;
        if (systemPending && active) { systemPending = false; refreshSystem(); }
      });
    };
    refreshSystem();
    void loadMaintenance(true);
    const unsubscribe = window.dotty.onState((next) => {
      stateRequest.current.acceptEvent();
      setState(next);
      const instanceId = next.bot.instanceId ?? null;
      if (instanceId !== currentInstanceId) {
        currentInstanceId = instanceId;
        systemRequest.current.invalidate();
      }
      refreshSystem();
    });
    return () => { panelMounted.current = false; active = false; unsubscribe(); stateRequest.current.invalidate(); systemRequest.current.invalidate(); setupRequest.current.invalidate(); maintenanceRequest.current.invalidate(); };
  }, [loadMaintenance]);

  useEffect(() => {
    const sessionId = selected?.sessionId;
    const request = detailsRequest.current.beginRequest();
    if (!sessionId) {
      setSessionDetails(null);
      return;
    }
    setSessionDetails((current) => current?.id === sessionId ? current : null);
    void window.dotty.getSessionDetails(sessionId).then((next) => {
      if (detailsRequest.current.isCurrent(request) && selectedSessionId.current === sessionId) setSessionDetails(next);
    }).catch(() => undefined);
    return () => detailsRequest.current.invalidate();
  }, [selected?.sessionId]);

  useEffect(() => {
    let initialInFlight = false;
    const retryLoad = async () => {
      if (initialInFlight) return;
      initialInFlight = true;
      try { await loadTranscripts(); }
      finally { initialInFlight = false; }
    };
    void retryLoad();
    const retry = window.setInterval(() => {
      if (!selectedSessionId.current) void retryLoad();
    }, 3_000);
    return () => {
      window.clearInterval(retry);
      transcriptRequest.current.invalidate();
      selectionEpoch.current.invalidate();
      selectionRequest.current += 1;
      detailsRequest.current.invalidate();
      editorialRequest.current.invalidate();
      logsRequest.current.invalidate();
      operationRequest.current.invalidate();
    };
  }, [loadTranscripts]);

  useEffect(() => {
    if (page !== "sessions") return;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await loadTranscripts(); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [page, loadTranscripts]);

  useEffect(() => {
    if (page !== "dashboard") return;
    void loadMaintenance();
  }, [page, loadMaintenance]);

  useEffect(() => {
    if (page !== "tools") return;
    void loadMaintenance();
    const timer = window.setInterval(() => void loadMaintenance(), 3_000);
    return () => window.clearInterval(timer);
  }, [page, loadMaintenance]);

  useEffect(() => {
    if (page !== "dashboard" && page !== "tools" && page !== "sessions") return;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const request = logsRequest.current.beginRequest();
      try {
        const next = await window.dotty.readLogs(logKind);
        if (logsRequest.current.isCurrent(request)) setLogs(next);
      } catch { /* El siguiente sondeo reintentará la lectura. */ }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => { window.clearInterval(timer); logsRequest.current.invalidate(); };
  }, [page, logKind]);

  useEffect(() => {
    if (!selected?.sessionId || (page !== "sessions" && page !== "dashboard" && narrativeBusy === null)) return;
    let active = true;
    let inFlight = false;
    let sawRawRegeneration = false;
    const refreshProcessing = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const processing = await window.dotty.getSessionProcessingStatus(selected.sessionId);
        if (!active) return;
        if (page !== "processing") setProcessingError(false);
        const rawStage = processing.stages.find((stage) => stage.id === "transcription");
        const regenerating = rawStage?.details.startsWith("Rehaciendo raw") ?? false;
        if (regenerating) sawRawRegeneration = true;
        setSelected((current) => current?.sessionId === selected.sessionId
          ? { ...current, processing }
          : current);
        setSessionDetails((current) => current?.id === selected.sessionId
          ? { ...current, processing }
          : current);
        if (sawRawRegeneration && !regenerating) {
          sawRawRegeneration = false;
          const request = ++selectionRequest.current;
          const refreshed = await window.dotty.readTranscript(selected.sessionId).catch(() => null);
          if (active && refreshed && request === selectionRequest.current && selectedSessionId.current === selected.sessionId) {
            setSelected((current) => current?.sessionId === selected.sessionId ? refreshed : current);
            setNotice("Raw actualizado. Revisa la nueva transcripción y regenera el guion si corresponde.");
          }
        }
      } catch { if (active && page !== "processing") setProcessingError(true); }
      finally { inFlight = false; }
    };
    void refreshProcessing();
    const timer = window.setInterval(() => void refreshProcessing(), narrativeBusy ? 2_000 : page === "dashboard" ? 10_000 : 8_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page, narrativeBusy, selected?.sessionId]);

  const focusedProcessingId = processingSessionId ?? state.transcriber.work?.session_id ??
    recentProcessingSessions.find((entry) => ["recording", "paused", "finalizing"].includes(entry.status))?.sessionId ??
    selected?.sessionId ?? recentProcessingSessions[0]?.sessionId ?? null;
  const focusedSessionIsActive = state.transcriber.work?.session_id === focusedProcessingId ||
    recentProcessingSessions.some((entry) => entry.sessionId === focusedProcessingId && ["recording", "paused", "finalizing"].includes(entry.status));
  useEffect(() => {
    if (page === "processing" && processingSessionId === null && state.transcriber.work?.session_id) {
      setProcessingSessionId(state.transcriber.work.session_id);
    }
  }, [page, processingSessionId, state.transcriber.work?.session_id]);
  useEffect(() => {
    if (page !== "processing") return;
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [recent, mode, autostart] = await Promise.all([
          window.dotty.getRecentProcessingSessions(), window.dotty.getPipelineMode(),
          window.dotty.getAutostartEnabled().catch(() => null),
        ]);
        if (active) { setRecentProcessingSessions(recent); setPipelineModeState(mode.mode); setAutostartEnabledState(autostart); }
        if (focusedProcessingId) {
          const processing = await window.dotty.getSessionProcessingStatus(focusedProcessingId);
          if (active) { setProcessingSession(processing); setProcessingError(false); }
        }
      } catch { if (active) setProcessingError(true); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), focusedSessionIsActive ? 3_000 : 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page, focusedProcessingId, focusedSessionIsActive]);

  const runOperation = async (kind: Exclude<OperationKind, "disconnect">) => {
    if (state.operation) return;
    if ((kind === "stop" || kind === "restart") && (working || state.bot.connected) && !window.confirm("Hay una sesión o servicio activo. ¿Quieres continuar?")) return;
    const request = operationRequest.current.beginRequest();
    try {
      const result = await window.dotty.runOperation(kind);
      if (operationRequest.current.isCurrent(request)) setNotice(result.message);
    } catch {
      if (operationRequest.current.isCurrent(request)) setNotice("No se pudo solicitar la operación.");
    }
  };

  const setProcessingPaused = async (paused: boolean) => {
    if (processingControlBusy) return;
    setProcessingControlBusy(true);
    try {
      const result = await window.dotty.setProcessingPaused(paused);
      setState((current) => ({ ...current, transcriber: { ...current.transcriber, processingPaused: result.paused } }));
      setNotice(paused
        ? result.activeWork ? "Pausa solicitada. El fragmento activo terminará antes de detener la cola." : "Cola pausada. Los trabajos pendientes se conservan."
        : "Cola reanudada. Los trabajos pendientes continuarán automáticamente.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo cambiar la pausa del transcriptor.");
    } finally { setProcessingControlBusy(false); }
  };

  const setAutomaticNarrative = async (automatic: boolean) => {
    if (pipelineModeBusy) return;
    setPipelineModeBusy(true);
    try {
      const result = await window.dotty.setPipelineMode(automatic ? "automatic" : "manual");
      setPipelineModeState(result.mode);
      setNotice(automatic
        ? "Modo automático activado para las sesiones que se cierren desde ahora. El guion quedará pendiente de aprobación."
        : "Modo manual activado. Los guiones existentes y el raw se conservan.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo cambiar el modo del guion.");
    } finally { setPipelineModeBusy(false); }
  };

  const setWindowsAutostart = async (enabled: boolean) => {
    if (autostartBusy) return;
    setAutostartBusy(true);
    try {
      const result = await window.dotty.setAutostartEnabled(enabled);
      setAutostartEnabledState(result);
      setNotice(result ? "Dotty se iniciará al entrar en Windows." : "Inicio automático de Windows desactivado.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo cambiar el inicio de Windows.");
    } finally { setAutostartBusy(false); }
  };

  const disconnect = async () => {
    if (state.operation || !window.confirm("Esto detendrá completamente los servicios de Dotty y limpiará sus PID y locks. ¿Continuar?")) return;
    const request = operationRequest.current.beginRequest();
    try {
      const result = await window.dotty.disconnect();
      if (operationRequest.current.isCurrent(request)) setNotice(result.message);
    } catch {
      if (operationRequest.current.isCurrent(request)) setNotice("No se pudo solicitar la desconexión.");
    }
  };

  const restoreBotIcon = async () => {
    const result = await window.dotty.restoreBotIcon();
    setNotice(result.message);
  };

  const selectTranscript = async (summary: TranscriptSummary) => {
    setProcessingError(false);
    selectedSessionId.current = summary.sessionId;
    selectionEpoch.current.beginRequest();
    const request = ++selectionRequest.current;
    detailsRequest.current.invalidate();
    editorialRequest.current.invalidate();
    setSelected((current) => current?.sessionId === summary.sessionId ? current : null);
    setSessionDetails((current) => current?.id === summary.sessionId ? current : null);
    setEditorialState(null);
    const detail = await window.dotty.readTranscript(summary.sessionId).catch(() => null);
    if (request !== selectionRequest.current || selectedSessionId.current !== summary.sessionId) return;
    if (!detail) { setNotice("No se pudo cargar la sesión. Inténtalo de nuevo."); return; }
    setSelected(detail);
    const mode = detail.narrativeContent === null ? "transcript" : "narrative";
    setReaderMode(mode);
    setDraft(mode === "narrative" ? detail.narrativeContent ?? "" : detail.content);
    setEditing(false);
    setDetailTab("summary");
    setSpeakerFilter("all");
    setTranscriptSearch("");
  };

  const refreshSelected = async (sessionId: string, selection: number): Promise<TranscriptDetail | null> => {
    if (!selectionEpoch.current.isCurrent(selection) || selectedSessionId.current !== sessionId) return null;
    const request = ++selectionRequest.current;
    const detail = await window.dotty.readTranscript(sessionId);
    if (request !== selectionRequest.current || !selectionEpoch.current.isCurrent(selection) || selectedSessionId.current !== sessionId) return null;
    setSelected(detail);
    const detailsGeneration = detailsRequest.current.beginRequest();
    void window.dotty.getSessionDetails(sessionId).then((next) => {
      if (detailsRequest.current.isCurrent(detailsGeneration) && selectedSessionId.current === sessionId) setSessionDetails(next);
    }).catch(() => undefined);
    return detail;
  };

  const saveCurrentDocument = async () => {
    if (!selected) return;
    const selection = selectionEpoch.current.snapshot();
    const result = readerMode === "narrative"
      ? await window.dotty.saveNarrative(selected.sessionId, draft)
      : await window.dotty.saveTranscript(selected.sessionId, draft);
    if (result.saved) {
      const refreshed = await refreshSelected(selected.sessionId, selection);
      if (!refreshed) return;
      setDraft(readerMode === "narrative" ? refreshed.narrativeContent ?? "" : refreshed.content);
      setEditing(false);
      const backupNotice = result.backupName ? ` Respaldo: ${result.backupName}` : "";
      const warningNotice = result.warning ? ` ${result.warning}` : "";
      setNotice(`${readerMode === "narrative" ? "Guion" : "Transcripción"} guardado.${backupNotice}${warningNotice}`);
      void loadTranscripts();
    }
  };

  const saveEditorialLearning = async () => {
    if (!selected || editorialBusy) return;
    const selection = selectionEpoch.current.snapshot();
    const editedVersion = editing ? draft : selected.narrativeContent ?? draft;
    const originalVersion = selected.narrativeContent ?? "";
    if (editorialComment.trim() === "" && editedVersion.trim() === originalVersion.trim()) {
      setNotice("Primero modifica el guion o escribe una instrucción para que Dotty tenga algo que aprender.");
      return;
    }
    setEditorialBusy(true);
    try {
      if (editing) await window.dotty.saveNarrative(selected.sessionId, editedVersion);
      const result = await window.dotty.submitEditorialFeedback(selected.sessionId, editorialComment, editedVersion);
      const editorialRequestId = editorialRequest.current.beginRequest();
      const nextEditorial = await window.dotty.getEditorialLearning(selected.sessionId);
      if (editorialRequest.current.isCurrent(editorialRequestId) && selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setEditorialState(nextEditorial);
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) {
        setEditorialComment("");
        setSelected((current) => current?.sessionId === selected.sessionId ? { ...current, narrativeContent: editedVersion, updatedAt: new Date().toISOString() } : current);
        setEditing(false);
        setNotice(`Aprendizaje guardado: ${result.candidates.length} propuesta(s) pendientes de aprobación.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(message.includes("No hay correcciones ni instrucciones")
        ? "Primero modifica el guion o escribe una instrucción para que Dotty tenga algo que aprender."
        : "No se pudo guardar el aprendizaje. El guion no fue dañado.");
    } finally {
      setEditorialBusy(false);
    }
  };

  const decideEditorialRule = async (ruleId: string, decision: "approve" | "reject" | "deprecate", scope?: EditorialScope) => {
    if (!selected || editorialBusy) return;
    const selection = selectionEpoch.current.snapshot();
    setEditorialBusy(true);
    try {
      await window.dotty.decideEditorialRule(ruleId, decision, scope);
      const request = editorialRequest.current.beginRequest();
      const next = await window.dotty.getEditorialLearning(selected.sessionId);
      if (editorialRequest.current.isCurrent(request) && selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) {
        setEditorialState(next);
        setNotice(decision === "approve" ? "Regla editorial aprobada." : "Propuesta descartada.");
      }
    } finally {
      setEditorialBusy(false);
    }
  };

  const rollbackEditorialRule = async (ruleId: string) => {
    if (!selected || editorialBusy) return;
    const selection = selectionEpoch.current.snapshot();
    setEditorialBusy(true);
    try {
      await window.dotty.rollbackEditorialRule(ruleId);
      const request = editorialRequest.current.beginRequest();
      const next = await window.dotty.getEditorialLearning(selected.sessionId);
      if (editorialRequest.current.isCurrent(request) && selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) {
        setEditorialState(next);
        setNotice("Regla editorial restaurada a su versión anterior.");
      }
    } finally {
      setEditorialBusy(false);
    }
  };

  const switchReaderMode = (mode: "narrative" | "transcript") => {
    if (!selected || editing || (mode === "narrative" && selected.narrativeContent === null)) return;
    setReaderMode(mode);
    setDraft(mode === "narrative" ? selected.narrativeContent ?? "" : selected.content);
  };

  const generateNarrative = async () => {
    if (!selected || narrativeBusy !== null) return;
    const selection = selectionEpoch.current.snapshot();
    if (selected.narrativeContent !== null && !window.confirm(
      "Ya existe un guion guardado. Regenerarlo puede reemplazarlo (se conservará un respaldo). ¿Continuar?",
    )) return;
    setNarrativeBusy("generate");
    setNotice("Dotty está generando el guion localmente. Puede tardar varios minutos.");
    try {
      const result = await window.dotty.generateNarrative(selected.sessionId);
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(result.message);
      const detail = await refreshSelected(selected.sessionId, selection);
      if (detail && result.ok && detail.narrativeContent !== null) {
        setReaderMode("narrative");
        setDraft(detail.narrativeContent);
      }
      await loadTranscripts();
    } finally {
      setNarrativeBusy(null);
    }
  };

  const regenerateRaw = async () => {
    if (!selected || rawBusy || narrativeBusy !== null) return;
    const selection = selectionEpoch.current.snapshot();
    setRawBusy(true);
    try {
      const result = await window.dotty.regenerateRaw(selected.sessionId);
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(result.message);
      await refreshSelected(selected.sessionId, selection);
      await loadTranscripts();
    } catch (error) {
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(error instanceof Error ? error.message : "No se pudo rehacer el raw.");
    } finally {
      setRawBusy(false);
    }
  };

  const verifyNarrative = async () => {
    if (!selected || narrativeBusy !== null) return;
    const selection = selectionEpoch.current.snapshot();
    setNarrativeBusy("verify");
    try {
      const result = await window.dotty.verifyNarrative(selected.sessionId);
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(result.message);
      await refreshSelected(selected.sessionId, selection);
      await loadTranscripts();
    } finally {
      setNarrativeBusy(null);
    }
  };

  const approveNarrativeScene = async (sceneId: string) => {
    if (!selected || narrativeBusy !== null || reviewSceneBusy !== null) return;
    const selection = selectionEpoch.current.snapshot();
    setReviewSceneBusy(sceneId);
    try {
      const result = await window.dotty.approveNarrativeScene(selected.sessionId, sceneId);
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(result.message);
      await refreshSelected(selected.sessionId, selection);
      await loadTranscripts();
    } finally {
      setReviewSceneBusy(null);
    }
  };

  const approveNarrative = async () => {
    if (!selected || narrativeBusy !== null) return;
    const selection = selectionEpoch.current.snapshot();
    setNarrativeBusy("approve");
    try {
      const result = await window.dotty.approveNarrative(selected.sessionId);
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(result.message);
      await refreshSelected(selected.sessionId, selection);
      await loadTranscripts();
    } finally {
      setNarrativeBusy(null);
    }
  };

  const publishNarrative = async () => {
    if (!selected || narrativeBusy !== null) return;
    const selection = selectionEpoch.current.snapshot();
    setNarrativeBusy("publish");
    try {
      if (selected.narrativeContent === null) {
        setNotice("No hay un guion guardado. Genera o pega el guion y guárdalo antes de publicar.");
        return;
      }
      if (selected.narrativeReview?.state !== "APPROVED") {
        setNotice("El guion debe completar la revisión y aprobación antes de publicarse.");
        return;
      }

      const messageCount = countDiscordMessages(selected.narrativeContent);
      const publicationAction = selected.canOpenDiscord
        ? "actualizará la publicación existente"
        : "creará una publicación nueva";
      if (!window.confirm(
        `Discord ${publicationAction} con ${messageCount} ${messageCount === 1 ? "mensaje" : "mensajes"}. ¿Publicar ahora?`,
      )) return;

      const result = await window.dotty.publishNarrative(selected.sessionId);
      if (selectionEpoch.current.isCurrent(selection) && selectedSessionId.current === selected.sessionId) setNotice(result.message);
      await refreshSelected(selected.sessionId, selection);
      await loadTranscripts();
    } finally {
      setNarrativeBusy(null);
    }
  };

  const runMaintenance = async (action: MaintenanceAction, sessionId: string) => {
    setMaintenanceBusy(`${action}:${sessionId}`);
    try {
      const result = await window.dotty.runMaintenanceAction(action, sessionId);
      setNotice(result.message);
      await loadMaintenance(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo completar la recuperación.");
    } finally {
      setMaintenanceBusy(null);
    }
  };

  const statusOptions = useMemo(() => Array.from(new Set(transcripts.map((entry) => entry.status).filter((value): value is string => Boolean(value)))).sort(), [transcripts]);

  const filteredTranscripts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es");
    return transcripts.filter((entry) => {
      const matchesSearch = !normalized || `${entry.title} ${entry.sessionId}`.toLocaleLowerCase("es").includes(normalized);
      const matchesStatus = statusFilter === "all" || entry.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [query, statusFilter, transcripts]);

  const speakers = useMemo(() => {
    if (!selected) return [];
    const sectionStart = selected.content.search(/^##\s+Transcripci[oó]n\s*$/imu);
    const section = sectionStart >= 0 ? selected.content.slice(sectionStart) : selected.content;
    const matches = Array.from(section.matchAll(/^\[\d{1,2}:\d{2}:\d{2}\]\s+\*\*(.+?):\*\*/gmu));
    return Array.from(new Set(matches.map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value)))).sort((left, right) => left.localeCompare(right, "es"));
  }, [selected]);

  const fullyReady = state.bot.connected && state.transcriber.available;
  const systemOperational = fullyReady && systemStatus?.ollama.available === true;
  const partiallyReady = state.bot.running || state.transcriber.available;
  const working = state.transcriber.work;
  const progress = Math.round(Math.max(0, Math.min(1, working?.session_progress ?? working?.progress ?? 0)) * 100);
  const lastSession = transcripts[0] ?? null;
  const systemControlStatus = state.operation
    ? state.operation.kind === "restart" ? "REINICIANDO" : state.operation.kind === "disconnect" || state.operation.kind === "stop" ? "DETENIENDO" : "INICIANDO"
    : systemOperational ? "OPERATIVO" : state.bot.status === "unknown" ? "DESCONOCIDO" : partiallyReady ? "ERROR" : "APAGADO";

  const processingStages = useMemo(() => deriveProcessingStages(selected, transcripts, state), [selected, transcripts, state]);
  const dashboardStage = processingStages.find((stage) => ["ERROR", "BLOQUEADO", "PROCESANDO"].includes(stage.status));
  const dashboardHeadline = dashboardStage ? `${dashboardStage.label}: ${dashboardStage.details}`
    : selected ? `${processingStages.filter((stage) => stage.status === "COMPLETADO").length} de ${processingStages.length} etapas completadas`
      : "Sin sesión seleccionada";
  const focusedStages = focusedProcessingId && processingSession?.sessionId === focusedProcessingId
    ? deriveLiveProcessingStages(processingSession, working)
    : focusedProcessingId === selected?.sessionId ? processingStages : [];
  const completedStages = focusedStages.filter((stage) => stage.status === "COMPLETADO").length;
  const activeStage = focusedStages.find((stage) => stage.status === "PROCESANDO");
  const problemStage = focusedStages.find((stage) => stage.status === "ERROR" || stage.status === "BLOQUEADO");
  const processingHeadline = processingError ? "No se pudo actualizar el estado de esta sesión"
    : problemStage ? `${problemStage.label}: ${problemStage.details}`
      : activeStage ? `${activeStage.label}: ${activeStage.details}`
        : focusedProcessingId ? `${completedStages} de ${focusedStages.length} etapas completadas` : "Selecciona una sesión para ver sus etapas";
  const narrativeProgress = selected?.processing?.narrativeProgress ?? selected?.narrativeProgress ?? 0;
  const narrativePhase = selected?.processing?.narrativePhase ?? selected?.narrativePhase ?? "Sin generar";
  const publicationStage = selected?.processing?.stages.find((stage) => stage.id === "publication");
  const failureQuery = maintenance.failureQuery;
  const failureDisplay = maintenanceDisplay(maintenance);
  const failuresCurrent = failureQuery?.status === "current";
  const incidentsConfirmed = failureDisplay.confirmed;
  const lastFailureUpdate = failureQuery?.lastSuccessAt
    ? new Date(failureQuery.lastSuccessAt).toLocaleString("es-CL") : null;

  if (!setupStatus) return <div className="setup-loading">Cargando configuración de Dotty...</div>;
  if (!setupStatus.configured) return <SetupWizard status={setupStatus} onComplete={(next) => { setupRequest.current.invalidate(); setSetupStatus(next); setPage("dashboard"); }} />;

  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        onPageChange={setPage}
        transcriptCount={transcripts.length}
        issueCount={maintenance.issues.length}
        state={state}
        fullyReady={fullyReady}
        partiallyReady={partiallyReady}
        onOpenData={() => void window.dotty.openDataFolder()}
      />

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">DOTTY DESKTOP</span>
            <h1>{page === "dashboard" ? "Dashboard" : page === "sessions" ? "Sesiones" : page === "processing" ? "Procesamiento" : page === "tools" ? "Herramientas" : "Configuración"}</h1>
          </div>
          <div className="topbar-state">
            <StatusDot active={fullyReady} warning={partiallyReady && !fullyReady} />
            <span>{state.operation ? operationLabels[state.operation.kind] : fullyReady ? "Todos los sistemas operativos" : state.bot.status === "unknown" ? "Estado del bot desconocido" : partiallyReady ? "Servicios iniciando" : "Servicios detenidos"}</span>
          </div>
        </header>

        {notice && <div className="notice"><Check size={17} /><span>{notice}</span><button aria-label="Cerrar aviso" onClick={() => setNotice("")}><X size={14} /></button></div>}
        {narrativeBusy && selected && <div className="operation-progress" role="status">
          <div className="work-title"><strong>{narrativeBusy === "generate" ? `Generando guion · ${narrativePhase}` : narrativeBusy === "publish" ? publicationStage?.details ?? "Publicando en Discord" : narrativeBusy === "verify" ? "Verificando el guion" : "Aprobando el guion"}</strong><span>{narrativeBusy === "generate" ? `${Math.round(narrativeProgress * 100)}%` : narrativeBusy === "publish" && publicationStage?.total ? `${publicationStage.current ?? 0}/${publicationStage.total}` : "En curso"}</span></div>
          <div className={`progress-track ${narrativeBusy !== "generate" && !(narrativeBusy === "publish" && publicationStage?.progress !== undefined) ? "indeterminate" : ""}`}><div style={{ width: `${Math.round((narrativeBusy === "generate" ? narrativeProgress : publicationStage?.progress ?? 0) * 100)}%` }} /></div>
        </div>}

        {page === "dashboard" && (
          <section className="page-content dashboard-page">
            <div className="service-grid compact-grid">
              <StatusCard icon={<Bot size={22} />} title="DOTTY BOT" value={{ stopped: "Detenido", starting: "Iniciando", active: "Proceso activo", connected: "Discord conectado", disconnected: "Discord desconectado", reconnecting: "Reconectando", error: "Error", unknown: "Estado desconocido" }[state.bot.status ?? "unknown"]} detail={state.bot.reason ?? (state.bot.connectedAt ? `Conectado desde ${formatDate(state.bot.connectedAt)}` : "Sin conexión activa")} tone={state.bot.connected ? "good" : state.bot.running ? "warn" : "muted"} />
              <StatusCard icon={<Cpu size={22} />} title="TRANSCRIPTOR" value={state.transcriber.available ? "Disponible" : "No disponible"} detail={state.transcriber.model ?? (state.transcriber.available ? "Modelo cargado" : "Sin comprobación disponible")} tone={state.transcriber.available ? "good" : "muted"} />
              <StatusCard icon={<Gauge size={22} />} title="OLLAMA" value={systemStatus?.ollama.available ? "Disponible" : "No disponible"} detail={systemStatus?.ollama.error ?? systemStatus?.ollama.modelConfigured ?? "Sin modelo actual"} tone={systemStatus?.ollama.available ? "good" : "muted"} />
              <StatusCard icon={<Database size={22} />} title="ÚLTIMA SESIÓN" value={lastSession?.title ?? "Sin sesiones"} detail={lastSession ? `${lastSession.campaignName ?? "Campaña sin nombre"} · Sesión ${lastSession.sequenceNumber ?? "sin número"} · ${formatSessionStatus(lastSession.status)}` : "No disponible"} tone={lastSession ? "good" : "muted"} />
            </div>

            <div className="overview-grid dashboard-grid">
              <article className="panel compact-panel">
                <div className="panel-heading"><div><span className="eyebrow">PROCESAMIENTO · {selected?.title ?? "SIN SESIÓN"}</span><h3>{dashboardHeadline}</h3></div><Activity size={18} /></div>
                <div className="stage-list">
                  {processingStages.map((stage) => (
                    <div key={stage.label} className="stage-row">
                      <span>{stage.label}</span>
                      <strong className={`badge ${stage.status.toLowerCase()}`}>{stage.status}</strong>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel compact-panel">
                <div className="panel-heading"><div><span className="eyebrow">ERRORES</span><h3>Último problema</h3></div><AlertTriangle size={18} /></div>
                {maintenance.issues[0] ? (
                  <div className="error-stack">
                    <strong>{maintenance.issues[0].title}</strong>
                    <span>{maintenance.issues[0].status} · {maintenance.issues[0].failedJobs} fallidos</span>
                    {maintenance.issues[0].lastError && <small>{maintenance.issues[0].lastError}</small>}
                  </div>
                ) : !incidentsConfirmed ? (
                  <div className="error-stack">
                    <strong>Estado de incidencias desconocido</strong>
                    <small>{maintenance.localScanAvailable === false ? "No se pudieron revisar las sesiones locales." : failureQuery?.detail ?? "Aún no hay una consulta válida de incidencias."}</small>
                    {lastFailureUpdate && <small>Última actualización correcta: {lastFailureUpdate}.</small>}
                  </div>
                ) : selected?.narrativeError ? (
                  <div className="error-stack">
                    <strong>Guion</strong>
                    <small>{selected.narrativeError}</small>
                  </div>
                ) : (
                  <div className="empty-inline"><ShieldCheck size={26} /><div><strong>Sin errores recientes</strong><span>No hay fallos detectados en el flujo actual.</span></div></div>
                )}
              </article>
            </div>

            <article className="panel compact-panel system-control-panel">
              <div className="panel-heading">
                <div><span className="eyebrow">CONTROL DEL SISTEMA</span><h3>Servicios de Dotty</h3></div>
                <strong className={`system-control-state ${systemControlStatus.toLowerCase()}`}>{systemControlStatus}</strong>
              </div>
              <div className="system-control-actions">
                {!systemOperational && <button className="primary" disabled={state.operation !== null} onClick={() => void runOperation("start")}><Play size={16} /> {state.operation?.kind === "start" ? "Iniciando..." : "Encender Dotty"}</button>}
                <button disabled={state.operation !== null} onClick={() => void runOperation("restart")}><RotateCcw size={16} /> {state.operation?.kind === "restart" ? "Reiniciando..." : "Reiniciar Dotty"}</button>
                <button className="danger-ghost" disabled={state.operation !== null || (!state.bot.running && !state.transcriber.available)} onClick={() => void runOperation("stop")}><Square size={16} /> {state.operation?.kind === "stop" ? "Deteniendo..." : "Detener Dotty"}</button>
                <button className="danger-ghost" disabled={state.operation !== null} onClick={() => void disconnect()}><CirclePower size={16} /> {state.operation?.kind === "disconnect" ? "Desconectando..." : "Desconectar completamente"}</button>
              </div>
              <div className="system-control-secondary">
                <button disabled={state.operation !== null} onClick={() => void restoreBotIcon()}><Bot size={16} /> Restaurar icono del bot</button>
              </div>
            </article>

            <article className="panel compact-panel session-summary-panel">
              <div className="panel-heading"><div><span className="eyebrow">ÚLTIMA SESIÓN REAL</span><h3>{lastSession ? lastSession.title : "Sin sesión registrada"}</h3></div><ChevronRight size={18} /></div>
              {lastSession ? (
                <div className="mini-grid">
                  <div><span>Campaña</span><strong>{lastSession.campaignName ?? "Sin campaña"}</strong></div>
                  <div><span>Sesión</span><strong>{lastSession.sequenceNumber ?? "Sin número"}</strong></div>
                  <div><span>Estado</span><strong>{formatSessionStatus(lastSession.status)}</strong></div>
                  <div><span>Guion</span><strong>{getNarrativeStatusLabel(lastSession.narrativeState)}</strong></div>
                </div>
              ) : (
                <div className="empty-inline"><FileText size={26} /><div><strong>No hay sesiones disponibles</strong><span>La próxima exportación aparecerá aquí.</span></div></div>
              )}
            </article>
          </section>
        )}

        {page === "sessions" && (
          <section className="page-content transcript-page">
            <div className="transcript-sidebar panel">
              <div className="transcript-tools session-tools">
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar sesión o campaña..." />
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="all">Todos</option>
                  {statusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </div>
              <div className="transcript-list">
                {filteredTranscripts.map((entry) => (
                  <button key={entry.sessionId} className={selected?.sessionId === entry.sessionId ? "selected" : ""} onClick={() => void selectTranscript(entry)}>
                    <FileText size={18} />
                    <span>
                      <strong>{entry.title}</strong>
                      <small>{entry.sequenceNumber !== null && entry.sequenceNumber !== undefined ? `Sesión ${entry.sequenceNumber}` : entry.sessionId} · {formatDate(entry.endedAt ?? entry.startedAt ?? entry.updatedAt)}</small>
                      <small>{entry.status ?? "Sin estado"} · {getNarrativeStatusLabel(entry.narrativeState)}</small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
                {!filteredTranscripts.length && <div className="empty-list">No hay sesiones que coincidan con el filtro actual.</div>}
              </div>
            </div>

            <div className="reader-panel panel">
              <SessionDetailPanel
                selected={selected}
                sessionDetails={sessionDetails}
                detailTab={detailTab}
                onSelectTab={setDetailTab}
                readerMode={readerMode}
                editing={editing}
                draft={draft}
                setDraft={setDraft}
                setEditing={setEditing}
                narrativeBusy={narrativeBusy}
                rawBusy={rawBusy}
                editorialState={editorialState}
                editorialComment={editorialComment}
                setEditorialComment={setEditorialComment}
                editorialBusy={editorialBusy}
                onSaveEditorialLearning={() => void saveEditorialLearning()}
                onDecideEditorialRule={(ruleId, decision, scope) => void decideEditorialRule(ruleId, decision, scope)}
                onRollbackEditorialRule={(ruleId) => void rollbackEditorialRule(ruleId)}
                onGenerateNarrative={() => void generateNarrative()}
                onRegenerateRaw={() => void regenerateRaw()}
                onVerifyNarrative={() => void verifyNarrative()}
                onApproveNarrative={() => void approveNarrative()}
                onApproveNarrativeScene={(sceneId) => void approveNarrativeScene(sceneId)}
                onPublishNarrative={() => void publishNarrative()}
                reviewSceneBusy={reviewSceneBusy}
                onSwitchReaderMode={switchReaderMode}
                onSaveCurrentDocument={() => void saveCurrentDocument()}
                onOpenTranscriptFolder={() => void window.dotty.openTranscriptFolder(selected?.sessionId ?? "")}
                onOpenDiscord={() => { if (selected) void window.dotty.openDiscord(selected.sessionId); }}
                onCopyText={() => { if (!selected) return; const textToCopy = detailTab === "narrative" ? selected.narrativeContent ?? selected.content : selected.content; navigator.clipboard.writeText(textToCopy).catch(() => undefined); }}
                transcriptSearch={transcriptSearch}
                speakerFilter={speakerFilter}
                onTranscriptSearchChange={setTranscriptSearch}
                onSpeakerFilterChange={setSpeakerFilter}
                speakers={speakers}
              />
            </div>
          </section>
        )}

        {page === "processing" && (
          <section className="page-content processing-page">
            <div className="panel compact-panel process-summary process-map">
              <div className="panel-heading"><div><span className="eyebrow">PROCESO DE LA SESIÓN</span><h3>{focusedProcessingId === selected?.sessionId ? selected?.title : recentProcessingSessions.find((entry) => entry.sessionId === focusedProcessingId)?.label ?? focusedProcessingId ?? "Selecciona una sesión"}</h3><p>{focusedProcessingId ? `${focusedStages.length} etapas · ${focusedProcessingId}` : "Elige una sesión para consultar su estado real."}</p></div><Activity size={18} /></div>
              <div className="process-controls">
                <label htmlFor="processing-session">Sesión que se muestra</label>
                <select id="processing-session" value={focusedProcessingId ?? ""} onChange={(event) => { setProcessingSessionId(event.target.value); setProcessingSession(null); setProcessingError(false); }}>
                  {!focusedProcessingId && <option value="">Selecciona una sesión</option>}
                  {focusedProcessingId && !recentProcessingSessions.some((entry) => entry.sessionId === focusedProcessingId) && !transcripts.some((entry) => entry.sessionId === focusedProcessingId) && <option value={focusedProcessingId}>{working?.session_label ?? focusedProcessingId}</option>}
                  {recentProcessingSessions.map((entry) => <option key={entry.sessionId} value={entry.sessionId}>{entry.label}</option>)}
                  {transcripts.filter((entry) => !recentProcessingSessions.some((recent) => recent.sessionId === entry.sessionId)).map((entry) => <option key={entry.sessionId} value={entry.sessionId}>{entry.title} · {formatSessionStatus(entry.status)}</option>)}
                </select>
              </div>
              <div className="process-controls-row">
                {focusedProcessingId && transcripts.some((entry) => entry.sessionId === focusedProcessingId) && <button onClick={() => {
                  const summary = transcripts.find((entry) => entry.sessionId === focusedProcessingId);
                  if (summary) void selectTranscript(summary);
                  setPage("sessions");
                }}>Abrir raw y guion</button>}
                {maintenance.issues.some((issue) => issue.sessionId === focusedProcessingId) && <button onClick={() => setPage("tools")}>Ver recuperación manual</button>}
              </div>
              {working && focusedProcessingId !== working.session_id && <div className="process-context" role="status">
                <strong>Transcripción activa en otra sesión</strong>
                <span>{working.session_label ?? working.session_id}. Las etapas visibles pertenecen a la sesión elegida.</span>
                <button onClick={() => { setProcessingSessionId(working.session_id ?? null); setProcessingSession(null); }}>Ver sesión activa</button>
              </div>}
              {processingError && <div className="error-stack" role="status"><strong>Estado sin actualizar</strong><span>La consulta falló. Se reintentará automáticamente; los datos visibles pueden estar desactualizados.</span></div>}
              {focusedProcessingId && <p className="process-headline" role="status">{processingHeadline}</p>}
              {focusedStages.length > 0 && <div className="process-overall">
                <div className="work-title"><strong>Avance de la sesión</strong><span>{completedStages} de {focusedStages.length} etapas completadas</span></div>
                <div className="progress-track" role="progressbar" aria-label="Etapas completadas" aria-valuenow={completedStages} aria-valuemin={0} aria-valuemax={focusedStages.length}><div style={{ width: `${completedStages / focusedStages.length * 100}%` }} /></div>
                {processingSession?.sessionId === focusedProcessingId && processingSession.state === "generating_narrative" && <>
                  <div className="work-title"><strong>Guion · {processingSession.narrativePhase ?? "Generando"}</strong><span>{Math.round((processingSession.narrativeProgress ?? 0) * 100)}%</span></div>
                  <div className="progress-track" role="progressbar" aria-label="Generación del guion" aria-valuenow={Math.round((processingSession.narrativeProgress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${(processingSession.narrativeProgress ?? 0) * 100}%` }} /></div>
                </>}
              </div>}
              {focusedStages.length > 0 && <div className="process-stage-grid">
                {focusedStages.map((stage, index) => (
                  <article key={stage.id} className={`process-stage-card ${stage.status.toLowerCase()}`}>
                    <div className="process-stage-index">{String(index + 1).padStart(2, "0")}</div>
                    <div className="process-stage-copy"><strong>{stage.label}</strong><span>{stage.details}</span>{(stage.status === "COMPLETADO" || stage.status === "PROCESANDO") && <div className={`process-stage-track ${stage.status === "PROCESANDO" && stage.progress === undefined ? "indeterminate" : ""}`} role="progressbar" aria-label={stage.label} aria-valuenow={stage.status === "COMPLETADO" ? 100 : stage.progress === undefined ? undefined : Math.round(stage.progress * 100)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: stage.status === "COMPLETADO" ? "100%" : `${Math.round(Math.max(0, Math.min(1, stage.progress ?? 0)) * 100)}%` }} /></div>}{stage.artifact && <code>{stage.artifact}</code>}</div>
                    <div className="process-stage-state"><strong className={`badge ${stage.status.toLowerCase()}`}>{stage.status}</strong>{stage.total !== undefined && stage.total > 0 && <small>{stage.current ?? 0}/{stage.total}</small>}{(stage.errors > 0 || stage.warnings > 0) && <small>{stage.errors > 0 ? `${stage.errors} errores` : ""}{stage.errors > 0 && stage.warnings > 0 ? " · " : ""}{stage.warnings > 0 ? `${stage.warnings} avisos` : ""}</small>}</div>
                  </article>
                ))}
              </div>}
            </div>

            <div className="panel compact-panel process-summary">
              <div className="panel-heading"><div><span className="eyebrow">TRABAJO ACTIVO</span><h3>Transcripción actual</h3></div><CirclePower size={18} /></div>
              <p>Bot: {state.bot.status === "unknown" ? "estado desconocido" : state.bot.connected ? "conectado a Discord" : state.bot.running ? "sin conexión a Discord" : "detenido"} · Transcriptor: {state.transcriber.available ? "disponible" : "no disponible"}</p>
              <p>Cola: {state.transcriber.queue.queued} pendientes · {state.transcriber.queue.processing} procesando · {state.transcriber.queue.failed} fallidos</p>
              <p>Cola de transcripción: {state.transcriber.processingPaused === true ? "pausada" : state.transcriber.processingPaused === false ? "activa" : "estado de pausa desconocido"}</p>
              <p>Guion tras cerrar el raw: {pipelineMode === "automatic" ? "generación automática para nuevas sesiones" : pipelineMode === "manual" ? "inicio manual" : "consultando modo"}</p>
              <div className="process-controls-row">
                {pipelineMode === "automatic"
                  ? <button disabled={pipelineModeBusy} onClick={() => void setAutomaticNarrative(false)}>Usar modo manual</button>
                  : <button disabled={pipelineModeBusy || pipelineMode === null} onClick={() => void setAutomaticNarrative(true)}>Activar guion automático</button>}
              </div>
              <p>Al abrir la aplicación, Dotty se inicia automáticamente si está apagada.</p>
              <p>Inicio con Windows (opcional): {autostartEnabled === true ? "activado" : autostartEnabled === false ? "desactivado" : "estado desconocido"}</p>
              <div className="process-controls-row">
                <button disabled={autostartBusy || autostartEnabled === null} onClick={() => void setWindowsAutostart(autostartEnabled !== true)}>
                  {autostartEnabled === true ? "Desactivar inicio con Windows" : "Activar inicio con Windows"}
                </button>
              </div>
              <div className="process-controls-row">
                {state.transcriber.processingPaused === true
                  ? <button disabled={processingControlBusy || !state.transcriber.available} onClick={() => void setProcessingPaused(false)}><Play size={15} /> Reanudar cola</button>
                  : <button disabled={processingControlBusy || !state.transcriber.available || state.transcriber.processingPaused === undefined} onClick={() => void setProcessingPaused(true)}><Square size={15} /> Pausar tras el fragmento actual</button>}
              </div>
              {working ? (
                <>
                  <div className="work-title"><strong>{working.session_label ?? "Transcribiendo audio"}</strong><span>{progress}%</span></div>
                  <div className="progress-track"><div style={{ width: `${Math.max(progress, 2)}%` }} /></div>
                  <p>{working.session_completed_jobs ?? 0} de {working.session_total_jobs ?? 0} fragmentos · {working.session_failed_jobs ?? 0} fallidos.</p>
                </>
              ) : (
                <div className="empty-inline"><CirclePower size={30} /><div><strong>Sin tarea activa</strong><span>No hay transcripción en curso en este momento.</span></div></div>
              )}
            </div>
          </section>
        )}

        {page === "tools" && (
          <section className="page-content tools-page">
            <div className="tools-grid">
              <article className="panel compact-panel">
                <div className="panel-heading"><div><span className="eyebrow">ACCIONES</span><h3>Herramientas operativas</h3></div><Wrench size={18} /></div>
                <div className="tool-actions">
                  <button onClick={() => void window.dotty.openDataFolder()}><FolderOpen size={17} /> Abrir carpeta de datos</button>
                  {selected && <button onClick={() => void window.dotty.openTranscriptFolder(selected.sessionId)}><FolderOpen size={17} /> Abrir carpeta de sesión</button>}
                  {selected?.canOpenDiscord && <button onClick={() => void window.dotty.openDiscord(selected.sessionId)}><Terminal size={17} /> Abrir Discord</button>}
                  <button onClick={() => void runOperation("restart")}><RotateCcw size={17} /> Reiniciar Dotty</button>
                </div>
              </article>

              <article className="panel compact-panel">
                <div className="panel-heading"><div><span className="eyebrow">RECUPERACIÓN</span><h3>Reparación y mantenimiento</h3></div><ShieldCheck size={18} /></div>
                {!failuresCurrent && <div className="error-stack" role="status">
                  <strong>{failureDisplay.stale ? "Incidencias desactualizadas" : "Estado de incidencias desconocido"}</strong>
                  <span>{failureQuery?.detail ?? "Aún no se pudieron consultar las incidencias."}</span>
                  {lastFailureUpdate && <small>Última actualización correcta: {lastFailureUpdate}.</small>}
                  {failureQuery?.action && <small>{failureQuery.action}</small>}
                </div>}
                {maintenance.localScanAvailable === false && <div className="error-stack" role="status">
                  <strong>Sesiones locales no disponibles</strong>
                  <span>No se pudieron revisar las grabaciones locales; el estado de incidencias está incompleto.</span>
                  <small>Comprueba el acceso a la carpeta de datos. El panel volverá a consultar automáticamente.</small>
                </div>}
                {failuresCurrent && lastFailureUpdate && <p>Última actualización correcta: {lastFailureUpdate}.</p>}
                {failureDisplay.empty ? (
                  <div className="empty-inline"><ShieldCheck size={28} /><div><strong>Sin incidencias</strong><span>No hay grabaciones ni transcripciones bloqueadas.</span></div></div>
                ) : (
                  maintenance.issues.map((issue) => (
                    <div className="issue-card" key={issue.sessionId}>
                      <div>
                        <strong>{issue.title}</strong>
                        <span>{issue.status} · {issue.chunks} fragmentos</span>
                        {issue.lastError && <small>{issue.lastError}</small>}
                      </div>
                      <div className="issue-actions">
                        {issue.canRetry && <button disabled={maintenanceBusy !== null || !failuresCurrent} onClick={() => void runMaintenance("retry-failed", issue.sessionId)}>Reintentar</button>}
                        {issue.canRecover && <button className="primary" disabled={maintenanceBusy !== null} onClick={() => void runMaintenance("recover-session", issue.sessionId)}>Recuperar y transcribir</button>}
                      </div>
                    </div>
                  ))
                )}
              </article>
            </div>
          </section>
        )}

        {page === "settings" && <section className="page-content settings-page"><SetupWizard embedded status={setupStatus} onComplete={(next) => { setupRequest.current.invalidate(); setSetupStatus(next); setNotice("Configuración actualizada."); }} /></section>}
      </main>
    </div>
  );
}
