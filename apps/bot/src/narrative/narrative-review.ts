import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { writeFileAtomically } from "../recording/atomic-json-file.ts";
import type { VerificationReport } from "../editorial/draft-verifier.ts";

export const narrativeReviewFileName = "guion.revision.json";

export type NarrativeReviewState = "NEEDS_REVIEW" | "READY_FOR_REVIEW" | "APPROVED";
export type NarrativeSceneReviewStatus = "GENERATED" | "NEEDS_REVIEW" | "APPROVED";

export interface NarrativeSceneReview {
  readonly id: string;
  readonly title: string;
  readonly status: NarrativeSceneReviewStatus;
  readonly auditValid: boolean;
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly evidenceIds: string[];
  readonly approvedAt?: string;
}

export interface NarrativeReviewManifest {
  readonly version: 1;
  readonly sessionId: string;
  readonly sourceHash: string;
  readonly state: NarrativeReviewState;
  readonly reason: string;
  readonly generatedAt: string;
  readonly updatedAt: string;
  readonly verification: {
    readonly valid: boolean;
    readonly errorCount: number;
    readonly warningCount: number;
    readonly checkedAt?: string;
  };
  readonly scenes: NarrativeSceneReview[];
  readonly approval?: {
    readonly approvedAt: string;
    readonly approvedBy: string;
    readonly sourceHash: string;
  };
}

interface SceneArtifact {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly evidence_ids?: unknown;
  readonly evidenceIds?: unknown;
  readonly audit?: {
    readonly valid?: unknown;
    readonly status?: unknown;
    readonly reviewStatus?: unknown;
    readonly issues?: unknown;
  };
}

