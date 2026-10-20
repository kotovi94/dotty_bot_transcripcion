import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

interface TranscriptLine {
  readonly lineId?: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly speakerName?: string;
  readonly text?: string;
  readonly confidence?: number | null;
}

export interface NarrativeTranscript {
  readonly manifest?: {
    readonly sessionId?: string;
    readonly campaignId?: string;
    readonly campaignName?: string;
    readonly sequenceNumber?: number;
  };
  readonly lines?: readonly TranscriptLine[];
}

function hasText(line: unknown): line is TranscriptLine {
  return line !== null && typeof line === "object"
    && typeof (line as TranscriptLine).text === "string"
    && (line as TranscriptLine).text!.trim() !== "";
}

interface ManualTranscript {
  sessionId?: unknown;
  sourceHash?: unknown;
  lines?: unknown;
}

function parseMarkdown(content: string): TranscriptLine[] {
  const marker = content.search(/^##\s+Transcripci[oó]n\s*$/imu);
  if (marker < 0) return [];
  const matches = [...content.slice(marker).matchAll(/^\[(\d{1,2}):(\d{2}):(\d{2})\]\s+\*\*(.+?):\*\*\s+(.+)$/gmu)];
  return matches.map((match, index) => {
    const startMs = ((Number(match[1]) * 60 * 60) + Number(match[2]) * 60 + Number(match[3])) * 1_000;
    const next = matches[index + 1];
    const nextMs = next
      ? ((Number(next[1]) * 60 * 60) + Number(next[2]) * 60 + Number(next[3])) * 1_000
      : startMs + 1_000;
    return {
      lineId: `MANUAL-${String(index + 1).padStart(6, "0")}`,
      startMs,
      endMs: Math.max(startMs + 1, nextMs),
      speakerName: match[4]?.trim() || "Voz",
      text: match[5]?.trim() || "",
      confidence: null,
    };
  }).filter((line) => line.text);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readNarrativeTranscript(exportDirectory: string, recordingsRoot: string, sessionId: string): Promise<NarrativeTranscript> {
  if (await readOptional(join(recordingsRoot, sessionId, ".transcription-regenerating")) !== null
    && await readOptional(join(recordingsRoot, sessionId, ".transcription-ready")) === null) {
    throw new Error("La transcripción se está rehaciendo desde el audio. Espera al nuevo raw antes de generar el guion.");
  }
  const [rawText, manualText, markdown, manifestText] = await Promise.all([
    readOptional(join(exportDirectory, "transcript.raw.json")),
    readOptional(join(exportDirectory, "transcript.manual.json")),
    readOptional(join(exportDirectory, "bitacora.md")),
    readOptional(join(recordingsRoot, sessionId, "manifest.json")),
  ]);

  let raw: NarrativeTranscript | null = null;
  if (rawText !== null) {
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as NarrativeTranscript).lines)) {
        raw = parsed as NarrativeTranscript;
      }
    } catch {
      // La bitácora aún puede recuperar una exportación RAW dañada.
    }
  }

  let manifest: NarrativeTranscript["manifest"] = raw?.manifest;
  if (!manifest && manifestText !== null) {
    try {
      manifest = JSON.parse(manifestText) as NarrativeTranscript["manifest"];
    } catch {
      // Los datos de campaña son opcionales para leer la transcripción.
    }
  }

  let manual: ManualTranscript | null = null;
  if (manualText !== null) {
    try {
      manual = JSON.parse(manualText) as ManualTranscript;
    } catch {
      // Una edición incompleta se reconstruye desde la bitácora.
    }
  }

  if (manual?.sessionId === sessionId && Array.isArray(manual.lines) && manual.lines.some(hasText)) {
    if (markdown === null || typeof manual.sourceHash !== "string"
      || createHash("sha256").update(markdown, "utf8").digest("hex") === manual.sourceHash) {
      return { ...(manifest ? { manifest } : {}), lines: manual.lines.filter(hasText) };
    }
    // La bitácora puede haber cambiado después de guardar la edición manual.
    // Sus líneas actuales tienen prioridad sobre el archivo manual obsoleto.
    const currentLines = markdown === null ? [] : parseMarkdown(markdown);
    if (currentLines.length > 0) return { ...(manifest ? { manifest } : {}), lines: currentLines };
    throw new Error("La edición de transcripción no coincide con la bitácora actual. Abre y guarda la transcripción para corregirla.");
  }

  if (manualText !== null && markdown !== null) {
    const currentLines = parseMarkdown(markdown);
    if (currentLines.length > 0) return { ...(manifest ? { manifest } : {}), lines: currentLines };
  }
  if (raw && raw.lines?.some(hasText)) return { ...raw, lines: raw.lines.filter(hasText) };

  const markdownLines = markdown === null ? [] : parseMarkdown(markdown);
  if (markdownLines.length > 0) return { ...(manifest ? { manifest } : {}), lines: markdownLines };
  if (markdown !== null) throw new Error("La bitácora no contiene líneas válidas en la sección Transcripción. Revisa su formato antes de generar el guion.");
  throw new Error("La sesión todavía no tiene una transcripción exportada. Espera a que termine la transcripción y vuelve a intentar.");
}
