import type { PrismaClient } from "../generated/prisma/client.ts";
import { CRITICAL_EDITORIAL_RULES, EDITORIAL_CONFIG } from "./editorial-config.ts";
import { analyzeSemanticDiff, classifyChange, normalizeEditorialText, type SemanticDiff } from "./semantic-diff.ts";

export type EditorialScope = "session" | "campaign" | "user" | "global";
export type EditorialRuleStatus = "candidate" | "approved" | "rejected" | "deprecated";
export interface EditorialRuleView { id: string; scope: EditorialScope; category: string; text: string; priority: number; confidence: number; status: EditorialRuleStatus; occurrences: number; version: number; source: string; createdAt: string; updatedAt: string; }
export interface EditorialLearningState { rules: EditorialRuleView[]; candidates: EditorialRuleView[]; metrics: { feedbackCount: number; averageEditRatio: number; repeatedCorrections: number; categoryCounts: Record<string, number> }; }
export interface FeedbackInput { sessionId: string; generatedVersion: string; editedVersion: string; comment?: string; ownerId?: string; }
export interface RetrievalContext { sessionId: string; campaignId: string; ownerId?: string; query?: string; }

export class EditorialLearningService {
  constructor(private readonly database: PrismaClient) {}

  async ensureCriticalRules(): Promise<void> {
    for (const [category, text] of CRITICAL_EDITORIAL_RULES) {
      const normalizedText = normalizeEditorialText(text);
      const existing = await this.database.editorialRule.findFirst({ where: { normalizedText, source: "system_seed" } });
      if (existing) continue;
      const rule = await this.database.editorialRule.create({ data: { scope: "global", category, text, normalizedText, priority: 100, confidence: 1, status: "approved", source: "system_seed", metadataJson: JSON.stringify({ critical: true }) } });
      await this.database.editorialRuleVersion.create({ data: { ruleId: rule.id, version: 1, snapshotJson: snapshot(rule), action: "seed" } });
    }
  }

  async submitFeedback(input: FeedbackInput): Promise<{ feedbackId: string; diff: SemanticDiff; candidates: EditorialRuleView[] }> {
    const session = await this.database.session.findUnique({ where: { id: input.sessionId } });
    if (!session) throw new Error("La sesión no existe en la base de datos.");
    if (input.generatedVersion.length > 5_000_000 || input.editedVersion.length > 5_000_000) throw new Error("El contenido editorial es demasiado grande.");
    const comment = String(input.comment ?? "").trim().slice(0, 4_000);
    const diff = analyzeSemanticDiff(input.generatedVersion, input.editedVersion);
    if (diff.changes.length === 0 && comment === "") throw new Error("No hay correcciones ni instrucciones que aprender.");
    const feedback = await this.database.editorialFeedback.create({
      data: {
        campaignId: session.campaignId,
        sessionId: session.id,
        generatedVersion: input.generatedVersion,
        editedVersion: input.editedVersion,
        comment,
        diffJson: JSON.stringify(diff),
        errors: { create: diff.changes.slice(0, 100).map((change) => ({ category: change.category, severity: change.severity, generatedFragment: change.generatedFragment, correctedFragment: change.correctedFragment, evidenceJson: JSON.stringify({ kind: change.kind, classification: "human_correction" }) })) },
      },
    });
    const proposals = buildCandidateProposals(diff, comment).slice(0, EDITORIAL_CONFIG.patterns.maxCandidatesPerFeedback);
    const candidates: EditorialRuleView[] = [];
    for (const proposal of proposals) {
      const normalizedText = normalizeEditorialText(proposal.text);
      const existing = await this.database.editorialRule.findFirst({ where: { normalizedText, category: proposal.category, campaignId: session.campaignId, status: "candidate" } });
      if (existing) {
        const updated = await this.database.editorialRule.update({ where: { id: existing.id }, data: { occurrences: { increment: 1 }, confidence: Math.min(0.95, existing.confidence + 0.08) } });
        candidates.push(view(updated));
        continue;
      }
      const created = await this.database.editorialRule.create({ data: { scope: "campaign", ownerId: input.ownerId ?? null, campaignId: session.campaignId, category: proposal.category, text: proposal.text, normalizedText, priority: proposal.priority, confidence: proposal.confidence, status: "candidate", source: "human_feedback", metadataJson: JSON.stringify({ feedbackId: feedback.id }) } });
      await this.database.editorialRuleVersion.create({ data: { ruleId: created.id, version: 1, snapshotJson: snapshot(created), action: "candidate_created" } });
      candidates.push(view(created));
    }
    await this.recordMetric("feedback_edit_ratio", diff.editRatio, session.campaignId, session.id, { changes: diff.changes.length });
    await this.recordMetric("feedback_submitted", 1, session.campaignId, session.id, { candidates: candidates.length });
    return { feedbackId: feedback.id, diff, candidates };
  }

