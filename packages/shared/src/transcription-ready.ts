import { createHash } from "node:crypto";

/** Fields exposed by GET /v1/sessions/{session_id} to both publisher and verifier. */
export interface PublicationJob {
  readonly id: string;
  readonly status: string;
  readonly speaker_user_id: string;
  readonly start_offset_ms: number;
  readonly completed_at: string | null;
  readonly result: unknown;
}

export interface VerifiableReadyMarker {
  readonly version: 1;
  readonly session_id: string;
  readonly jobs_digest: string;
  readonly transcript_digest: string;
  readonly published_at: string;
}

export type ParsedReadyMarker =
  | { readonly kind: "verifiable"; readonly marker: VerifiableReadyMarker }
  | { readonly kind: "legacy-unverifiable" }
  | { readonly kind: "invalid" };

export type ReadyVerification = "verified" | "mismatch" | "legacy-unverifiable" | "invalid";

const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const jobTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && utcTimestampPattern.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON: sorted object keys, preserved array order, no non-JSON values. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object") throw new TypeError("Result contains a non-JSON value");
  if (ancestors.has(value)) throw new TypeError("Result contains a cycle");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Result must be a JSON object");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new TypeError("Result contains a sparse array");
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], ancestors)}`,
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function validatedJobs(sessionId: string, jobs: readonly PublicationJob[]): Array<{
  id: string; speaker_user_id: string; start_offset_ms: number;
  completed_at: string; result: unknown;
}> {
  if (!sessionPattern.test(sessionId)) throw new TypeError("Invalid session ID");
  if (!Array.isArray(jobs) || jobs.length === 0) throw new TypeError("At least one job is required");
  const ids = new Set<string>();
  return jobs.map((job) => {
    if (job === null || typeof job !== "object" ||
      typeof job.id !== "string" || !job.id.startsWith(`${sessionId}:`) ||
      !/^[A-Za-z0-9_-]+$/u.test(job.id.slice(sessionId.length + 1)) || ids.has(job.id)) {
      throw new TypeError("Job ID is missing, foreign, or duplicated");
    }
    ids.add(job.id);
    if (job.status !== "completed" || typeof job.speaker_user_id !== "string" ||
      job.speaker_user_id.length === 0 || !Number.isSafeInteger(job.start_offset_ms) ||
      job.start_offset_ms < 0 || typeof job.completed_at !== "string" ||
      !jobTimestampPattern.test(job.completed_at) || Number.isNaN(Date.parse(job.completed_at)) ||
      job.result === null || typeof job.result !== "object" || Array.isArray(job.result) ||
      Object.keys(job.result).length === 0) {
      throw new TypeError("Job lacks a completed result");
    }
    canonicalJson(job.result);
    return { id: job.id, speaker_user_id: job.speaker_user_id,
      start_offset_ms: job.start_offset_ms, completed_at: job.completed_at, result: job.result };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function jobsDigest(sessionId: string, jobs: readonly PublicationJob[]): string {
  const canonical = canonicalJson({ session_id: sessionId, jobs: validatedJobs(sessionId, jobs) });
  return sha256(`dotty-transcription-jobs-v1\n${canonical}`);
}

/** Hashes the exact UTF-8 file bytes; no newline or Unicode normalization. */
export function transcriptDigest(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError("Transcript bytes must be nonempty");
  }
  return sha256(bytes);
}

export function createReadyMarker(
  sessionId: string, jobs: readonly PublicationJob[], transcriptBytes: Uint8Array, publishedAt: string,
): VerifiableReadyMarker {
  if (!isUtcTimestamp(publishedAt)) throw new TypeError("published_at must be an ISO UTC timestamp");
  return {
    version: 1,
    session_id: sessionId,
    jobs_digest: jobsDigest(sessionId, jobs),
    transcript_digest: transcriptDigest(transcriptBytes),
    published_at: publishedAt,
  };
}

/** Fixed field order and one trailing LF are part of the on-disk v1 format. */
export function serializeReadyMarker(marker: VerifiableReadyMarker): string {
  if (parseReadyMarker(JSON.stringify(marker)).kind !== "verifiable") throw new TypeError("Invalid marker");
  return `${JSON.stringify({
    version: marker.version,
    session_id: marker.session_id,
    jobs_digest: marker.jobs_digest,
    transcript_digest: marker.transcript_digest,
    published_at: marker.published_at,
  })}\n`;
}

export function parseReadyMarker(content: string): ParsedReadyMarker {
  if (typeof content !== "string") return { kind: "invalid" };
  const legacy = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (isUtcTimestamp(legacy)) return { kind: "legacy-unverifiable" };
  let value: unknown;
  try { value = JSON.parse(content); } catch { return { kind: "invalid" }; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).sort().join(",") !==
    "jobs_digest,published_at,session_id,transcript_digest,version" ||
    marker.version !== 1 || typeof marker.session_id !== "string" ||
    !sessionPattern.test(marker.session_id) || typeof marker.jobs_digest !== "string" ||
    !digestPattern.test(marker.jobs_digest) || typeof marker.transcript_digest !== "string" ||
    !digestPattern.test(marker.transcript_digest) || !isUtcTimestamp(marker.published_at)) {
    return { kind: "invalid" };
  }
  return { kind: "verifiable", marker: marker as unknown as VerifiableReadyMarker };
}

export function verifyReadyMarker(
  content: string, sessionId: string, jobs: readonly PublicationJob[], transcriptBytes: Uint8Array,
): ReadyVerification {
  const parsed = parseReadyMarker(content);
  if (parsed.kind !== "verifiable") return parsed.kind;
  try {
    if (parsed.marker.session_id !== sessionId ||
      parsed.marker.jobs_digest !== jobsDigest(sessionId, jobs) ||
      parsed.marker.transcript_digest !== transcriptDigest(transcriptBytes)) return "mismatch";
    return "verified";
  } catch {
    return "mismatch";
  }
}
