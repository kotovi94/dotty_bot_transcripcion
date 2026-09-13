import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readEnvironment } from "../src/config/environment.ts";
import { createDatabaseClient } from "../src/database/client.ts";
import { EditorialLearningService, type EditorialScope } from "../src/editorial/editorial-learning-service.ts";
import { verifyDraft } from "../src/editorial/draft-verifier.ts";
import { refreshNarrativeReview } from "../src/narrative/narrative-review.ts";

const [action, argument] = process.argv.slice(2);
const environment = readEnvironment();
const database = createDatabaseClient(environment.DATABASE_URL);
const service = new EditorialLearningService(database);

try {
  await service.ensureCriticalRules();
  if (action === "state") {
    validateSession(argument);
    output(await service.listState(argument!));
  } else if (action === "submit") {
    const request = await readRequest(argument);
    output(await service.submitFeedback({
      sessionId: String(request.sessionId ?? ""),
      generatedVersion: String(request.generatedVersion ?? ""),
      editedVersion: String(request.editedVersion ?? ""),
      comment: String(request.comment ?? ""),
      ...(typeof request.ownerId === "string" ? { ownerId: request.ownerId } : {}),
    }));
  } else if (action === "decide") {
    const request = await readRequest(argument);
    const decision = String(request.decision ?? "");
    if (!["approve", "reject", "deprecate"].includes(decision)) throw new Error("Decisión editorial inválida.");
    const scope = request.scope === undefined ? undefined : String(request.scope) as EditorialScope;
    if (scope !== undefined && !["session", "campaign", "user", "global"].includes(scope)) throw new Error("Alcance editorial inválido.");
    output(await service.decideRule(String(request.ruleId ?? ""), decision as "approve" | "reject" | "deprecate", scope));
  } else if (action === "rollback") {
    output(await service.rollbackRule(String(argument ?? "")));
  } else if (action === "verify") {
    validateSession(argument);
    const session = await database.session.findUnique({ where: { id: argument! } });
    if (!session) throw new Error("La sesión no existe.");
    const exportDirectory = resolve(environment.DOTTY_DATA_DIR, "exports", argument!);
    const draft = await readFile(join(exportDirectory, "guion.md"), "utf8");
    const evidence = await readFile(join(exportDirectory, "guion.evidencias.json"), "utf8").catch(() => "[]");
    const context = await service.retrieve({ sessionId: argument!, campaignId: session.campaignId, query: draft.slice(0, 2_000) });
    const report = verifyDraft(draft, [evidence], context.rules);
    await writeFile(join(exportDirectory, "guion.verificacion.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await refreshNarrativeReview(exportDirectory, argument!, report);
    output(report);
  } else if (action === "export") {
    const request = await readRequest(argument);
    const target = resolve(String(request.target ?? ""));
    await writeFile(target, await service.exportDataset(typeof request.campaignId === "string" ? request.campaignId : undefined), "utf8");
    output({ ok: true, target });
  } else {
    throw new Error("Acción editorial desconocida.");
  }
} finally {
  await database.$disconnect();
}

async function readRequest(path: string | undefined): Promise<Record<string, unknown>> {
  if (!path) throw new Error("Falta la solicitud editorial.");
  return JSON.parse(await readFile(resolve(path), "utf8")) as Record<string, unknown>;
}
function validateSession(value: string | undefined): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value ?? "")) throw new Error("Sesión inválida.");
}
function output(value: unknown): void { console.log(JSON.stringify({ ok: true, result: value })); }
