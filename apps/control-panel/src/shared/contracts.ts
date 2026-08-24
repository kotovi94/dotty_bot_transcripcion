export type OperationKind = "start" | "stop" | "restart" | "disconnect";
export type LogKind = "bot" | "transcriber" | "lifecycle" | "panel";

export interface QueueState {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface WorkState {
  status: string;
  phase?: string;
  progress?: number;
  session_id?: string;
  session_label?: string;
  session_progress?: number;
  session_total_jobs?: number;
  session_completed_jobs?: number;
  session_failed_jobs?: number;
  started_at?: string;
  processed_audio_seconds?: number;
  audio_duration_seconds?: number;
}

export type MaintenanceAction = "recover-session" | "retry-failed";

export interface RecoveryIssue {
  sessionId: string;
  title: string;
  status: string;
  chunks: number;
  failedJobs: number;
  lastError: string | null;
  canRecover: boolean;
  canRetry: boolean;
}

export interface MaintenanceState {
  checkedAt: string;
  issues: RecoveryIssue[];
}

export interface DottyState {
  timestamp: string;
  bot: {
    running: boolean;
    connected: boolean;
    pid: number | null;
    connectedAt: string | null;
  };
  transcriber: {
    available: boolean;
    model: string | null;
    configuredDevice: string | null;
    activeDevice: string | null;
    computeType: string | null;
    queue: QueueState;
    work: WorkState | null;
  };
  operation: {
    kind: OperationKind;
    startedAt: string;
  } | null;
}

export interface SessionParticipant {
  name: string;
  userId?: string | null;
  source: "database" | "manifest" | "transcript";
}

export interface SessionFiles {
  transcript?: string | null;
  narrative?: string | null;
  manifest?: string | null;
}

export type ProcessingStageStatus = "pending" | "running" | "completed" | "error" | "unknown";

export interface SessionProcessingStatus {
  sessionId: string;
  state: "idle" | "recording" | "transcribing" | "transcript_ready" | "generating_narrative" | "narrative_ready" | "publishing" | "completed" | "error" | "unknown";
  audio: { status: ProcessingStageStatus; details?: string };
  transcription: { status: ProcessingStageStatus; details?: string };
  narrative: { status: ProcessingStageStatus; details?: string };
  publication: { status: ProcessingStageStatus; details?: string };
  updatedAt?: string | null;
}

export interface DottyOperationError {
  source: "discord" | "transcription" | "narrative" | "publication" | "system";
  message: string;
  timestamp?: string;
  sessionId?: string;
  details?: string;
}

export interface OllamaHealth {
  available: boolean;
  modelConfigured: string | null;
  modelsAvailable: string[];
  error: string | null;
}

export interface SystemStatus {
  timestamp: string;
  bot: DottyState["bot"];
  transcriber: DottyState["transcriber"];
  ollama: OllamaHealth;
  lastSession: { id: string; title: string } | null;
}

export interface SessionDetails {
  id: string;
  sequence?: number;
  status?: string;
  campaign?: {
    id: string;
    name: string;
  } | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  participants?: SessionParticipant[];
  files?: SessionFiles;
  processing?: SessionProcessingStatus;
  errors?: DottyOperationError[];
}

export interface TranscriptSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  status: string | null;
  canOpenDiscord: boolean;
  narrativeState: "missing" | "queued" | "generating" | "ready" | "failed";
  narrativeProgress: number;
  narrativePhase: string;
  narrativeError: string | null;
  campaignName?: string | null;
  sequenceNumber?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  participants?: SessionParticipant[];
  processing?: SessionProcessingStatus;
  errors?: DottyOperationError[];
}

export interface TranscriptDetail extends TranscriptSummary {
  content: string;
  narrativeContent: string | null;
}

export interface OperationResult {
  accepted: boolean;
  message: string;
}

export interface SaveResult {
  saved: boolean;
  backupName?: string;
}

export interface NarrativeOperationResult {
  ok: boolean;
  message: string;
}

export type TranscriptionMode = "auto" | "cuda" | "cpu";

