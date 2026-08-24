import { promises as fs } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomically } from "../recording/atomic-json-file.ts";

interface VocabularyEntry {
  readonly term: string;
  readonly normalized: string;
  readonly occurrences: number;
  readonly confidenceTotal: number;
  readonly sessionIds: readonly string[];
  readonly active: boolean;
  readonly lastSeenAt: string;
}

interface VocabularyFile {
  readonly version: 1;
  readonly campaignId: string;
  readonly entries: readonly VocabularyEntry[];
}

export interface VocabularyObservationLine {
  readonly words: readonly {
    readonly text: string;
    readonly probability?: number;
  }[];
}

const minimumConfidence = 0.8;
const singleSessionOccurrences = 6;
const singleSessionAverageConfidence = 0.85;
const maximumEntries = 300;

export class AdaptiveVocabularyStore {
  constructor(private readonly root: string) {}

  async listActive(campaignId: string): Promise<string[]> {
    const vocabulary = await this.read(campaignId);
    return vocabulary.entries
      .filter((entry) => entry.active)
      .sort((left, right) => right.occurrences - left.occurrences)
      .map((entry) => entry.term)
      .slice(0, 100);
  }

  async observe(
    campaignId: string,
    sessionId: string,
    lines: readonly VocabularyObservationLine[],
    excludedTerms: readonly string[] = [],
  ): Promise<string[]> {
    const excluded = new Set(
      excludedTerms.flatMap((term) => {
        const normalized = normalizeTerm(term);
        return [normalized, ...normalized.split(" ")].filter(Boolean);
      }),
    );
    const observations = collectCandidates(lines, excluded);
    if (observations.size === 0) return [];

    const vocabulary = await this.read(campaignId);
    const entries = new Map(vocabulary.entries.map((entry) => [entry.normalized, entry]));
    const activated: string[] = [];
    const now = new Date().toISOString();

    for (const observation of observations.values()) {
      const previous = entries.get(observation.normalized);
      const occurrences = (previous?.occurrences ?? 0) + observation.occurrences;
      const confidenceTotal = (previous?.confidenceTotal ?? 0) + observation.confidenceTotal;
      const sessionIds = [...new Set([...(previous?.sessionIds ?? []), sessionId])].slice(-50);
      const averageConfidence = confidenceTotal / occurrences;
      const active = previous?.active === true || sessionIds.length >= 2 || (
        occurrences >= singleSessionOccurrences &&
        averageConfidence >= singleSessionAverageConfidence
      );
      const entry: VocabularyEntry = {
        term: previous?.term ?? observation.term,
        normalized: observation.normalized,
        occurrences,
        confidenceTotal,
        sessionIds,
        active,
        lastSeenAt: now,
      };
      entries.set(entry.normalized, entry);
      if (active && previous?.active !== true) activated.push(entry.term);
    }

    const retained = [...entries.values()]
      .sort((left, right) => Number(right.active) - Number(left.active) || right.occurrences - left.occurrences)
      .slice(0, maximumEntries);
    await this.write({ version: 1, campaignId, entries: retained });
    return activated;
  }

  private async read(campaignId: string): Promise<VocabularyFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathFor(campaignId), "utf8")) as VocabularyFile;
      if (parsed.version === 1 && parsed.campaignId === campaignId && Array.isArray(parsed.entries)) {
        return parsed;
      }
    } catch {
      // A campaign starts with an empty learned vocabulary.
    }
    return { version: 1, campaignId, entries: [] };
  }

  private async write(vocabulary: VocabularyFile): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomically(this.pathFor(vocabulary.campaignId), vocabulary);
  }

  private pathFor(campaignId: string): string {
    const safeId = campaignId.replace(/[^a-zA-Z0-9_-]/gu, "_");
    return join(this.root, `${safeId}.json`);
  }
}

function collectCandidates(
  lines: readonly VocabularyObservationLine[],
  excluded: ReadonlySet<string>,
): Map<string, { term: string; normalized: string; occurrences: number; confidenceTotal: number }> {
  const candidates = new Map<string, { term: string; normalized: string; occurrences: number; confidenceTotal: number }>();
  for (const line of lines) {
    for (const [index, word] of line.words.entries()) {
      if (index === 0 || (word.probability ?? 0) < minimumConfidence) continue;
      const term = cleanWord(word.text);
      if (!isProperNameCandidate(term)) continue;
      const normalized = normalizeTerm(term);
      if (isExcludedCandidate(normalized, excluded)) continue;
      const previous = candidates.get(normalized);
      candidates.set(normalized, {
        term: previous?.term ?? term,
        normalized,
        occurrences: (previous?.occurrences ?? 0) + 1,
        confidenceTotal: (previous?.confidenceTotal ?? 0) + (word.probability ?? 0),
      });
    }
  }
  return candidates;
}

function cleanWord(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/^[^\p{L}]+|[^\p{L}'’\-]+$/gu, "");
}

function isProperNameCandidate(value: string): boolean {
  if (value.length < 3 || value.length > 40 || !/^[\p{L}][\p{L}'’\-]*$/u.test(value)) return false;
  const first = value[0] ?? "";
  return first === first.toLocaleUpperCase("es") && first !== first.toLocaleLowerCase("es");
}

function normalizeTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^\p{L}0-9]+/gu, " ")
    .trim();
}

function isExcludedCandidate(value: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.has(value)) return true;
  if (value.length < 5) return false;
  for (const known of excluded) {
    if (known.length < 5 || Math.abs(known.length - value.length) > 2) continue;
    if (levenshteinDistance(value, known) <= 2) return true;
  }
  return false;
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
