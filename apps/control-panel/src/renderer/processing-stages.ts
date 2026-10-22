import type {
  DottyState,
  ProcessingStageStatus,
  TranscriptDetail,
  TranscriptSummary,
  WorkState,
} from "../shared/contracts";

type Session = Pick<TranscriptDetail, "sessionId" | "status" | "content" | "narrativeContent" | "narrativeState" | "canOpenDiscord" | "processing">;
type Summary = Pick<TranscriptSummary, "title" | "narrativeState">;

export interface DisplayStage {
  id: string;
  label: string;
  status: string;
  details: string;
  progress: number | undefined;
  current: number | undefined;
  total: number | undefined;
  errors: number;
  warnings: number;
  artifact: string | undefined;
}

function stageStatusLabel(status: ProcessingStageStatus): string {
  if (status === "completed") return "COMPLETADO";
  if (status === "running") return "PROCESANDO";
  if (status === "pending") return "PENDIENTE";
  if (status === "warning") return "AVISO";
  if (status === "blocked") return "BLOQUEADO";
  if (status === "error") return "ERROR";
  return "DESCONOCIDO";
}

function captureStatus(session: Session | null, status?: ProcessingStageStatus): string {
  if (!session) return "DESCONOCIDO";
  if (session.status === "interrupted") return "AVISO";
  if (session.status === "failed") return "ERROR";
  if (status === "completed" && session.status !== "completed") return "DESCONOCIDO";
  if (status) return stageStatusLabel(status);
  if (session.status === "completed") return "COMPLETADO";
  if (["recording", "paused", "finalizing"].includes(session.status ?? "")) return "PROCESANDO";
  return "DESCONOCIDO";
}

function transcriptionStatus(session: Session | null, work: WorkState | null, status?: ProcessingStageStatus): string {
  const active = work && (!session || work.session_id === session.sessionId);
  if (status === "error") return "ERROR";
  if (active) return "PROCESANDO";
  if (status === "completed") {
    const evidence = session?.processing?.transcriptionEvidence;
    return session?.processing?.sessionId === session?.sessionId && evidence?.availability === "available" && evidence.publication === "verified" &&
      evidence.pendingMutation !== true && evidence.total !== null && evidence.total > 0 &&
      evidence.completed === evidence.total && session?.content.trim() ? "COMPLETADO" : "DESCONOCIDO";
  }
  if (status) return stageStatusLabel(status);
  return session?.content.trim() ? "AVISO" : session ? "PENDIENTE" : "DESCONOCIDO";
}

export function deriveProcessingStages(
  selected: Session | null,
  transcripts: readonly Summary[],
  state: Pick<DottyState, "transcriber">,
): DisplayStage[] {
  const working = state.transcriber.work;
  if (selected && selected.processing?.sessionId === selected.sessionId && selected.processing.stages?.length) {
    return selected.processing.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      status: stage.id === "capture" ? captureStatus(selected, stage.status)
        : stage.id === "transcription" ? transcriptionStatus(selected, working, stage.status)
          : stageStatusLabel(stage.status),
      details: stage.details,
      progress: stage.id === "transcription" && working?.session_id === selected.sessionId
        ? working.session_progress ?? working.progress : stage.progress,
      current: stage.id === "transcription" && working?.session_id === selected.sessionId
        ? working.session_completed_jobs : stage.current,
      total: stage.id === "transcription" && working?.session_id === selected.sessionId
        ? working.session_total_jobs : stage.total,
      errors: stage.errors ?? 0,
      warnings: stage.warnings ?? 0,
      artifact: stage.artifact,
      ...(stage.id === "transcription" && working?.session_id === selected.sessionId && (working.session_total_jobs ?? 0) > 0
        ? { details: `${working.session_completed_jobs ?? 0} de ${working.session_total_jobs} fragmentos · ${working.session_failed_jobs ?? 0} fallidos` }
        : {}),
    }));
  }

  const logStatus = selected && selected.processing?.sessionId === selected.sessionId &&
    selected.processing.transcriptionEvidence?.publication === "verified" ? "COMPLETADO"
    : selected?.content ? "AVISO" : transcripts.some((entry) => Boolean(entry.title)) ? "PENDIENTE" : "DESCONOCIDO";
  const narrativeStatus = selected ? (() => {
    if (selected.narrativeContent) return "COMPLETADO";
    if (selected.narrativeState === "generating") return "PROCESANDO";
    if (selected.narrativeState === "failed") return "ERROR";
    return selected.narrativeState === "queued" ? "PENDIENTE" : "DESCONOCIDO";
  })() : transcripts.some((entry) => entry.narrativeState === "ready") ? "COMPLETADO" : "PENDIENTE";
  const publicationStatus = selected?.canOpenDiscord ? "COMPLETADO" : selected?.narrativeContent ? "PENDIENTE" : "DESCONOCIDO";

  return [
    { id: "capture", label: "Grabación", status: captureStatus(selected), details: "Estado general", progress: undefined, current: undefined, total: undefined, errors: 0, warnings: 0, artifact: undefined },
    { id: "transcription", label: "Transcripción", status: transcriptionStatus(selected, working), details: "Estado general", progress: undefined, current: undefined, total: undefined, errors: 0, warnings: 0, artifact: undefined },
    { id: "raw_quality", label: "Bitácora", status: logStatus, details: "Estado general", progress: undefined, current: undefined, total: undefined, errors: 0, warnings: 0, artifact: undefined },
    { id: "assembly", label: "Narrativa", status: narrativeStatus, details: "Estado general", progress: undefined, current: undefined, total: undefined, errors: 0, warnings: 0, artifact: undefined },
    { id: "publication", label: "Publicación", status: publicationStatus, details: "Estado general", progress: undefined, current: undefined, total: undefined, errors: 0, warnings: 0, artifact: undefined },
  ];
}