  async decideRule(ruleId: string, decision: "approve" | "reject" | "deprecate", scope?: EditorialScope): Promise<EditorialRuleView> {
    const current = await this.database.editorialRule.findUnique({ where: { id: ruleId } });
    if (!current) throw new Error("La regla editorial no existe.");
    if (decision === "approve" && !scope) throw new Error("Debes elegir el alcance del aprendizaje.");
    const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "deprecated";
    const nextScope = scope ?? current.scope;
    const sessionId = nextScope === "session" ? current.sessionId ?? metadata(current.metadataJson).sessionId as string | undefined : null;
    if (nextScope === "session" && !sessionId) {
      const feedbackId = metadata(current.metadataJson).feedbackId as string | undefined;
      const feedback = feedbackId ? await this.database.editorialFeedback.findUnique({ where: { id: feedbackId } }) : null;
      if (!feedback) throw new Error("No se pudo resolver la sesión de esta regla.");
      Object.assign(current, { sessionId: feedback.sessionId });
    }
    const update = {
      status,
      scope: nextScope,
      ownerId: nextScope === "user" ? current.ownerId : null,
      campaignId: nextScope === "campaign" || nextScope === "session" ? current.campaignId : null,
      sessionId: nextScope === "session" ? current.sessionId : null,
      version: current.version + 1,
    };
    const updated = await this.database.editorialRule.update({ where: { id: ruleId }, data: update });
    await this.database.editorialRuleVersion.create({ data: { ruleId, version: updated.version, snapshotJson: snapshot(updated), action: decision } });
    if (decision === "approve") {
      await this.deprecateConflicts(updated);
      await this.approveExampleFromRule(updated);
      await this.recordMetric("rule_approved", 1, updated.campaignId, updated.sessionId, { scope: updated.scope, category: updated.category });
    } else {
      await this.recordMetric(decision === "reject" ? "rule_rejected" : "rule_deprecated", 1, current.campaignId, current.sessionId, { scope: current.scope, category: current.category });
    }
    return view(updated);
  }

  async rollbackRule(ruleId: string): Promise<EditorialRuleView> {
    const current = await this.database.editorialRule.findUnique({ where: { id: ruleId } });
    if (!current) throw new Error("La regla editorial no existe.");
    const previous = await this.database.editorialRuleVersion.findFirst({ where: { ruleId, version: { lt: current.version } }, orderBy: { version: "desc" } });
    if (!previous) throw new Error("La regla no tiene una versión anterior.");
    const data = JSON.parse(previous.snapshotJson) as Record<string, unknown>;
    const restored = await this.database.editorialRule.update({ where: { id: ruleId }, data: { scope: String(data.scope), ownerId: nullable(data.ownerId), campaignId: nullable(data.campaignId), sessionId: nullable(data.sessionId), category: String(data.category), text: String(data.text), normalizedText: String(data.normalizedText), priority: Number(data.priority), confidence: Number(data.confidence), status: String(data.status), source: String(data.source), occurrences: Number(data.occurrences), metadataJson: String(data.metadataJson), version: current.version + 1 } });
    await this.database.editorialRuleVersion.create({ data: { ruleId, version: restored.version, snapshotJson: snapshot(restored), action: "rollback", reason: `Restaurada desde versión ${previous.version}` } });
    return view(restored);
  }

