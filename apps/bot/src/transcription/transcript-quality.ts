export interface RecognizedWord {
  readonly text: string;
  readonly probability?: number;
}

export interface TranscriptSegmentAssessment {
  readonly shouldDiscard: boolean;
  readonly reason: string | null;
  readonly confidence: number | null;
  readonly voiceRatio: number;
  readonly suspiciousPhrase: string | null;
}

const knownHallucinationPhrases = [
  "gracias por ver el video",
  "gracias por ver este video",
  "suscríbete al canal",
  "subtítulos realizados por",
  "sous-titrage société radio-canada",
  "thank you for watching",
  "thanks for watching",
  "this is the episode",
];

const suspiciousPhrases = [
  "gracias por escuchar",
  "hasta la próxima",
  "hasta pronto",
  "muchas gracias",
  "vamos a ver",
];

export function normalizeTranscriptText(value: string): string {
  let normalized = value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/([¿¡])\s+/gu, "$1")
    .replace(/([.!?])[\])}]+$/u, "$1")
    .trim();

  const replacements: readonly [RegExp, string][] = [
    [/\b(?:doti|doty|dotty)\s*[- ]\s*personag(?:e|es)\b/giu, "Dotty personajes"],
    [/\b(?:doti|doty|dotty)\s*configura(?:r)?\b/giu, "Dotty configurar"],
    [/\b(?:doti|doty|dotty)\s*finaliza(?:r)?\b/giu, "Dotty finalizar"],
    [/\b(?:doti|doty|dotty)\b/giu, "Dotty"],
    [/\bdiscord\b/giu, "Discord"],
    [/\bbit[áa]gonas\b/giu, "bitácoras"],
    [/\bbitacoras\b/giu, "bitácoras"],
    [/\bbitacora\b/giu, "bitácora"],
    [/\bbit[óo]crora\b/giu, "bitácora"],
    [/\b(?:un|una)\s+h[áa]bito\s+para\s+inteligente\b/giu, "una bitácora inteligente"],
    [/\bsesion\b/giu, "sesión"],
    [/\bnumero\b/giu, "número"],
  ];
  for (const [pattern, replacement] of replacements) {
    normalized = normalized.replace(pattern, replacement);
  }
  normalized = normalized.replace(/\bbit[\p{L}]{3,9}\b/giu, (word) => {
    const folded = foldForVocabulary(word);
    if (!folded.startsWith("bita") && !folded.startsWith("bito")) return word;
    const target = folded.endsWith("s") ? "bitacoras" : "bitacora";
    return levenshteinDistance(folded, target) <= 3
      ? target === "bitacoras" ? "bitácoras" : "bitácora"
      : word;
  });
  if (normalized.length > 0) {
    normalized = normalized[0]!.toLocaleUpperCase("es") + normalized.slice(1);
  }
  return normalized;
}

function foldForVocabulary(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("es");
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? right.length;
}

