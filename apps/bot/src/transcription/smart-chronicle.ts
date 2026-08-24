export interface ChronicleTranscriptLine {
  readonly utteranceId?: string;
  readonly startMs: number;
  readonly speakerName: string;
  readonly text: string;
  readonly confidence?: number | null;
}

export interface ChroniclePoint {
  readonly startMs: number;
  readonly speakerName: string;
  readonly text: string;
}

export interface SmartChronicle {
  readonly version: 1;
  readonly mode: "extractive";
  readonly summary: readonly ChroniclePoint[];
  readonly keyMoments: readonly ChroniclePoint[];
  readonly decisions: readonly ChroniclePoint[];
  readonly pendingTasks: readonly ChroniclePoint[];
  readonly participants: readonly {
    readonly name: string;
    readonly interventions: number;
  }[];
  readonly mentionedTerms: readonly string[];
}

const decisionPattern = /\b(decid(?:imos|ieron|ió|ido)|acord(?:amos|aron|ó)|eleg(?:imos|ieron|ió)|acept(?:amos|aron|ó)|rechaz(?:amos|aron|ó)|opt(?:amos|aron|ó)|resolv(?:imos|ieron|ió)|tom(?:amos|aron|ó) la decisión|entonces)\b/iu;
const pendingPattern = /\b(hay que|tenemos que|debemos|debe|deben|necesitamos|queda pendiente|falta por|para la próxima|para la próxima sesión|toca|les toca)\b/iu;
const instructionalPattern = /\b(antes de grabar|después seleccionamos|durante la sesión|para comenzar|desde|por ejemplo|si\s|si vamos|si necesitamos|en esta prueba|a continuación)\b/iu;
const eventPattern = /\b(descubr\w*|encontr\w*|revel\w*|atac\w*|combat\w*|derrot\w*|muert\w*|murió|lleg\w*|entr\w*|escap\w*|salv\w*|consigu\w*|aparec\w*|desaparec\w*|traicion\w*|captur(?:amos|aron|ó|ado|ada)|recuper\w*)\b/iu;
const salientPattern = /\b(importante|objetivo|primer paso|segundo paso|al terminar|resultado|secreto|peligro|misión|sesión|personaje|campaña)\b/iu;

export function generateSmartChronicle(
  lines: readonly ChronicleTranscriptLine[],
  configuredTerms: readonly string[] = [],
): SmartChronicle {
  const candidates = lines.flatMap(toSentencePoints);
  const decisions = selectDistinct(
    candidates.filter((point) => decisionPattern.test(point.text) && !isHypothetical(point.text) && !isInstructional(point.text)),
    6,
  );
  const pendingTasks = selectDistinct(
    candidates.filter((point) => pendingPattern.test(point.text) && !isHypothetical(point.text) && !isInstructional(point.text)),
    6,
  );
  const keyMoments = selectDistinct(
    candidates.filter((point) => eventPattern.test(point.text)),
    8,
  );

  const ranked = candidates
    .map((point, index) => ({
      point,
      index,
      score:
        (decisionPattern.test(point.text) ? 5 : 0) +
        (pendingPattern.test(point.text) ? 4 : 0) +
        (eventPattern.test(point.text) ? 4 : 0) +
        (salientPattern.test(point.text) ? 3 : 0) +
        (point.text.length >= 45 && point.text.length <= 240 ? 2 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const summary = selectDistinct(ranked.map((item) => item.point), 5)
    .sort((left, right) => left.startMs - right.startMs);

  const participantUtterances = new Map<string, Set<string>>();
  for (const [index, line] of lines.entries()) {
    const utterances = participantUtterances.get(line.speakerName) ?? new Set<string>();
    utterances.add(line.utteranceId ?? `line:${index}`);
    participantUtterances.set(line.speakerName, utterances);
  }
  const normalizedTranscript = lines.map((line) => normalizeForComparison(line.text)).join(" ");
  const mentionedTerms = [...new Set(configuredTerms.map((term) => term.trim()).filter(Boolean))]
    .filter((term) => normalizedTranscript.includes(normalizeForComparison(term)))
    .slice(0, 30);

  return {
    version: 1,
    mode: "extractive",
    summary,
    keyMoments,
    decisions,
    pendingTasks,
    participants: [...participantUtterances.entries()]
      .map(([name, utterances]) => ({ name, interventions: utterances.size }))
      .sort((left, right) => right.interventions - left.interventions || left.name.localeCompare(right.name, "es")),
    mentionedTerms,
  };
}

function toSentencePoints(line: ChronicleTranscriptLine): ChroniclePoint[] {
  if (line.confidence !== undefined && line.confidence !== null && line.confidence < 0.35) {
    return [];
  }
  return line.text
    .split(/(?<=[.!?])\s+/u)
    .map((text) => text.trim())
    .filter((text) => text.length >= 20)
    .map((text) => ({
      startMs: line.startMs,
      speakerName: line.speakerName,
      text: text.slice(0, 320),
    }));
}

function selectDistinct(
  points: readonly ChroniclePoint[],
  limit: number,
): ChroniclePoint[] {
  const selected: ChroniclePoint[] = [];
  for (const point of points) {
    const normalized = normalizeForComparison(point.text);
    if (selected.some((existing) => similarity(normalized, normalizeForComparison(existing.text)) >= 0.72)) {
      continue;
    }
    selected.push(point);
    if (selected.length === limit) break;
  }
  return selected;
}

function normalizeForComparison(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9ñ]+/gu, " ")
    .trim();
}

function isHypothetical(value: string): boolean {
  return /^(por ejemplo|si\s|para hacerlo|allí se|durante la partida)/iu.test(value.trim());
}

function isInstructional(value: string): boolean {
  return instructionalPattern.test(value.trim()) || /\b(debemos|debemos informar|antes de grabar|después seleccionamos)\b/iu.test(value.trim());
}

function similarity(left: string, right: string): number {
  const leftWords = new Set(left.split(" ").filter(Boolean));
  const rightWords = new Set(right.split(" ").filter(Boolean));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let intersection = 0;
  for (const word of leftWords) if (rightWords.has(word)) intersection += 1;
  return intersection / new Set([...leftWords, ...rightWords]).size;
}