  async listState(sessionId: string): Promise<EditorialLearningState> {
    await this.ensureCriticalRules();
    const session = await this.database.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error("La sesión no existe.");
    const records = await this.database.editorialRule.findMany({ where: { OR: [{ scope: "global" }, { campaignId: session.campaignId }, { sessionId }] }, orderBy: [{ status: "asc" }, { priority: "desc" }, { updatedAt: "desc" }] });
    const feedback = await this.database.editorialFeedback.findMany({ where: { campaignId: session.campaignId }, select: { diffJson: true } });
    const allChanges = feedback.flatMap((item) => safeDiff(item.diffJson).changes);
    const categoryCounts: Record<string, number> = {};
    for (const change of allChanges) categoryCounts[change.category] = (categoryCounts[change.category] ?? 0) + 1;
    return {
      rules: records.filter((rule) => rule.status !== "candidate").map(view),
      candidates: records.filter((rule) => rule.status === "candidate").map(view),
      metrics: { feedbackCount: feedback.length, averageEditRatio: average(feedback.map((item) => safeDiff(item.diffJson).editRatio)), repeatedCorrections: records.filter((rule) => rule.occurrences >= EDITORIAL_CONFIG.patterns.repeatedCorrectionThreshold).length, categoryCounts },
    };
  }

  async retrieve(context: RetrievalContext): Promise<{ rules: EditorialRuleView[]; examples: Array<{ input: string; output: string; category: string }>; prompt: string }> {
    await this.ensureCriticalRules();
    const records = await this.database.editorialRule.findMany({ where: { status: "approved", OR: [{ scope: "global" }, { ownerId: context.ownerId ?? "__none__" }, { campaignId: context.campaignId }, { sessionId: context.sessionId }] } });
    const query = normalizeEditorialText(context.query ?? "");
    const ranked = records.map((rule) => ({ rule, rank: scopeWeight(rule.scope) + rule.priority + relevance(query, rule.normalizedText) * 100 })).sort((a, b) => b.rank - a.rank).slice(0, EDITORIAL_CONFIG.retrieval.maxRules).map(({ rule }) => rule);
    const examples = await this.database.editorialExample.findMany({ where: { approved: true, OR: [{ scope: "global" }, { ownerId: context.ownerId ?? "__none__" }, { campaignId: context.campaignId }] }, orderBy: { updatedAt: "desc" }, take: EDITORIAL_CONFIG.retrieval.maxExamples });
    const prompt = renderPrompt(ranked.map(view), examples);
    await this.recordMetric("rules_retrieved", ranked.length, context.campaignId, context.sessionId, { examples: examples.length }).catch(() => undefined);
    return { rules: ranked.map(view), examples: examples.map((example) => ({ input: example.input, output: example.output, category: example.category })), prompt };
  }

  async exportDataset(campaignId?: string): Promise<string> {
    const feedback = await this.database.editorialFeedback.findMany({ where: campaignId ? { campaignId } : {}, include: { errors: true }, orderBy: { createdAt: "asc" } });
    return feedback.map((item) => JSON.stringify({ id: item.id, campaignId: item.campaignId, sessionId: item.sessionId, generated: item.generatedVersion, corrected: item.editedVersion, instruction: item.comment, errors: item.errors.map((error) => ({ category: error.category, severity: error.severity, before: error.generatedFragment, after: error.correctedFragment })), createdAt: item.createdAt.toISOString() })).join("\n");
  }

  private async approveExampleFromRule(rule: { metadataJson: string; scope: string; ownerId: string | null; campaignId: string | null; category: string }): Promise<void> {
    const feedbackId = metadata(rule.metadataJson).feedbackId;
    if (typeof feedbackId !== "string") return;
    const feedback = await this.database.editorialFeedback.findUnique({ where: { id: feedbackId } });
    if (!feedback || feedback.generatedVersion === feedback.editedVersion) return;
    const normalizedText = normalizeEditorialText(feedback.generatedVersion.slice(0, 1_000) + feedback.editedVersion.slice(0, 1_000));
    const exists = await this.database.editorialExample.findFirst({ where: { normalizedText, category: rule.category } });
    if (!exists) await this.database.editorialExample.create({ data: { scope: rule.scope, ownerId: rule.ownerId, campaignId: rule.campaignId, category: rule.category, input: feedback.generatedVersion.slice(0, 8_000), output: feedback.editedVersion.slice(0, 8_000), normalizedText, approved: true } });
  }

  private async deprecateConflicts(approved: { id: string; category: string; normalizedText: string; campaignId: string | null; scope: string }): Promise<void> {
    const others = await this.database.editorialRule.findMany({ where: { id: { not: approved.id }, status: "approved", category: approved.category, OR: [{ scope: "global" }, { campaignId: approved.campaignId ?? "__none__" }] } });
    for (const other of others) {
      if (!conflicts(approved.normalizedText, other.normalizedText)) continue;
      const updated = await this.database.editorialRule.update({ where: { id: other.id }, data: { status: "deprecated", version: other.version + 1 } });
      await this.database.editorialRuleVersion.create({ data: { ruleId: other.id, version: updated.version, snapshotJson: snapshot(updated), action: "conflict_deprecated", reason: `Reemplazada por ${approved.id}` } });
    }
  }