export interface SetupConfig {
  discordToken: string;
  keepExistingToken: boolean;
  discordClientId: string;
  discordGuildId: string;
  dataDirectory: string;
  pythonExecutable: string;
  npmExecutable: string;
  transcriptionMode: TranscriptionMode;
  whisperModel: string;
}

export interface SetupStatus {
  configured: boolean;
  hasDiscordToken: boolean;
  discordClientId: string;
  discordGuildId: string;
  dataDirectory: string;
  pythonExecutable: string;
  npmExecutable: string;
  transcriptionMode: TranscriptionMode;
  whisperModel: string;
  gpu: {
    detected: boolean;
    name: string | null;
    driver: string | null;
    cudaRecommended: boolean;
  };
  checks: {
    python: boolean;
    npm: boolean;
    transcriberEnvironment: boolean;
    nodeModules: boolean;
  };
}

export interface SetupResult {
  ok: boolean;
  message: string;
  details?: string[];
}

export type SetupBrowseKind = "python" | "npm" | "data";

export type EditorialScope = "session" | "campaign" | "user" | "global";
export type EditorialRuleStatus = "candidate" | "approved" | "rejected" | "deprecated";

export interface EditorialRuleView {
  id: string;
  scope: EditorialScope;
  category: string;
  text: string;
  priority: number;
  confidence: number;
  status: EditorialRuleStatus;
  occurrences: number;
  version: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface EditorialLearningState {
  rules: EditorialRuleView[];
  candidates: EditorialRuleView[];
  metrics: {
    feedbackCount: number;
    averageEditRatio: number;
    repeatedCorrections: number;
    categoryCounts: Record<string, number>;
  };
}

export interface EditorialFeedbackResult {
  feedbackId: string;
  candidates: EditorialRuleView[];
  diff: {
    changes: Array<{ category: string; severity: string; generatedFragment: string; correctedFragment: string; kind: string }>;
    editRatio: number;
  };
}

export interface DottyDesktopApi {
  getState(): Promise<DottyState>;
  getEditorialLearning(sessionId: string): Promise<EditorialLearningState>;
  submitEditorialFeedback(sessionId: string, comment: string, editedVersion: string): Promise<EditorialFeedbackResult>;
  decideEditorialRule(ruleId: string, decision: "approve" | "reject" | "deprecate", scope?: EditorialScope): Promise<EditorialRuleView>;
  rollbackEditorialRule(ruleId: string): Promise<EditorialRuleView>;

  getSystemStatus(): Promise<SystemStatus>;
  getSessionDetails(sessionId: string): Promise<SessionDetails | null>;
  getSessionProcessingStatus(sessionId: string): Promise<SessionProcessingStatus>;
  onState(callback: (state: DottyState) => void): () => void;
  runOperation(kind: OperationKind): Promise<OperationResult>;
  disconnect(): Promise<OperationResult>;
  restoreBotIcon(): Promise<OperationResult>;
  listTranscripts(): Promise<TranscriptSummary[]>;
  readTranscript(sessionId: string): Promise<TranscriptDetail>;
  saveTranscript(sessionId: string, content: string): Promise<SaveResult>;
  saveNarrative(sessionId: string, content: string): Promise<SaveResult>;
  generateNarrative(sessionId: string): Promise<NarrativeOperationResult>;
  publishNarrative(sessionId: string): Promise<NarrativeOperationResult>;
  openTranscript(sessionId: string): Promise<void>;
  openTranscriptFolder(sessionId: string): Promise<void>;
  openDiscord(sessionId: string): Promise<boolean>;
  openDataFolder(): Promise<void>;
  readLogs(kind: LogKind): Promise<string>;
  getMaintenanceState(): Promise<MaintenanceState>;
  runMaintenanceAction(action: MaintenanceAction, sessionId: string): Promise<OperationResult>;
  getSetupStatus(): Promise<SetupStatus>;
  browseSetupPath(kind: SetupBrowseKind): Promise<string | null>;
  validateDiscord(config: SetupConfig): Promise<SetupResult>;
  saveSetup(config: SetupConfig): Promise<SetupResult>;
  prepareSetup(config: SetupConfig): Promise<SetupResult>;
  openSetupLink(kind: "discord" | "node" | "python" | "cuda"): Promise<void>;
}