export function averageWordConfidence(words: readonly RecognizedWord[]): number | null {
  const values = words
    .map((word) => word.probability)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function classifyTranscriptSegment(input: {
  readonly text: string;
  readonly avgLogProbability?: number | undefined;
  readonly noSpeechProbability?: number | undefined;
  readonly compressionRatio?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly voiceRatio?: number | undefined;
  readonly words?: readonly RecognizedWord[] | undefined;
}): TranscriptSegmentAssessment {
  const text = input.text.trim();
  const words = input.words ?? [];
  const confidence = averageWordConfidence(words);
  const durationMs = Math.max(0, input.durationMs ?? 0);
  const voiceRatio = clampVoiceRatio(input.voiceRatio ?? inferVoiceRatio({ durationMs, words, text }));
  const normalizedText = foldForHallucinationDetection(text);
  const knownHallucinationPhrase = knownHallucinationPhrases
    .find((phrase) => normalizedText.includes(foldForHallucinationDetection(phrase))) ?? null;
  const suspiciousPhrase = knownHallucinationPhrase ?? suspiciousPhrases
    .find((phrase) => normalizedText.includes(foldForHallucinationDetection(phrase))) ?? null;

  if (text.length === 0) {
    return { shouldDiscard: true, reason: "transcripción vacía", confidence, voiceRatio, suspiciousPhrase: null };
  }

  const wordCount = words.filter((word) => (word.text ?? "").trim().length > 0).length;
  const textWordCount = text.split(/\s+/u).filter(Boolean).length;
  const effectiveWordCount = Math.max(wordCount, textWordCount);

  if (knownHallucinationPhrase) {
    return { shouldDiscard: true, reason: "plantilla conocida de alucinación", confidence, voiceRatio, suspiciousPhrase };
  }

  if (isExcessivelyRepetitive(text)) {
    return { shouldDiscard: true, reason: "repetición improbable", confidence, voiceRatio, suspiciousPhrase };
  }

  if ((input.noSpeechProbability ?? 0) >= 0.9 && (input.avgLogProbability ?? 0) <= -1) {
    return { shouldDiscard: true, reason: "ausencia de voz y baja confianza", confidence, voiceRatio, suspiciousPhrase };
  }

  if (confidence !== null && confidence < 0.28) {
    return { shouldDiscard: true, reason: "confianza de palabras muy baja", confidence, voiceRatio, suspiciousPhrase };
  }

  if (confidence !== null && confidence < 0.4 && (input.avgLogProbability ?? 0) <= -0.9) {
    return { shouldDiscard: true, reason: "confianza general baja", confidence, voiceRatio, suspiciousPhrase };
  }

  if (
    (input.avgLogProbability ?? 0) <= -1.1
    && (input.noSpeechProbability === undefined || input.noSpeechProbability >= 0.5 || confidence === null || confidence < 0.5)
  ) {
    return { shouldDiscard: true, reason: "resultado de baja confianza", confidence, voiceRatio, suspiciousPhrase };
  }

  if (durationMs > 0 && durationMs <= 600 && voiceRatio <= 0.25) {
    return { shouldDiscard: true, reason: "segmento muy corto", confidence, voiceRatio, suspiciousPhrase };
  }

  if ((input.noSpeechProbability ?? 0) >= 0.8 && (durationMs <= 1_500 || voiceRatio <= 0.25 || effectiveWordCount <= 1)) {
    return { shouldDiscard: true, reason: "baja actividad de voz", confidence, voiceRatio, suspiciousPhrase };
  }

  if (suspiciousPhrase && (input.noSpeechProbability ?? 0) >= 0.75 && (durationMs <= 1_800 || voiceRatio <= 0.3 || effectiveWordCount <= 2)) {
    return { shouldDiscard: true, reason: "frase sospechosa con baja actividad de voz", confidence, voiceRatio, suspiciousPhrase };
  }

  if (effectiveWordCount === 0 && durationMs <= 800) {
    return { shouldDiscard: true, reason: "sin palabras reconocibles", confidence, voiceRatio, suspiciousPhrase };
  }

  return { shouldDiscard: false, reason: null, confidence, voiceRatio, suspiciousPhrase };
}

export function isLikelyHallucination(input: {
  readonly text: string;
  readonly avgLogProbability?: number | undefined;
  readonly noSpeechProbability?: number | undefined;
  readonly compressionRatio?: number | undefined;
}): boolean {
  const assessment = classifyTranscriptSegment({
    text: input.text,
    avgLogProbability: input.avgLogProbability,
    noSpeechProbability: input.noSpeechProbability,
    compressionRatio: input.compressionRatio,
    durationMs: 1_500,
    voiceRatio: 0.8,
  });
  if (assessment.shouldDiscard) return true;
  if ((input.compressionRatio ?? 0) >= 3.2) return true;

  if (isExcessivelyRepetitive(input.text)) return true;
  return false;
}

function isExcessivelyRepetitive(text: string): boolean {
  const words = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("es")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length >= 8 && new Set(words).size <= Math.ceil(words.length / 4)) return true;
  if (words.length < 4 || new Set(words).size !== 1) return false;
  return !new Set(["no", "si", "ja", "eh", "ah", "ay", "oh", "uh", "mm"]).has(words[0] ?? "");
}

function foldForHallucinationDetection(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function qualitySummary(
  lines: readonly { readonly confidence: number | null; readonly words: readonly RecognizedWord[] }[],
) {
  const probabilities = lines.flatMap((line) =>
    line.words
      .map((word) => word.probability)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
  const average = probabilities.length === 0
    ? null
    : probabilities.reduce((total, value) => total + value, 0) / probabilities.length;
  return {
    averageWordConfidence: average,
    wordCount: probabilities.length,
    lowConfidenceWords: probabilities.filter((value) => value < 0.45).length,
    linesToReview: lines.filter((line) => line.confidence !== null && line.confidence < 0.55).length,
  };
}

function inferVoiceRatio(input: { readonly durationMs: number; readonly words: readonly RecognizedWord[]; readonly text: string }): number {
  const wordCount = input.words.filter((word) => (word.text ?? "").trim().length > 0).length;
  const textWordCount = input.text.split(/\s+/u).filter(Boolean).length;
  const effectiveWordCount = Math.max(wordCount, textWordCount);
  if (input.durationMs <= 0) return effectiveWordCount > 0 ? 1 : 0;
  const estimate = effectiveWordCount / Math.max(1, Math.ceil(input.durationMs / 600));
  return Math.min(1, estimate);
}

function clampVoiceRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
