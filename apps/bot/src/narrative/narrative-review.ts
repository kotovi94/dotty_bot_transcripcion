import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { writeFileAtomically } from "../recording/atomic-json-file.ts";
import type { VerificationReport } from "../editorial/draft-verifier.ts";

export const narrativeReviewFileName = "guion.revision.json";

export type NarrativeReviewState = "NEEDS_REVIEW" | "READY_FOR_REVIEW" | "APPROVED";
export type NarrativeSceneReviewStatus = "GENERATED" | "NEEDS_REVIEW" | "APPROVED";
export type NarrativeSceneBlockerCode =
  | "EMPTY_SCENE"
  | "INVALID_SCENE_HEADER"
  | "MODEL_META_CONTAMINATION"
  | "MISSING_TRACEABILITY";

export interface NarrativeSceneBlocker {
  readonly code: NarrativeSceneBlockerCode;
  readonly message: string;
}

export interface NarrativeSceneReview {
  readonly id: string;
  readonly title: string;
  readonly status: NarrativeSceneReviewStatus;
  readonly auditValid: boolean;
  readonly issueCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly evidenceIds: string[];
  readonly blockers: NarrativeSceneBlocker[];
  readonly approvedAt?: string;
  readonly approvedBy?: string;
}

export interface NarrativeReviewManifest {
  readonly version: 1;
  readonly sessionId: string;
  readonly sourceHash: string;
  readonly state: NarrativeReviewState;
  readonly reason: string;
  readonly generatedAt: string;
  readonly updatedAt: string;
  readonly mode?: "generated" | "manual";
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
  readonly text?: unknown;
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
  const generatedScript = await fs.readFile(join(exportDirectory, "guion.generado.md"), "utf8").catch(() => null);
  const mode: "generated" | "manual" = generatedScript !== null && hashNarrative(generatedScript) === sourceHash
    ? "generated"
    : "manual";
  const scenes = mode === "generated" ? await readSceneReviews(exportDirectory) : [];
  const normalizedScenes = scenes.length > 0 ? scenes : [manualSceneReview(verification)];
  const verificationErrors = verification.issues.filter((issue) => issue.severity === "error").length;
  const verificationWarnings = verification.issues.filter((issue) => issue.severity === "warning").length;
  // A repeated automatic verification must not erase a human decision for the
  // same script. Final verification still gates the overall approval below;
  // this only preserves scene-level review work.
  const canPreserveSceneApprovals = previous?.sourceHash === sourceHash;
  const scenesWithPreservedApproval = normalizedScenes.map((scene): NarrativeSceneReview => {
    const previousScene = canPreserveSceneApprovals
      ? previous?.scenes.find((candidate) => candidate.id === scene.id)
      : undefined;
    if (
      previousScene?.status !== "APPROVED"
      || scene.blockers.some(isHardBlocker)
    ) return scene;
    return {
      ...scene,
      status: "APPROVED",
      ...(previousScene.approvedAt !== undefined ? { approvedAt: previousScene.approvedAt } : {}),
      ...(previousScene.approvedBy !== undefined ? { approvedBy: previousScene.approvedBy } : {}),
    };
  });
  const sceneHasErrors = scenesWithPreservedApproval.some((scene) => scene.status === "NEEDS_REVIEW");
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
  const scenesWithApproval = scenesWithPreservedApproval.map((scene): NarrativeSceneReview => {
    if (stillApproved) {
      return {
        ...scene,
        status: "APPROVED",
        approvedAt: previous?.approval?.approvedAt ?? now,
        approvedBy: previous?.approval?.approvedBy ?? "manual",
      };
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
    mode,
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
  const structural = current.mode === "manual" ? [] : await readSceneReviews(exportDirectory);
  const blocked = structural.filter((scene) => scene.blockers.some(isHardBlocker));
  if (blocked.length > 0) {
    throw new Error(`Hay ${blocked.length} escena(s) con bloqueos estructurales que deben regenerarse o corregirse.`);
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
    scenes: current.scenes.map((scene) => ({
      ...scene,
      status: "APPROVED",
      approvedAt,
      approvedBy: approvedBy.slice(0, 120) || "manual",
    })),
    approval: {
      approvedAt,
      approvedBy: approvedBy.slice(0, 120) || "manual",
      sourceHash,
    },
  };
  await writeNarrativeReview(exportDirectory, approved);
  return approved;
}

export async function approveNarrativeScene(
  exportDirectory: string,
  sessionId: string,
  sceneId: string,
  approvedBy = "manual",
): Promise<NarrativeReviewManifest> {
  validateSessionId(sessionId);
  if (!/^scene_\d+$/u.test(sceneId) && sceneId !== "manual") {
    throw new Error("La escena indicada no es válida.");
  }
  const script = await fs.readFile(join(exportDirectory, "guion.md"), "utf8");
  const sourceHash = hashNarrative(script);
  const current = await readNarrativeReview(exportDirectory, sessionId);
  if (current === null) {
    throw new Error("El guion todavía no tiene un manifiesto de revisión. Verifícalo antes de revisar escenas.");
  }
  if (current.sourceHash !== sourceHash) {
    throw new Error("El guion cambió después de su última verificación. Vuelve a verificarlo antes de revisar escenas.");
  }
  if (!current.scenes.some((scene) => scene.id === sceneId)) {
    throw new Error("La escena indicada no pertenece a este guion.");
  }
  const structuralScene = current.mode === "manual"
    ? undefined
    : (await readSceneReviews(exportDirectory)).find((scene) => scene.id === sceneId);
  const hardBlockers = structuralScene?.blockers.filter(isHardBlocker) ?? [];
  if (hardBlockers.length > 0) {
    const codes = hardBlockers.map((blocker) => blocker.code).join(", ");
    throw new Error(`La escena tiene bloqueos estructurales (${codes}) y debe regenerarse o corregirse; no puede aprobarse manualmente.`);
  }

  const approvedAt = new Date().toISOString();
  const scenes = current.scenes.map((scene): NarrativeSceneReview => scene.id === sceneId
    ? { ...scene, status: "APPROVED", approvedAt, approvedBy: approvedBy.slice(0, 120) || "manual" }
    : scene);
  const verificationBlocked = !current.verification.valid || current.verification.errorCount > 0;
  const sceneHasErrors = scenes.some((scene) => scene.status === "NEEDS_REVIEW");
  const { approval: _approval, ...withoutApproval } = current;
  const reviewed: NarrativeReviewManifest = {
    ...withoutApproval,
    state: verificationBlocked || sceneHasErrors ? "NEEDS_REVIEW" : "READY_FOR_REVIEW",
    reason: verificationBlocked
      ? "FINAL_VERIFICATION_FAILED"
      : sceneHasErrors
        ? "SCENE_REVIEW_REQUIRED"
        : "AWAITING_APPROVAL",
    updatedAt: approvedAt,
    scenes,
  };
  await writeNarrativeReview(exportDirectory, reviewed);
  return reviewed;
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
  const structural = review.mode === "manual" ? [] : await readSceneReviews(exportDirectory);
  if (structural.some((scene) => scene.blockers.some(isHardBlocker))) {
    throw new Error("El guion contiene escenas vacías, contaminadas o sin trazabilidad y no puede publicarse.");
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
      const blockers = structuralBlockers(artifact, evidenceIds);
      const errorCount = auditErrors + blockers.length;
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
        issueCount: issues.length + blockers.length,
        errorCount,
        warningCount,
        evidenceIds,
        blockers,
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
        blockers: [{ code: "EMPTY_SCENE", message: "No se pudo leer el artefacto de la escena." }],
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
    title: "Guion editado manualmente",
    status: valid ? "GENERATED" : "NEEDS_REVIEW",
    auditValid: valid,
    issueCount: verification.issues.length,
    errorCount,
    warningCount,
    evidenceIds: [],
    blockers: [],
  };
}

function structuralBlockers(
  artifact: SceneArtifact,
  evidenceIds: readonly string[],
): NarrativeSceneBlocker[] {
  const blockers: NarrativeSceneBlocker[] = [];
  const text = typeof artifact.text === "string" ? artifact.text.trim() : "";
  if (text === "") {
    blockers.push({ code: "EMPTY_SCENE", message: "La escena está vacía." });
  } else {
    if (!/^#\s+ESCENA\b/imu.test(text)) {
      blockers.push({ code: "INVALID_SCENE_HEADER", message: "La escena no comienza con un encabezado # ESCENA válido." });
    }
    if (looksLikeModelMeta(text)) {
      blockers.push({ code: "MODEL_META_CONTAMINATION", message: "La salida contiene razonamiento o instrucciones del modelo en lugar de narrativa." });
    }
  }
  if (evidenceIds.length === 0) {
    blockers.push({ code: "MISSING_TRACEABILITY", message: "La escena no contiene identificadores de evidencia." });
  }
  return blockers;
}

function looksLikeModelMeta(text: string): boolean {
  const sample = text.slice(0, 8_000);
  return /(?:^|\n)\s*(?:okay|alright|we need|i need|let me|the user)\b/imu.test(sample)
    || /\bthe user (?:has|is|provided|wants|needs)\b/iu.test(sample)
    || /\b(?:problem statement|system prompt|assistant response|language model)\b/iu.test(sample)
    || /<\/?think>/iu.test(sample);
}

function isHardBlocker(blocker: NarrativeSceneBlocker): boolean {
  return blocker.code === "EMPTY_SCENE" || blocker.code === "MODEL_META_CONTAMINATION";
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
