import { promises as fs } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomically } from "../recording/atomic-json-file.ts";

export interface TranscriptCorrection {
  readonly from: string;
  readonly to: string;
  readonly createdAt: string;
}

interface CorrectionFile {
  readonly version: 1;
  readonly replacements: readonly TranscriptCorrection[];
}

export async function loadTranscriptCorrections(
  recordingDirectory: string,
): Promise<readonly TranscriptCorrection[]> {
  try {
    const value = JSON.parse(
      await fs.readFile(join(recordingDirectory, "corrections.json"), "utf8"),
    ) as CorrectionFile;
    return value.version === 1 && Array.isArray(value.replacements)
      ? value.replacements
      : [];
  } catch {
    return [];
  }
}

export async function addTranscriptCorrection(
  recordingDirectory: string,
  from: string,
  to: string,
): Promise<TranscriptCorrection> {
  const normalizedFrom = from.trim();
  const normalizedTo = to.trim();
  if (normalizedFrom === "" || normalizedTo === "") {
    throw new TypeError("Correction terms cannot be empty.");
  }
  const correction: TranscriptCorrection = {
    from: normalizedFrom,
    to: normalizedTo,
    createdAt: new Date().toISOString(),
  };
  const replacements = [
    ...(await loadTranscriptCorrections(recordingDirectory)).filter(
      (existing) => existing.from.toLocaleLowerCase("es") !== normalizedFrom.toLocaleLowerCase("es"),
    ),
    correction,
  ];
  const path = join(recordingDirectory, "corrections.json");
  await writeJsonAtomically(path, { version: 1, replacements });
  return correction;
}

export function applyTranscriptCorrections(
  value: string,
  corrections: readonly Pick<TranscriptCorrection, "from" | "to">[],
): string {
  return corrections.reduce(
    (current, correction) =>
      current.replace(
        new RegExp(escapeRegExp(correction.from), "giu"),
        () => correction.to,
      ),
    value,
  );
}

export function countCorrectionMatches(value: string, from: string): number {
  return value.match(new RegExp(escapeRegExp(from.trim()), "giu"))?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
