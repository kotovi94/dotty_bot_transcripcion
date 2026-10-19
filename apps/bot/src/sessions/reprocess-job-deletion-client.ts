import { createHash } from "node:crypto";

export class ReprocessPreparationError extends Error {}

const timeoutMs = 5_000;

// Matches Python's sorted-key, compact JSON for the only supported parameters: {}.
function expectedParametersHash(sessionId: string): string {
  const canonical = JSON.stringify({ operation_type: "reprocess", parameters: {}, session_id: sessionId });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validatePending(value: unknown, sessionId: string, operationId: string, hash: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReprocessPreparationError("Respuesta de preparación inválida; se conserva la intención.");
  }
  const result = value as Record<string, unknown>;
  if (result.operation_id !== operationId || result.session_id !== sessionId ||
    result.operation_type !== "reprocess" || result.parameters_hash !== hash ||
    typeof result.close_id !== "string" || !/^[0-9a-f]{32}$/u.test(result.close_id) ||
    result.status !== "pending_drain" || result.workers_inactive !== null ||
    result.jobs_deleted !== false) {
    throw new ReprocessPreparationError("La identidad o el estado de la operación Python no coincide; se conserva la intención.");
  }
}

export async function prepareReprocessJobDeletion(
  sessionId: string,
  operationId: string,
  baseUrl: string,
  secret: string,
): Promise<void> {
  const hash = expectedParametersHash(sessionId);
  const postUrl = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/job-deletions`, baseUrl);
  const getUrl = new URL(`/v1/job-deletions/${encodeURIComponent(operationId)}`, baseUrl);
  const headers = { authorization: `Bearer ${secret}` };
  const body = JSON.stringify({ operation_id: operationId, operation_type: "reprocess", parameters: {} });

  // A lost POST response can mean a committed operation. GET 404 is also
  // inconclusive while the original POST is still running; retry only the
  // identical idempotent request, at most once.
  for (let attempt = 0; attempt < 2; attempt++) {
    let posted: Response;
    try {
      posted = await fetch(postUrl, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      let lookedUp: Response;
      try {
        lookedUp = await fetch(getUrl, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (lookupError) {
        throw new ReprocessPreparationError("POST y consulta Python inciertos; se conserva la intención.",
          { cause: new AggregateError([error, lookupError]) });
      }
      if (lookedUp.status === 200) {
        const result = await readJson(lookedUp);
        validatePending(result, sessionId, operationId, hash);
        return;
      }
      if (lookedUp.status === 404 && attempt === 0) continue;
      throw new ReprocessPreparationError(
        `No se pudo confirmar la preparación Python (GET HTTP ${lookedUp.status}); se conserva la intención.`,
        { cause: error },
      );
    }
    if (posted.status !== 202) {
      throw new ReprocessPreparationError(
        `Python rechazó la preparación (HTTP ${posted.status}); se conserva la intención.`,
      );
    }
    const result = await readJson(posted);
    validatePending(result, sessionId, operationId, hash);
    return;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch (error) {
    throw new ReprocessPreparationError("No se pudo leer la respuesta Python; se conserva la intención.", { cause: error });
  }
}