  private async recordMetric(name: string, value: number, campaignId: string | null, sessionId: string | null, details: Record<string, unknown>): Promise<void> {
    await this.database.editorialMetric.create({ data: { name, value, campaignId, sessionId, metadataJson: JSON.stringify(details) } });
  }
}

function buildCandidateProposals(diff: SemanticDiff, comment: string): Array<{ category: string; text: string; priority: number; confidence: number }> {
  const result: Array<{ category: string; text: string; priority: number; confidence: number }> = [];
  if (comment !== "") result.push({ category: classifyChange(comment), text: comment.replace(/\s+/gu, " ").trim(), priority: 80, confidence: 1 });
  const seen = new Set<string>();
  for (const change of diff.changes.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))) {
    if (seen.has(change.category)) continue;
    seen.add(change.category);
    const before = change.generatedFragment.replace(/\s+/gu, " ").slice(0, 180);
    const after = change.correctedFragment.replace(/\s+/gu, " ").slice(0, 180);
    const text = after ? `Al redactar ${change.category}, preferir esta corrección humana: “${after}” en lugar de “${before || "omitir el contenido"}”.` : `En ${change.category}, evitar el patrón corregido por el editor: “${before}”.`;
    result.push({ category: change.category, text, priority: change.severity === "high" ? 85 : 60, confidence: change.severity === "high" ? 0.82 : 0.68 });
  }
  return result;
}
function renderPrompt(rules: EditorialRuleView[], examples: Array<{ input: string; output: string; category: string }>): string {
  let text = ["REGLAS EDITORIALES APROBADAS (en orden de prioridad):", ...rules.map((rule, index) => `${index + 1}. [${rule.scope}/${rule.category}] ${rule.text}`)].join("\n");
  if (examples.length) text += "\n\nEJEMPLOS APROBADOS:\n" + examples.map((example, index) => `Ejemplo ${index + 1} (${example.category}):\nANTES: ${example.input}\nDESPUÉS: ${example.output}`).join("\n\n");
  return text.slice(0, EDITORIAL_CONFIG.retrieval.maxCharacters);
}
function view(rule: { id: string; scope: string; category: string; text: string; priority: number; confidence: number; status: string; occurrences: number; version: number; source: string; createdAt: Date; updatedAt: Date }): EditorialRuleView {
  return { id: rule.id, scope: rule.scope as EditorialScope, category: rule.category, text: rule.text, priority: rule.priority, confidence: rule.confidence, status: rule.status as EditorialRuleStatus, occurrences: rule.occurrences, version: rule.version, source: rule.source, createdAt: rule.createdAt.toISOString(), updatedAt: rule.updatedAt.toISOString() };
}
function snapshot(rule: object): string { return JSON.stringify(rule); }
function metadata(value: string): Record<string, unknown> { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
function safeDiff(value: string): SemanticDiff { try { return JSON.parse(value) as SemanticDiff; } catch { return { changes: [], addedCharacters: 0, removedCharacters: 0, editRatio: 0 }; } }
function nullable(value: unknown): string | null { return typeof value === "string" && value !== "" ? value : null; }
function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function scopeWeight(scope: string): number { return scope === "session" ? 400 : scope === "campaign" ? 300 : scope === "user" ? 200 : 100; }
function relevance(query: string, candidate: string): number { if (!query) return 0; const q = new Set(query.split(" ").filter((token) => token.length > 3)); if (!q.size) return 0; let hits = 0; for (const token of q) if (candidate.includes(token)) hits += 1; return hits / q.size; }
function conflicts(a: string, b: string): boolean { const negA = /\b(no|evitar|nunca)\b/u.test(a); const negB = /\b(no|evitar|nunca)\b/u.test(b); if (negA === negB) return false; const x = new Set(a.split(" ").filter((token) => token.length > 4)); const y = new Set(b.split(" ").filter((token) => token.length > 4)); let overlap = 0; for (const token of x) if (y.has(token)) overlap += 1; return overlap / Math.max(1, Math.min(x.size, y.size)) >= 0.45; }
function severityWeight(value: string): number { return value === "high" ? 3 : value === "medium" ? 2 : 1; }