export function hashNarrative(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function readNarrativeReview(
  exportDirectory: string,
  sessionId?: string,
): Promise<NarrativeReviewManifest | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(join(exportDirectory, narrativeReviewFileName), "utf8"),
    ) as NarrativeReviewManifest;
    if (sessionId !== undefined && parsed.sessionId !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function refreshNarrativeReview(
  exportDirectory: string,
  sessionId: string,
  verificationOverride?: VerificationReport,
): Promise<NarrativeReviewManifest> {
  validateSessionId(sessionId);
  const script = await fs.readFile(join(exportDirectory, "guion.md"), "utf8");
  const sourceHash = hashNarrative(script);
  const verification = verificationOverride ?? await readVerification(exportDirectory);
  const previous = await readNarrativeReview(exportDirectory, sessionId);
  const scenes = await readSceneReviews(exportDirectory);
  const normalizedScenes = scenes.length > 0
    ? scenes
    : [manualSceneReview(verification)];
  const sceneHasErrors = normalizedScenes.some((scene) => scene.status === "NEEDS_REVIEW");
  const verificationErrors = verification.issues.filter((issue) => issue.severity === "error").length;
  const verificationWarnings = verification.issues.filter((issue) => issue.severity === "warning").length;
  const stillApproved = previous?.state === "APPROVED"
    && previous.sourceHash === sourceHash
    && previous.approval?.sourceHash === sourceHash
    && verification.valid
    && verificationErrors === 0
    && !sceneHasErrors;
  const now = new Date().toISOString();
  const state: NarrativeReviewState = stillApproved
    ? "APPROVED"
    : verification.valid && verificationErrors === 0 && !sceneHasErrors
      ? "READY_FOR_REVIEW"
      : "NEEDS_REVIEW";
  const reason = state === "APPROVED"
    ? "APPROVED"
    : verificationErrors > 0 || !verification.valid
      ? "FINAL_VERIFICATION_FAILED"
      : sceneHasErrors
        ? "SCENE_REVIEW_REQUIRED"
        : "AWAITING_APPROVAL";
  const scenesWithApproval = normalizedScenes.map((scene): NarrativeSceneReview => {
    if (stillApproved) {
      return {
        ...scene,
        status: "APPROVED",
        approvedAt: previous?.approval?.approvedAt ?? now,
      };
    }
    if (scene.status === "APPROVED") {
      const { approvedAt: _approvedAt, ...rest } = scene;
      return { ...rest, status: "GENERATED" };
    }
    return scene;
  });
  const manifest: NarrativeReviewManifest = {
    version: 1,
    sessionId,
    sourceHash,
    state,
    reason,
    generatedAt: previous?.generatedAt ?? now,
    updatedAt: now,
    verification: {
      valid: verification.valid,
      errorCount: verificationErrors,
      warningCount: verificationWarnings,
      checkedAt: verification.checkedAt,
    },
    scenes: scenesWithApproval,
    ...(stillApproved && previous?.approval !== undefined ? { approval: previous.approval } : {}),
  };
  await writeNarrativeReview(exportDirectory, manifest);
  return manifest;
}

export async function approveNarrativeReview(
  exportDirectory: string,
  sessionId: string,
  approvedBy = "manual",
): Promise<NarrativeReviewManifest> {
  validateSessionId(sessionId);
  const script = await fs.readFile(join(exportDirectory, "guion.md"), "utf8");
  const sourceHash = hashNarrative(script);
  const current = await readNarrativeReview(exportDirectory, sessionId);
  if (current === null) {
    throw new Error("El guion todavía no tiene un manifiesto de revisión. Verifícalo antes de aprobarlo.");
  }
  if (current.sourceHash !== sourceHash) {
    throw new Error("El guion cambió después de su última verificación. Vuelve a verificarlo antes de aprobarlo.");
  }
  if (!current.verification.valid || current.verification.errorCount > 0) {
    throw new Error("El guion tiene errores de verificación y no puede aprobarse.");
  }
  const pending = current.scenes.filter((scene) => scene.status === "NEEDS_REVIEW");
  if (pending.length > 0) {
    throw new Error(`Hay ${pending.length} escena(s) que requieren revisión antes de aprobar el guion.`);
  }
  const approvedAt = new Date().toISOString();
  const approved: NarrativeReviewManifest = {
    ...current,
    state: "APPROVED",
    reason: "APPROVED",
    updatedAt: approvedAt,
    scenes: current.scenes.map((scene) => ({ ...scene, status: "APPROVED", approvedAt })),
    approval: {
      approvedAt,
      approvedBy: approvedBy.slice(0, 120) || "manual",
      sourceHash,
    },
  };
  await writeNarrativeReview(exportDirectory, approved);
  return approved;
}

export async function assertNarrativeApproved(
  exportDirectory: string,
  sessionId: string,
  script?: string,
): Promise<NarrativeReviewManifest> {
  validateSessionId(sessionId);
  const content = script ?? await fs.readFile(join(exportDirectory, "guion.md"), "utf8");
  const sourceHash = hashNarrative(content);
  const review = await readNarrativeReview(exportDirectory, sessionId);
  if (review === null) {
    throw new Error("El guion no tiene revisión editorial. Verifícalo y apruébalo antes de publicarlo.");
  }
  if (review.state !== "APPROVED" || review.approval === undefined) {
    throw new Error("El guion todavía no está aprobado para publicación.");
  }
  if (review.sourceHash !== sourceHash || review.approval.sourceHash !== sourceHash) {
    throw new Error("El guion cambió después de aprobarse. Debe verificarse y aprobarse nuevamente.");
  }
  if (!review.verification.valid || review.verification.errorCount > 0) {
    throw new Error("La aprobación del guion no es válida porque existen errores editoriales.");
  }
  if (review.scenes.some((scene) => scene.status !== "APPROVED")) {
    throw new Error("Todas las escenas deben estar aprobadas antes de publicar.");
  }
  return review;
}

async function readVerification(exportDirectory: string): Promise<VerificationReport> {
  try {
    return JSON.parse(
      await fs.readFile(join(exportDirectory, "guion.verificacion.json"), "utf8"),
    ) as VerificationReport;
  } catch {
    return {
      valid: false,
      issues: [{
        type: "format",
        severity: "error",
        fragment: "",
        reason: "Falta guion.verificacion.json.",
        evidenceLevel: "unsupported",
        confidence: 1,
      }],
      checkedAt: new Date().toISOString(),
    };
  }
}

async function readSceneReviews(exportDirectory: string): Promise<NarrativeSceneReview[]> {
  const workDirectory = join(exportDirectory, "guion.work");
  const entries = await fs.readdir(workDirectory, { withFileTypes: true }).catch(() => []);
  const paths = entries
    .filter((entry) => entry.isFile() && /^scene_\d+\.json$/u.test(entry.name))
    .map((entry) => join(workDirectory, entry.name))
    .sort();
  const scenes: NarrativeSceneReview[] = [];
  for (const path of paths) {
    try {
      const artifact = JSON.parse(await fs.readFile(path, "utf8")) as SceneArtifact;
      const issues = Array.isArray(artifact.audit?.issues)
        ? artifact.audit.issues as Array<{ severity?: unknown }>
        : [];
      const evidenceIds = Array.isArray(artifact.evidence_ids)
        ? artifact.evidence_ids.filter((value): value is string => typeof value === "string")
        : Array.isArray(artifact.evidenceIds)
          ? artifact.evidenceIds.filter((value): value is string => typeof value === "string")
          : [];
      const auditErrors = issues.filter((issue) => issue.severity === "error").length;
      const missingTraceability = evidenceIds.length === 0 ? 1 : 0;
      const errorCount = auditErrors + missingTraceability;
      const warningCount = issues.filter((issue) => issue.severity === "warning").length;
      const auditValid = artifact.audit?.valid === true
        && artifact.audit?.status !== "NEEDS_REVIEW"
        && artifact.audit?.reviewStatus !== "NEEDS_REVIEW"
        && errorCount === 0;
      scenes.push({
        id: typeof artifact.id === "string" ? artifact.id : `scene_${scenes.length + 1}`,
        title: typeof artifact.title === "string" ? artifact.title : `Escena ${scenes.length + 1}`,
        status: auditValid ? "GENERATED" : "NEEDS_REVIEW",
        auditValid,
        issueCount: issues.length + missingTraceability,
        errorCount,
        warningCount,
        evidenceIds,
      });
    } catch {
      scenes.push({
        id: `scene_${scenes.length + 1}`,
        title: `Escena ${scenes.length + 1}`,
        status: "NEEDS_REVIEW",
        auditValid: false,
        issueCount: 1,
        errorCount: 1,
        warningCount: 0,
        evidenceIds: [],
      });
    }
  }
  return scenes;
}

function manualSceneReview(verification: VerificationReport): NarrativeSceneReview {
  const errorCount = verification.issues.filter((issue) => issue.severity === "error").length;
  const warningCount = verification.issues.filter((issue) => issue.severity === "warning").length;
  const valid = verification.valid && errorCount === 0;
  return {
    id: "manual",
    title: "Guion completo",
    status: valid ? "GENERATED" : "NEEDS_REVIEW",
    auditValid: valid,
    issueCount: verification.issues.length,
    errorCount,
    warningCount,
    evidenceIds: [],
  };
}

async function writeNarrativeReview(
  exportDirectory: string,
  review: NarrativeReviewManifest,
): Promise<void> {
  await writeFileAtomically(
    join(exportDirectory, narrativeReviewFileName),
    `${JSON.stringify(review, null, 2)}\n`,
  );
}

function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error("Sesión inválida.");
}
