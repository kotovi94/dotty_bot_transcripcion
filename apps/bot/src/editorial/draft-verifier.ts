import { EDITORIAL_CONFIG } from "./editorial-config.ts";
import { normalizeEditorialText } from "./semantic-diff.ts";

export interface VerificationIssue { type: "unsupported" | "meta" | "format" | "rule"; severity: "warning" | "error"; fragment: string; reason: string; evidenceLevel: "explicit" | "strongly_implied" | "inferred" | "unsupported"; confidence: number; }
export interface VerificationReport { valid: boolean; issues: VerificationIssue[]; checkedAt: string; }

const metaPattern = /\b(prompt|modelo de lenguaje|transcripci[oó]n|evidencia|como (?:ia|ai)|the user)\b/giu;
const unsupportedPattern = /\b(?:sin duda|obviamente|secretamente|aterrorizad[oa]s?|furios[oa]s?|desesperad[oa]s?|con malicia|inevitablemente)\b/giu;

export function verifyDraft(draft: string, evidenceTexts: readonly string[], rules: readonly { text: string; category?: string }[] = []): VerificationReport {
  const issues: VerificationIssue[] = [];
  for (const match of draft.matchAll(metaPattern)) issues.push(issue("meta", "error", match[0], "Contenido meta no permitido.", "unsupported"));
  for (const match of draft.matchAll(unsupportedPattern)) {
    if (!hasSupport(match[0], evidenceTexts)) issues.push(issue("unsupported", "warning", match[0], "Modificador emocional o intencional sin respaldo.", "unsupported"));
  }
  if (!/^#\s+.+/mu.test(draft) || !/^#\s+ESCENA\s+\d+/gimu.test(draft)) {
    issues.push(issue("format", "error", draft.slice(0, 80), "Falta la estructura obligatoria de título y escenas.", "explicit"));
  }
  for (const rule of rules) {
    if (/no (?:mencionar|incluir)/iu.test(rule.text)) {
      const target = rule.text.match(/no (?:mencionar|incluir)\s+(.+?)(?:\.|$)/iu)?.[1];
      if (target && normalizeEditorialText(draft).includes(normalizeEditorialText(target))) issues.push(issue("rule", "error", target, `Incumple una regla editorial aprobada: ${rule.text}`, "explicit"));
    }
  }
  return { valid: !issues.some((entry) => entry.severity === "error"), issues, checkedAt: new Date().toISOString() };
}
function hasSupport(fragment: string, evidence: readonly string[]): boolean {
  const tokens = new Set(normalizeEditorialText(fragment).split(" ").filter((token) => token.length > 3));
  if (tokens.size === 0) return false;
  return evidence.some((text) => { const normalized = normalizeEditorialText(text); let hits = 0; for (const token of tokens) if (normalized.includes(token)) hits += 1; return hits / tokens.size >= EDITORIAL_CONFIG.verifier.minEvidenceTokenOverlap; });
}
function issue(type: VerificationIssue["type"], severity: VerificationIssue["severity"], fragment: string, reason: string, evidenceLevel: VerificationIssue["evidenceLevel"]): VerificationIssue {
  const confidence = EDITORIAL_CONFIG.confidence[evidenceLevel === "strongly_implied" ? "stronglyImplied" : evidenceLevel];
  return { type, severity, fragment, reason, evidenceLevel, confidence };
}
