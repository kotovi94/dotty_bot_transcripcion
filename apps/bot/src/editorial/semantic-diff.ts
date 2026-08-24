export type EditorialCategory = "factualidad" | "canon" | "personajes" | "dialogo" | "estructura" | "tono" | "estilo" | "ritmo" | "nombres" | "otro";
export interface SemanticChange { category: EditorialCategory; severity: "low" | "medium" | "high"; generatedFragment: string; correctedFragment: string; kind: "added" | "removed" | "rewritten"; }
export interface SemanticDiff { changes: SemanticChange[]; addedCharacters: number; removedCharacters: number; editRatio: number; }

export function normalizeEditorialText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

export function analyzeSemanticDiff(generated: string, edited: string): SemanticDiff {
  if (generated === edited) return { changes: [], addedCharacters: 0, removedCharacters: 0, editRatio: 0 };
  const before = chunks(generated);
  const after = chunks(edited);
  const beforeMap = new Map(before.map((text) => [normalizeEditorialText(text), text]));
  const afterMap = new Map(after.map((text) => [normalizeEditorialText(text), text]));
  const removed = before.filter((text) => !afterMap.has(normalizeEditorialText(text)));
  const added = after.filter((text) => !beforeMap.has(normalizeEditorialText(text)));
  const changes: SemanticChange[] = [];
  const count = Math.max(removed.length, added.length);
  for (let index = 0; index < count; index += 1) {
    const oldText = removed[index] ?? "";
    const newText = added[index] ?? "";
    if (oldText === "" && newText === "") continue;
    const category = classifyChange(oldText, newText);
    changes.push({
      category,
      severity: severity(category, oldText, newText),
      generatedFragment: oldText.slice(0, 600),
      correctedFragment: newText.slice(0, 600),
      kind: oldText === "" ? "added" : newText === "" ? "removed" : "rewritten",
    });
  }
  const commonPrefix = sharedPrefix(generated, edited);
  const commonSuffix = sharedSuffix(generated.slice(commonPrefix), edited.slice(commonPrefix));
  const removedCharacters = Math.max(0, generated.length - commonPrefix - commonSuffix);
  const addedCharacters = Math.max(0, edited.length - commonPrefix - commonSuffix);
  return { changes, addedCharacters, removedCharacters, editRatio: Math.min(1, (addedCharacters + removedCharacters) / Math.max(1, generated.length + edited.length)) };
}

export function classifyChange(...parts: string[]): EditorialCategory {
  const value = normalizeEditorialText(parts.join(" "));
  if (/invento|inventad|evidencia|falso|no ocurr|hecho|respald/.test(value)) return "factualidad";
  if (/canon|continuidad|campana|historia previa/.test(value)) return "canon";
  if (/emocion|intencion|pensamiento|motivacion|personaje|pnj/.test(value)) return "personajes";
  if (/dialog|dijo|cita|hablo|voz/.test(value)) return "dialogo";
  if (/orden|escena|estructura|cronolog|seccion|titulo/.test(value)) return "estructura";
  if (/tono|dramatic|epic|sobri|humor|oscuro/.test(value)) return "tono";
  if (/ritmo|breve|largo|repet|agil|pausa/.test(value)) return "ritmo";
  if (/nombre|apodo|termino|ortograf/.test(value)) return "nombres";
  if (/estilo|prosa|adjetiv|metafor|descripcion/.test(value)) return "estilo";
  return "otro";
}

function chunks(value: string): string[] {
  return value.split(/\n{2,}|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ#*])/u).map((item) => item.trim()).filter((item) => item.length >= 12);
}
function severity(category: EditorialCategory, oldText: string, newText: string): "low" | "medium" | "high" {
  if (["factualidad", "canon", "personajes", "dialogo"].includes(category)) return "high";
  return Math.abs(oldText.length - newText.length) > 300 ? "medium" : "low";
}
function sharedPrefix(a: string, b: string): number { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; }
function sharedSuffix(a: string, b: string): number { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1; return i; }
