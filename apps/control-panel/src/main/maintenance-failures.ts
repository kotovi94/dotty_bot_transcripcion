import type { MaintenanceState } from "../shared/contracts.js";

export interface FailedSession {
  sessionId: string;
  failedJobs: number;
  lastError: string | null;
}

export function parseFailures(payload: unknown): FailedSession[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !Array.isArray((payload as { sessions?: unknown }).sessions)) {
    throw new SyntaxError("La respuesta de incidencias no contiene una lista de sesiones.");
  }
  const seen = new Set<string>();
  return (payload as { sessions: unknown[] }).sessions.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SyntaxError("La respuesta contiene una sesión inválida.");
    }
    const item = value as Record<string, unknown>;
    if (typeof item.session_id !== "string" || !item.session_id || seen.has(item.session_id) ||
        !Number.isSafeInteger(item.failed_jobs) || (item.failed_jobs as number) <= 0 ||
        (item.last_error !== null && item.last_error !== undefined && typeof item.last_error !== "string")) {
      throw new SyntaxError("La respuesta contiene datos de incidencia inválidos.");
    }
    seen.add(item.session_id);
    return { sessionId: item.session_id, failedJobs: item.failed_jobs as number,
      lastError: typeof item.last_error === "string" ? item.last_error : null };
  });
}

function failureReason(error: unknown): Pick<NonNullable<MaintenanceState["failureQuery"]>, "reason" | "detail" | "action"> {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "TimeoutError" || name === "AbortError") return {
    reason: "timeout", detail: "La consulta a Python superó el tiempo permitido (10 s).",
    action: "Comprueba si el transcriptor está ocupado; el panel volverá a consultar automáticamente.",
  };
  if (name === "SyntaxError") return {
    reason: "invalid", detail: "Python devolvió JSON inválido o una estructura inesperada.",
    action: "Revisa el registro del transcriptor; el panel volverá a consultar automáticamente.",
  };
  const http = /HTTP (\d{3})\b/u.exec(message);
  if (http) return {
    reason: "http", detail: `Python respondió HTTP ${http[1]}.`,
    action: "Revisa el registro del transcriptor y su configuración; el panel volverá a consultar automáticamente.",
  };
  return {
    reason: "network", detail: "No se pudo conectar con el servicio Python.",
    action: "Comprueba que el transcriptor esté disponible; el panel volverá a consultar automáticamente.",
  };
}

export class FailureTracker {
  private lastSuccess: { at: string; sessions: FailedSession[] } | null = null;
  private latestRequest = 0;
  private state: NonNullable<MaintenanceState["failureQuery"]> = {
    status: "unavailable", lastSuccessAt: null, reason: null, detail: null, action: null,
  };

  async query(request: () => Promise<unknown>): Promise<{ sessions: FailedSession[]; query: NonNullable<MaintenanceState["failureQuery"]> }> {
    const sequence = ++this.latestRequest;
    try {
      const sessions = parseFailures(await request());
      if (sequence === this.latestRequest) {
        const at = new Date().toISOString();
        this.lastSuccess = { at, sessions };
        this.state = { status: "current", lastSuccessAt: at, reason: null, detail: null, action: null };
      }
    } catch (error) {
      if (sequence === this.latestRequest) {
        this.state = { status: this.lastSuccess ? "stale" : "unavailable",
          lastSuccessAt: this.lastSuccess?.at ?? null, ...failureReason(error) };
      }
    }
    return { sessions: this.lastSuccess?.sessions ?? [], query: { ...this.state } };
  }
}
