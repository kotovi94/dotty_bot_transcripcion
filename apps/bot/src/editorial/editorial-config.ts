export const EDITORIAL_CONFIG = {
  confidence: { explicit: 1, stronglyImplied: 0.78, inferred: 0.48, unsupported: 0 },
  retrieval: { maxRules: 18, maxExamples: 3, maxCharacters: 6_000, minRelevance: 0.08 },
  patterns: { repeatedCorrectionThreshold: 3, maxCandidatesPerFeedback: 6 },
  verifier: { unsupportedModifierPolicy: "flag" as const, minEvidenceTokenOverlap: 0.12 },
} as const;

export const CRITICAL_EDITORIAL_RULES = [
  ["factualidad", "No inventar hechos, acciones, lugares, objetos, consecuencias ni antecedentes ausentes de la evidencia."],
  ["factualidad", "Separar siempre hechos explícitos, información fuertemente implícita, inferencias y contenido no respaldado."],
  ["personajes", "No atribuir emociones, intenciones, pensamientos o motivaciones si no están respaldados por la evidencia."],
  ["dialogo", "No fabricar citas textuales ni convertir paráfrasis en diálogo literal."],
  ["canon", "Preservar exactamente nombres propios, relaciones y continuidad confirmada de la campaña."],
  ["incertidumbre", "Mantener como inciertos los términos dudosos; no convertirlos en entidades confirmadas."],
  ["estructura", "Conservar el orden causal y temporal respaldado por la transcripción."],
  ["estilo", "No mencionar prompts, modelos, transcripciones, evidencia ni sistemas de juego dentro del guion."],
  ["revision", "Marcar para revisión cualquier fragmento importante que no pueda verificarse de forma independiente."],
  ["prioridad", "La fidelidad factual tiene prioridad sobre la riqueza literaria y la longitud del texto."],
] as const;
