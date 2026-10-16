import {
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  FileText,
  FolderOpen,
  Pencil,
  Save,
  Send,
  RotateCcw,
  ShieldCheck,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";

import type { EditorialLearningState, EditorialScope, SessionDetails, TranscriptDetail } from "../../shared/contracts";

export type SessionDetailTab = "summary" | "transcript" | "log" | "narrative" | "files" | "errors";

interface SessionDetailPanelProps {
  selected: TranscriptDetail | null;
  sessionDetails: SessionDetails | null;
  detailTab: SessionDetailTab;
  onSelectTab: (tab: SessionDetailTab) => void;
  readerMode: "narrative" | "transcript";
  editing: boolean;
  draft: string;
  setDraft: (value: string) => void;
  setEditing: (value: boolean) => void;
  narrativeBusy: "generate" | "verify" | "approve" | "publish" | null;
  reviewSceneBusy: string | null;
  editorialState: EditorialLearningState | null;
  editorialComment: string;
  setEditorialComment: (value: string) => void;
  editorialBusy: boolean;
  onSaveEditorialLearning: () => void;
  onDecideEditorialRule: (ruleId: string, decision: "approve" | "reject" | "deprecate", scope?: EditorialScope) => void;
  onRollbackEditorialRule: (ruleId: string) => void;
  onGenerateNarrative: () => void;
  onVerifyNarrative: () => void;
  onApproveNarrative: () => void;
  onApproveNarrativeScene: (sceneId: string) => void;
  onPublishNarrative: () => void;
  onSwitchReaderMode: (mode: "narrative" | "transcript") => void;
  onSaveCurrentDocument: () => void;
  onOpenTranscriptFolder: () => void;
  onOpenDiscord: () => void;
  onCopyText: () => void;
  transcriptSearch: string;
  speakerFilter: string;
  onTranscriptSearchChange: (value: string) => void;
  onSpeakerFilterChange: (value: string) => void;
  speakers: string[];
}

function formatValue(value: string | null | undefined) {
  return value && value.trim() ? value : "No disponible";
}

function reviewLabel(state: TranscriptDetail["narrativeReviewState"]): string {
  if (state === "APPROVED") return "Aprobado";
  if (state === "READY_FOR_REVIEW") return "Listo para aprobar";
  if (state === "NEEDS_REVIEW") return "Revisión necesaria";
  return "Sin verificar";
}

function reviewDescription(state: TranscriptDetail["narrativeReviewState"], pending: number): string {
  if (state === "APPROVED") return "El contenido está aprobado y puede publicarse en Discord.";
  if (state === "READY_FOR_REVIEW") return "Pasó los controles automáticos. Revisa los hechos, nombres y cantidades con la transcripción o el audio antes de aprobar: la verificación no garantiza fidelidad.";
  if (state === "NEEDS_REVIEW") return `${pending} ${pending === 1 ? "escena requiere" : "escenas requieren"} corrección o revisión antes de aprobar.`;
  return "Ejecuta la verificación editorial para preparar el guion.";
}

function parseTranscriptEntries(content: string) {
  const raw = content ?? "";
  const sectionStart = raw.search(/^##\s+Transcripci[oó]n\s*$/imu);
  const transcriptSection = sectionStart >= 0 ? raw.slice(sectionStart) : raw;
  const markdownPattern = /^\[(\d{1,2}:\d{2}:\d{2})\]\s+\*\*(.+?):\*\*\s+(.+)$/gmu;
  const markdownMatches = [...transcriptSection.matchAll(markdownPattern)];
  if (markdownMatches.length > 0) {
    return markdownMatches.map((match) => ({
      timestamp: match[1] ?? "",
      speaker: (match[2] ?? "Voz").trim(),
      text: (match[3] ?? "").trim(),
    })).filter((entry) => entry.text.length > 0 && entry.speaker.length > 0);
  }
  const pattern = /(\d{1,2}:\d{2}:\d{2})\s*\n\s*([A-Z0-9 _.-]+)\s*\n([\s\S]*?)(?=(?:\n\s*\d{1,2}:\d{2}:\d{2}\s*\n)|$)/g;
  const matches = [...raw.matchAll(pattern)];
  if (matches.length > 0) {
    return matches.map(([_, timestamp, speaker, text]) => ({
      timestamp,
      speaker: (speaker ?? "").trim(),
      text: (text ?? "").replace(/^\s+|\s+$/g, "").trim(),
    })).filter((entry) => entry.text.length > 0 && entry.speaker.length > 0);
  }

  const paragraphs = raw.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return paragraphs.map((paragraph) => ({
    timestamp: "",
    speaker: "Narración",
    text: paragraph,
  }));
}

export function SessionDetailPanel({
  selected,
  sessionDetails,
  detailTab,
  onSelectTab,
  readerMode,
  editing,
  draft,
  setDraft,
  setEditing,
  narrativeBusy,
  reviewSceneBusy,
  editorialState,
  editorialComment,
  setEditorialComment,
  editorialBusy,
  onSaveEditorialLearning,
  onDecideEditorialRule,
  onRollbackEditorialRule,
  onGenerateNarrative,
  onVerifyNarrative,
  onApproveNarrative,
  onApproveNarrativeScene,
  onPublishNarrative,
  onSwitchReaderMode,
  onSaveCurrentDocument,
  onOpenTranscriptFolder,
  onOpenDiscord,
  onCopyText,
  transcriptSearch,
  speakerFilter,
  onTranscriptSearchChange,
  onSpeakerFilterChange,
  speakers,
}: SessionDetailPanelProps) {
  const transcriptEntries = useMemo(() => parseTranscriptEntries(selected?.content ?? ""), [selected]);

  const filteredEntries = useMemo(() => {
    const query = transcriptSearch.trim().toLocaleLowerCase("es");
    return transcriptEntries.filter((entry) => {
      const matchesSpeaker = speakerFilter === "all" || entry.speaker === speakerFilter;
      if (!matchesSpeaker) return false;
      if (!query) return true;
      const haystack = `${entry.timestamp} ${entry.speaker} ${entry.text}`.toLocaleLowerCase("es");
      return haystack.includes(query);
    });
  }, [speakerFilter, transcriptEntries, transcriptSearch]);

  if (!selected) {
    return (
      <div className="empty-reader">
        <BookOpen size={38} />
        <strong>Selecciona una sesión</strong>
        <span>Aquí verás la información real de la campaña y la transcripción.</span>
      </div>
    );
  }

  const narrativeAvailable = selected.narrativeContent !== null;
  const review = selected.narrativeReview;
  const pendingScenes = review?.scenes.filter((scene) => scene.status === "NEEDS_REVIEW").length ?? 0;
  const approvedScenes = review?.scenes.filter((scene) => scene.status === "APPROVED").length ?? 0;
  const reviewStateClass = review?.state === "APPROVED" ? "approved" : review?.state === "READY_FOR_REVIEW" ? "ready" : "blocked";

  const detailTabs: SessionDetailTab[] = ["summary", "transcript", "log", "narrative", "files"]; 
  if (selected.narrativeError) detailTabs.push("errors");
  const durationLabel = sessionDetails?.durationSeconds !== undefined && sessionDetails.durationSeconds !== null
    ? `${Math.floor(sessionDetails.durationSeconds / 60)}m ${sessionDetails.durationSeconds % 60}s`
    : "No disponible";
  const campaignName = sessionDetails?.campaign?.name ?? selected?.campaignName ?? "No disponible";
  const participantsLabel = sessionDetails?.participants && sessionDetails.participants.length > 0
    ? sessionDetails.participants.map((participant) => participant.name).join(", ")
    : "No disponible";

  return (
    <div className="detail-shell">
      <div className="reader-toolbar detail-toolbar">
        <div>
          <span className="eyebrow">SESIÓN</span>
          <h2>{selected.title}</h2>
          <small>{selected.status ? `Estado: ${selected.status}` : "Estado no disponible"}</small>
        </div>

        <div className="reader-actions">
          {editing ? (
            <>
              <button onClick={() => { setEditing(false); setDraft(detailTab === "narrative" ? selected.narrativeContent ?? "" : selected.content); }}>
                <X size={17} /> Cancelar
              </button>
              <button className="primary" onClick={onSaveCurrentDocument}>
                <Save size={17} /> Guardar
              </button>
              {detailTab === "narrative" && <button onClick={onSaveEditorialLearning} disabled={editorialBusy || (editorialComment.trim() === "" && draft.trim() === (selected.narrativeContent ?? "").trim())}><Brain size={17} /> Guardar corrección para aprender</button>}
            </>
          ) : (
            <>
              {detailTab === "narrative" && (
                <div className="reader-action-group workflow-actions">
                  <button disabled={narrativeBusy !== null || reviewSceneBusy !== null} onClick={onGenerateNarrative} title="Crear nuevamente el guion desde la transcripción">
                    <WandSparkles size={17} /> {narrativeBusy === "generate" ? "Generando..." : narrativeAvailable ? "Regenerar guion" : "Generar guion"}
                  </button>
                  <button disabled={narrativeBusy !== null || reviewSceneBusy !== null || !narrativeAvailable} onClick={onVerifyNarrative}>
                    <ClipboardCheck size={17} /> {narrativeBusy === "verify" ? "Verificando..." : "Verificar"}
                  </button>
                  <button disabled={narrativeBusy !== null || reviewSceneBusy !== null || review?.state !== "READY_FOR_REVIEW"} onClick={onApproveNarrative}>
                    <ShieldCheck size={17} /> {narrativeBusy === "approve" ? "Aprobando..." : "Aprobar"}
                  </button>
                  <button disabled={narrativeBusy !== null || reviewSceneBusy !== null || review?.state !== "APPROVED"} className="primary" onClick={onPublishNarrative}>
                    <Send size={17} /> {narrativeBusy === "publish" ? "Publicando..." : selected.canOpenDiscord ? "Actualizar Discord" : "Publicar"}
                  </button>
                </div>
              )}
              <div className="reader-action-group utility-actions">
                {(detailTab === "transcript" || detailTab === "log" || detailTab === "narrative") && (
                  <button onClick={() => { if (detailTab === "narrative") onSwitchReaderMode("narrative"); setEditing(true); }}>
                    <Pencil size={17} /> Editar
                  </button>
                )}
                <button onClick={onCopyText} title="Copiar contenido actual"><Copy size={17} /> Copiar</button>
                <button onClick={onOpenTranscriptFolder} title="Abrir carpeta"><FolderOpen size={17} /></button>
                {selected.canOpenDiscord && <button onClick={onOpenDiscord}>Discord</button>}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="detail-tabs">
        {detailTabs.map((tab) => (
          <button key={tab} className={detailTab === tab ? "active" : ""} onClick={() => onSelectTab(tab)}>
            {tab === "summary" ? "Resumen" : tab === "transcript" ? "Transcripción" : tab === "log" ? "Bitácora" : tab === "narrative" ? "Guion" : tab === "files" ? "Archivos" : "Errores"}
          </button>
        ))}
      </div>

      {editing ? (
        <textarea className="editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck />
      ) : (
        <>
          {detailTab === "summary" && (
            <div className="detail-content summary-grid">
              <div className="summary-card"><span>Campaña</span><strong>{formatValue(campaignName)}</strong></div>
              <div className="summary-card"><span>Número</span><strong>{selected.sequenceNumber ?? "No disponible"}</strong></div>
              <div className="summary-card"><span>Estado</span><strong>{formatValue(selected.status)}</strong></div>
              <div className="summary-card"><span>Duración</span><strong>{durationLabel}</strong></div>
              <div className="summary-card"><span>Participantes</span><strong>{participantsLabel}</strong></div>
              <div className="summary-card"><span>Última actualización</span><strong>{formatValue(new Date(selected.updatedAt).toLocaleString("es-ES"))}</strong></div>
              <div className="summary-card"><span>Transcripción</span><strong>{selected.content ? "Disponible" : "No disponible"}</strong></div>
              <div className="summary-card"><span>Guion</span><strong>{selected.narrativeContent ? reviewLabel(selected.narrativeReviewState) : selected.narrativeState === "failed" ? "Error" : selected.narrativeState === "generating" ? "Procesando" : selected.narrativeState === "queued" ? "Pendiente" : "No disponible"}</strong></div>
              <div className="summary-card"><span>Publicación</span><strong>{selected.canOpenDiscord ? "Disponible en Discord" : "No disponible"}</strong></div>
              <div className="summary-card"><span>Error</span><strong>{selected.narrativeError ?? "Sin errores detectados"}</strong></div>
            </div>
          )}

          {detailTab === "transcript" && (
            <div className="detail-content transcript-reader">
              <div className="transcript-toolbar-inline">
                <input value={transcriptSearch} onChange={(event) => onTranscriptSearchChange(event.target.value)} placeholder="Buscar texto o speaker..." />
                <select value={speakerFilter} onChange={(event) => onSpeakerFilterChange(event.target.value)}>
                  <option value="all">Todos los speakers</option>
                  {speakers.map((speaker) => <option key={speaker} value={speaker}>{speaker}</option>)}
                </select>
              </div>

              {filteredEntries.length > 0 ? (
                <div className="transcript-entries">
                  {filteredEntries.map((entry, index) => (
                    <div key={`${entry.timestamp}-${entry.speaker}-${index}`} className="transcript-entry">
                      {entry.timestamp && <div className="transcript-meta">{entry.timestamp}</div>}
                      <div className="transcript-speaker">{entry.speaker}</div>
                      <div className="transcript-text">{entry.text}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-reader compact-empty">
                  <FileText size={28} />
                  <strong>No hay coincidencias</strong>
                  <span>Prueba otra búsqueda o cambia el filtro de speaker.</span>
                </div>
              )}
            </div>
          )}

          {detailTab === "log" && (
            <div className="detail-content markdown-reader">
              <ReactMarkdown skipHtml>{selected.content}</ReactMarkdown>
            </div>
          )}

          {detailTab === "narrative" && (
            <div className="detail-content narrative-stack">
              {narrativeAvailable && (
                <section className={`review-overview ${reviewStateClass}`}>
                  <div className="review-overview-icon">
                    {review?.state === "APPROVED" ? <CheckCircle2 size={24} /> : review?.state === "READY_FOR_REVIEW" ? <ShieldCheck size={24} /> : <AlertTriangle size={24} />}
                  </div>
                  <div className="review-overview-copy">
                    <span className="eyebrow">REVISIÓN DEL GUION</span>
                    <h3>{reviewLabel(review?.state ?? null)}</h3>
                    <p>{reviewDescription(review?.state ?? null, pendingScenes)}</p>
                  </div>
                  <div className="review-overview-metrics">
                    <span><strong>{review?.scenes.length ?? 0}</strong> escenas</span>
                    <span><strong>{pendingScenes}</strong> pendientes</span>
                    <span><strong>{approvedScenes}</strong> revisadas</span>
                  </div>
                </section>
              )}
              <div className="markdown-reader narrative-document"><ReactMarkdown skipHtml>{selected.narrativeContent ?? "El guion todavía no se ha generado."}</ReactMarkdown></div>
              {narrativeAvailable && (
                <section className="scene-review-panel">
                  <div className="scene-review-heading">
                    <div><span className="eyebrow">CONTROL DE CALIDAD</span><h3>Revisión por escenas</h3></div>
                    <span>{review ? `${review.scenes.length - pendingScenes}/${review.scenes.length} resueltas` : "Sin verificar"}</span>
                  </div>
                  {!review ? (
                    <div className="review-empty"><ClipboardCheck size={22} /><div><strong>Aún no hay una revisión editorial</strong><span>Usa Verificar para analizar el guion y habilitar su aprobación.</span></div></div>
                  ) : (
                    <div className="scene-review-list">
                      {review.scenes.map((scene) => (
                        <details key={scene.id} className={`scene-review-item ${scene.status.toLocaleLowerCase("es")}`}>
                          <summary>
                            <span className="scene-status-icon">{scene.status === "APPROVED" ? <CheckCircle2 size={17} /> : scene.status === "NEEDS_REVIEW" ? <AlertTriangle size={17} /> : <ClipboardCheck size={17} />}</span>
                            <span className="scene-title"><strong>{scene.title}</strong><small>{scene.evidenceIds.length} evidencias · {scene.errorCount} errores · {scene.warningCount} avisos</small></span>
                            <span className="scene-status-label">{scene.status === "APPROVED" ? "Revisada" : scene.status === "NEEDS_REVIEW" ? "Pendiente" : "Generada"}</span>
                          </summary>
                          <div className="scene-review-body">
                            {scene.reviewReason && <div className="scene-review-reason"><strong>Motivo técnico</strong><span>{scene.reviewReason.replaceAll("_", " ")}</span></div>}
                            {scene.blockers.length > 0 && <div className="scene-blockers"><strong>Bloqueos automáticos</strong>{scene.blockers.map((blocker) => <div key={blocker.code}><span>{blocker.code.replaceAll("_", " ")}</span><p>{blocker.message}</p></div>)}</div>}
                            {scene.issues.length > 0 ? (
                              <div className="scene-issues">{scene.issues.map((issue, index) => <article key={`${scene.id}-${index}`} className={issue.severity}><span>{issue.severity === "error" ? "Error" : "Aviso"}{issue.type ? ` · ${issue.type.replaceAll("_", " ")}` : ""}</span><p>{issue.reason}</p>{issue.sceneText && <blockquote>{issue.sceneText}</blockquote>}</article>)}</div>
                            ) : scene.status === "NEEDS_REVIEW" ? (
                              <p className="scene-review-note">La auditoría no devolvió detalles estructurados o faltan evidencias trazables. Comprueba esta escena en el guion antes de aceptarla.</p>
                            ) : null}
                            {scene.status === "NEEDS_REVIEW" && !scene.blockers.some((blocker) => blocker.code === "EMPTY_SCENE" || blocker.code === "MODEL_META_CONTAMINATION") && <button className="review-scene-button" disabled={reviewSceneBusy !== null || narrativeBusy !== null} onClick={() => onApproveNarrativeScene(scene.id)}><CheckCircle2 size={15} /> {reviewSceneBusy === scene.id ? "Guardando..." : scene.blockers.length > 0 ? "Aceptar con revisión humana" : "Aceptar revisión editorial"}</button>}
                            {scene.status === "NEEDS_REVIEW" && scene.blockers.some((blocker) => blocker.code === "EMPTY_SCENE" || blocker.code === "MODEL_META_CONTAMINATION") && <p className="scene-regeneration-note"><AlertTriangle size={15} /> Edita y guarda el guion para revisarlo como versión manual, o regenera el guion completo.</p>}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {narrativeAvailable && <details className="editorial-learning">
                <summary className="editorial-heading"><div><span className="eyebrow">APRENDIZAJE EDITORIAL</span><h3>Mejorar los próximos guiones</h3></div><span className="editorial-metric">{editorialState?.metrics.feedbackCount ?? 0} revisiones</span></summary>
                <div className="editorial-learning-content">
                <textarea value={editorialComment} onChange={(event) => setEditorialComment(event.target.value)} placeholder="Indica qué debe corregir Dotty la próxima vez. La propuesta no se aplicará hasta que elijas su alcance." maxLength={4000} disabled={editorialBusy} />
                <div className="editorial-actions"><button onClick={() => { if (detailTab === "narrative") onSwitchReaderMode("narrative"); setEditing(true); }} disabled={editorialBusy}><Pencil size={15} /> Corregir guion</button><button className="primary" onClick={onSaveEditorialLearning} disabled={editorialBusy || (editorialComment.trim() === "" && draft.trim() === (selected.narrativeContent ?? "").trim())}><Brain size={15} /> {editorialBusy ? "Procesando..." : "Guardar aprendizaje"}</button></div>
                {(editorialState?.candidates.length ?? 0) > 0 && <div className="editorial-candidates"><strong>Propuestas pendientes</strong>{editorialState!.candidates.map((rule) => <article key={rule.id} className="editorial-rule candidate"><div><span>{rule.category} · repetida {rule.occurrences} vez/veces</span><p>{rule.text}</p></div><div className="editorial-rule-actions"><button onClick={() => onDecideEditorialRule(rule.id, "approve", "session")} disabled={editorialBusy}>Solo esta vez</button><button onClick={() => onDecideEditorialRule(rule.id, "approve", "campaign")} disabled={editorialBusy}>Campaña</button><button onClick={() => onDecideEditorialRule(rule.id, "approve", "global")} disabled={editorialBusy}>Global</button><button onClick={() => onDecideEditorialRule(rule.id, "reject")} disabled={editorialBusy}><Trash2 size={14} /> Descartar</button></div></article>)}</div>}
                {(editorialState?.rules.filter((rule) => rule.status === "approved" && rule.source !== "system_seed").length ?? 0) > 0 && <details className="editorial-history"><summary>Reglas aprendidas activas</summary>{editorialState!.rules.filter((rule) => rule.status === "approved" && rule.source !== "system_seed").map((rule) => <article key={rule.id} className="editorial-rule"><div><span>{rule.scope} · {rule.category} · v{rule.version}</span><p>{rule.text}</p></div><button onClick={() => onRollbackEditorialRule(rule.id)} disabled={editorialBusy}><RotateCcw size={14} /> Revertir</button></article>)}</details>}
                </div>
              </details>}
            </div>
          )}

          {detailTab === "files" && (
            <div className="detail-content file-grid">
              <div className="file-item"><span>Bitácora</span><strong>{selected.content ? "Disponible" : "No disponible"}</strong><button onClick={onOpenTranscriptFolder}><FolderOpen size={15} /> Abrir carpeta</button></div>
              <div className="file-item"><span>Guion</span><strong>{narrativeAvailable ? "Disponible" : "Pendiente"}</strong><button onClick={onOpenTranscriptFolder}><FolderOpen size={15} /> Abrir carpeta</button></div>
              <div className="file-item"><span>Discord</span><strong>{selected.canOpenDiscord ? "Hilo disponible" : "No disponible"}</strong>{selected.canOpenDiscord && <button onClick={onOpenDiscord}>Abrir Discord</button>}</div>
            </div>
          )}

          {detailTab === "errors" && (
            <div className="detail-content error-panel">
              <h3>Último error</h3>
              <p>{selected.narrativeError ?? "No hay errores registrados para esta sesión."}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
