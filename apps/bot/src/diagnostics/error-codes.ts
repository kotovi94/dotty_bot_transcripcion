import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type DottyIssueSeverity = "info" | "warning" | "error" | "critical";

export type DottyIssueName =
  | "TRANSCRIBER_UNAVAILABLE"
  | "JOB_ENQUEUE_REJECTED"
  | "SESSION_DISPATCH_FAILED"
  | "VAD_ANALYSIS_FAILED_FALLBACK"
  | "WHISPER_RUNTIME_FAILURE"
  | "WHISPER_CUDA_FAILURE"
  | "WHISPER_UNINTELLIGIBLE"
  | "SUSPECTED_HALLUCINATION"
  | "LOW_CONFIDENCE_OUTPUT"
  | "STALE_CLAIM_DISCARDED"
  | "VOICE_METRICS_WRITE_FAILED"
  | "TRANSCRIPTION_JOB_FAILED"
  | "TRANSCRIPTION_STATUS_FETCH_FAILED"
  | "TRANSCRIPTION_EXPORT_FAILED"
  | "FINAL_REPORT_WARNING"
  | "FINAL_REPORT_FAILURE"
  | "DIAGNOSTIC_WRITE_FAILED"
  | "UNKNOWN_TRANSCRIPTION_FAILURE";

export interface DottyIssueDefinition {
  readonly code: string;
  readonly name: DottyIssueName;
  readonly category: string;
  readonly severity: DottyIssueSeverity;
  readonly recoverable: boolean;
  readonly description: string;
  readonly suggestedAction: string;
}

interface RawCatalog {
  readonly version: number;
  readonly format: string;
  readonly issues: Readonly<Record<string, Omit<DottyIssueDefinition, "name">>>;
}

const catalogPath = fileURLToPath(
  new URL("../../../../packages/shared/error-codes.json", import.meta.url),
);
const rawCatalog = JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog;

export const DOTTY_ERROR_CATALOG_VERSION = rawCatalog.version;
export const DOTTY_ERROR_CODE_FORMAT = rawCatalog.format;

export function dottyIssue(name: DottyIssueName): DottyIssueDefinition {
  const definition = rawCatalog.issues[name];
  if (definition === undefined) {
    throw new Error(`Unknown Dotty diagnostic issue: ${name}`);
  }
  return { name, ...definition };
}

export function formatDottyIssue(name: DottyIssueName): string {
  const issue = dottyIssue(name);
  return `${issue.code} · ${issue.name}`;
}

export function listDottyIssues(): DottyIssueDefinition[] {
  return Object.keys(rawCatalog.issues)
    .sort()
    .map((name) => dottyIssue(name as DottyIssueName));
}
