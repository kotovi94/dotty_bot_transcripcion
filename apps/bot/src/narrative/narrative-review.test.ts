import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { VerificationReport } from "../editorial/draft-verifier.ts";
import {
  approveNarrativeScene,
  approveNarrativeReview,
  assertNarrativeApproved,
  hashNarrative,
  refreshNarrativeReview,
} from "./narrative-review.ts";

const validVerification: VerificationReport = {
  valid: true,
  issues: [],
  checkedAt: "2026-09-13T12:00:00.000Z",
};

describe("narrative review gate", () => {
  it("requires explicit approval and binds it to the exact guion", async () => {
    const root = await createFixture({ auditValid: true, verification: validVerification });
    try {
      const review = await refreshNarrativeReview(root, "session-1", validVerification);
      assert.equal(review.state, "READY_FOR_REVIEW");
      await assert.rejects(
        () => assertNarrativeApproved(root, "session-1"),
        /todavía no está aprobado/u,
      );

      const approved = await approveNarrativeReview(root, "session-1", "test");
      assert.equal(approved.state, "APPROVED");
      assert.equal(approved.scenes[0]?.status, "APPROVED");
      await assertNarrativeApproved(root, "session-1");

      await writeFile(join(root, "guion.md"), `${validScript()}\nCambio posterior a la aprobación.\n`, "utf8");
      await assert.rejects(
        () => assertNarrativeApproved(root, "session-1"),
        /cambió después de aprobarse/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks approval when a scene needs review", async () => {
    const root = await createFixture({ auditValid: false, verification: validVerification });
    try {
      const review = await refreshNarrativeReview(root, "session-2", validVerification);
      assert.equal(review.state, "NEEDS_REVIEW");
      assert.equal(review.scenes[0]?.status, "NEEDS_REVIEW");
      await assert.rejects(
        () => approveNarrativeReview(root, "session-2", "test"),
        /requieren revisión/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires human review when evidence IDs are missing without making recovery impossible", async () => {
    const root = await createFixture({ auditValid: true, verification: validVerification, evidenceIds: [] });
    try {
      const review = await refreshNarrativeReview(root, "session-2-no-evidence", validVerification);
      assert.equal(review.state, "NEEDS_REVIEW");
      assert.equal(review.scenes[0]?.status, "NEEDS_REVIEW");
      assert.equal(review.scenes[0]?.errorCount, 1);
      await assert.rejects(() => approveNarrativeReview(root, "session-2-no-evidence", "test"), /requieren revisión/u);
      const reviewed = await approveNarrativeScene(root, "session-2-no-evidence", "scene_001", "test");
      assert.equal(reviewed.state, "READY_FOR_REVIEW");
      const verifiedAgain = await refreshNarrativeReview(root, "session-2-no-evidence", validVerification);
      assert.equal(verifiedAgain.scenes[0]?.status, "APPROVED");
      assert.equal(verifiedAgain.state, "READY_FOR_REVIEW");
      assert.equal((await approveNarrativeReview(root, "session-2-no-evidence", "test")).state, "APPROVED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a human to accept an editorial audit issue and preserves that decision on verification", async () => {
    const root = await createFixture({ auditValid: false, verification: validVerification });
    try {
      await refreshNarrativeReview(root, "session-scene-review", validVerification);
      const reviewed = await approveNarrativeScene(root, "session-scene-review", "scene_001", "test-reviewer");
      assert.equal(reviewed.state, "READY_FOR_REVIEW");
      assert.equal(reviewed.scenes[0]?.status, "APPROVED");
      assert.equal(reviewed.scenes[0]?.approvedBy, "test-reviewer");

      const refreshed = await refreshNarrativeReview(root, "session-scene-review", validVerification);
      assert.equal(refreshed.state, "READY_FOR_REVIEW");
      assert.equal(refreshed.scenes[0]?.status, "APPROVED");

      const approved = await approveNarrativeReview(root, "session-scene-review", "test");
      assert.equal(approved.state, "APPROVED");
      await assertNarrativeApproved(root, "session-scene-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reset a human scene decision when final verification still fails", async () => {
    const invalidVerification: VerificationReport = {
      valid: false,
      checkedAt: "2026-09-13T12:00:00.000Z",
      issues: [{
        type: "meta",
        severity: "error",
        fragment: "modelo de lenguaje",
        reason: "Contenido meta no permitido.",
        evidenceLevel: "unsupported",
        confidence: 1,
      }],
    };
    const root = await createFixture({ auditValid: false, verification: invalidVerification });
    try {
      await refreshNarrativeReview(root, "session-failed-verification", invalidVerification);
      const reviewed = await approveNarrativeScene(root, "session-failed-verification", "scene_001", "test-reviewer");
      assert.equal(reviewed.scenes[0]?.status, "APPROVED");
      assert.equal(reviewed.state, "NEEDS_REVIEW");

      const refreshed = await refreshNarrativeReview(root, "session-failed-verification", invalidVerification);
      assert.equal(refreshed.scenes[0]?.status, "APPROVED");
      assert.equal(refreshed.scenes[0]?.approvedBy, "test-reviewer");
      assert.equal(refreshed.state, "NEEDS_REVIEW");

      const recovered = await refreshNarrativeReview(root, "session-failed-verification", validVerification);
      assert.equal(recovered.scenes[0]?.status, "APPROVED");
      assert.equal(recovered.state, "READY_FOR_REVIEW");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks approval when final verification has errors", async () => {
    const invalidVerification: VerificationReport = {
      valid: false,
      checkedAt: "2026-09-13T12:00:00.000Z",
      issues: [{
        type: "unsupported",
        severity: "error",
        fragment: "inventado",
        reason: "Sin respaldo.",
        evidenceLevel: "unsupported",
        confidence: 1,
      }],
    };
    const root = await createFixture({ auditValid: true, verification: invalidVerification });
    try {
      const review = await refreshNarrativeReview(root, "session-3", invalidVerification);
      assert.equal(review.state, "NEEDS_REVIEW");
      assert.equal(review.verification.errorCount, 1);
      await assert.rejects(
        () => approveNarrativeReview(root, "session-3", "test"),
        /errores de verificación/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an existing approval when verification is repeated without changing the script", async () => {
    const root = await createFixture({ auditValid: true, verification: validVerification });
    try {
      await refreshNarrativeReview(root, "session-4", validVerification);
      const approved = await approveNarrativeReview(root, "session-4", "test");
      const refreshed = await refreshNarrativeReview(root, "session-4", validVerification);
      assert.equal(refreshed.state, "APPROVED");
      assert.equal(refreshed.approval?.sourceHash, approved.approval?.sourceHash);
      assert.equal(refreshed.sourceHash, hashNarrative(validScript()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never allows an empty scene to be accepted manually", async () => {
    const root = await createFixture({ auditValid: true, verification: validVerification, sceneText: "" });
    try {
      const review = await refreshNarrativeReview(root, "session-empty", validVerification);
      assert.deepEqual(review.scenes[0]?.blockers.map((blocker) => blocker.code), ["EMPTY_SCENE"]);
      await assert.rejects(
        () => approveNarrativeScene(root, "session-empty", "scene_001", "test"),
        /bloqueos estructurales/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects model reasoning even when the model auditor returned valid", async () => {
    const root = await createFixture({
      auditValid: true,
      verification: validVerification,
      sceneText: "Okay, the user provided a transcript. I need to analyze it before writing the answer.",
    });
    try {
      const review = await refreshNarrativeReview(root, "session-meta", validVerification);
      assert.equal(review.state, "NEEDS_REVIEW");
      assert.ok(review.scenes[0]?.blockers.some((blocker) => blocker.code === "MODEL_META_CONTAMINATION"));
      await assert.rejects(
        () => approveNarrativeReview(root, "session-meta", "test"),
        /bloqueos estructurales/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createFixture(options: {
  auditValid: boolean;
  verification: VerificationReport;
  evidenceIds?: string[];
  sceneText?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dotty-narrative-review-"));
  await mkdir(join(root, "guion.work"), { recursive: true });
  await writeFile(join(root, "guion.md"), validScript(), "utf8");
  await writeFile(join(root, "guion.generado.md"), validScript(), "utf8");
  await writeFile(
    join(root, "guion.verificacion.json"),
    `${JSON.stringify(options.verification, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "guion.work", "scene_001.json"),
    `${JSON.stringify({
      id: "scene_001",
      title: "Escena 1",
      text: options.sceneText ?? "# ESCENA — 00:00:00 a 00:01:00\n\nAda abre la puerta según la evidencia.",
      evidence_ids: options.evidenceIds ?? ["B001-F-1"],
      audit: options.auditValid
        ? { valid: true, status: "VALIDATED", reviewStatus: "VALIDATED", issues: [] }
        : {
          valid: false,
          status: "NEEDS_REVIEW",
          reviewStatus: "NEEDS_REVIEW",
          issues: [{ severity: "error", reason: "Detalle sin respaldo" }],
        },
    }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function validScript(): string {
  return [
    "# Campaña — Sesión 1",
    "",
    "# ESCENA 1",
    "",
    "Ada abre la puerta según la evidencia confirmada y el grupo continúa.",
    "",
    "El resto de la escena conserva únicamente hechos respaldados por la transcripción.",
  ].join("\n");
}
