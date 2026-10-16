import { createHash } from "node:crypto";
import { copyFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SaveResult } from "../shared/contracts.js";
import { writeFileAtomically } from "./atomic-file.js";

function parseTranscriptMarkdown(content: string): Array<{
  lineId: string;
  startMs: number;
  endMs: number;
  speakerName: string;
  text: string;
  confidence: null;
}> {
  const marker = content.search(/^##\s+Transcripci[oó]n\s*$/imu);
  if (marker < 0) return [];
  const section = content.slice(marker);
  const matches = [...section.matchAll(/^\[(\d{1,2}):(\d{2}):(\d{2})\]\s+\*\*(.+?):\*\*\s+(.+)$/gmu)];
  return matches.map((match, index) => {
    const startMs = ((Number(match[1]) * 60 * 60) + (Number(match[2]) * 60) + Number(match[3])) * 1_000;
    const next = matches[index + 1];
    const nextMs = next === undefined
      ? startMs + 1_000
      : ((Number(next[1]) * 60 * 60) + (Number(next[2]) * 60) + Number(next[3])) * 1_000;
    return {
      lineId: `MANUAL-${String(index + 1).padStart(6, "0")}`,
      startMs,
      endMs: Math.max(startMs + 1, nextMs),
      speakerName: (match[4] ?? "Voz").trim(),
      text: (match[5] ?? "").trim(),
      confidence: null,
    };
  }).filter((line) => line.text !== "");
}

export async function saveTranscriptRevision(
  transcriptPath: string, sessionId: string, content: string, invalidate: () => Promise<void>,
): Promise<SaveResult> {
  if (content.length > 5_000_000) throw new Error("La bitacora es demasiado grande.");
  const manualLines = parseTranscriptMarkdown(content);
  if (manualLines.length === 0) throw new Error("No se guardó la edición: conserva la sección Transcripción y sus líneas con hora y hablante.");
  await stat(transcriptPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `bitacora.respaldo-${stamp}.md`;
  await copyFile(transcriptPath, join(dirname(transcriptPath), backupName));
  await invalidate();
  await writeFileAtomically(
    join(dirname(transcriptPath), "transcript.manual.json"),
    `${JSON.stringify({
      version: 1,
      sessionId,
      source: "bitacora.md",
      sourceHash: createHash("sha256").update(content, "utf8").digest("hex"),
      updatedAt: new Date().toISOString(),
      lines: manualLines,
    }, null, 2)}\n`,
  );
  await writeFileAtomically(transcriptPath, content);
  return {
    saved: true,
    backupName,
    warning: "Las correcciones se aplicarán a la próxima regeneración del guion.",
  };
}
