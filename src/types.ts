export type Agent = "claude" | "codex";
export type Policy = "balanced" | "claude-heavy" | "codex-heavy";
export type ModelTier = "fast" | "balanced" | "deep";
export type Effort = "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type FeedbackRating = "good" | "bad";
export type PhaseKind = "analyze" | "implement" | "test" | "review" | "recover" | "clarify";
export type OrchestrationMode = "auto" | "adaptive" | "single";
export type LogLevel = "compact" | "live" | "verbose";

export interface Rule {
  name: string;
  agent?: Agent;
  modelTier?: ModelTier;
  effort?: Effort;
  pattern: string;
}

export interface ModelProfile {
  model: string;
  effort?: Effort;
}

export interface ProviderConfig {
  command: string;
  args?: string[];
  permissionMode?: "acceptEdits" | "auto" | "manual" | "dontAsk" | "plan";
  allowedModels?: string[];
  models: Record<ModelTier, ModelProfile>;
}

export interface HistoryConfig {
  enabled: boolean;
  learningEnabled: boolean;
  path?: string;
  similarityThreshold: number;
}

export interface LoggingConfig {
  level: LogLevel;
  persist: boolean;
}

export interface OrchestrationConfig {
  mode: OrchestrationMode;
  maxPhases: number;
  autoReview: boolean;
  recoverOnFailure: boolean;
  stopOnFailure: boolean;
  outputTailChars: number;
}

export interface RouterConfig {
  policy: Policy;
  defaultAgent: Agent;
  claude: ProviderConfig;
  codex: ProviderConfig;
  history: HistoryConfig;
  orchestration: OrchestrationConfig;
  logging: LoggingConfig;
  rules: Rule[];
}

export interface ScoreReason {
  agent: Agent;
  points: number;
  reason: string;
}

export interface RouteResult {
  agent: Agent;
  modelTier: ModelTier;
  userRequestedTier?: ModelTier;
  model: string;
  effort: Effort;
  complexity: number;
  claudeScore: number;
  codexScore: number;
  reasons: ScoreReason[];
  modelReasons: string[];
  matchedRule?: string;
}

export interface HistoryRecord {
  id: string;
  runId?: string;
  sessionId?: string;
  parentRunId?: string;
  timestamp: string;
  cwd: string;
  task: string;
  originalTask?: string;
  phaseKind?: PhaseKind;
  phaseIndex?: number;
  agent: Agent;
  modelTier: ModelTier;
  model: string;
  effort: Effort;
  complexity: number;
  exitCode: number;
  durationMs: number;
  outputExcerpt?: string;
  feedback?: FeedbackRating;
  feedbackNote?: string;
}

export interface PhasePlan {
  id: string;
  kind: PhaseKind;
  title: string;
  instruction: string;
  preferredAgent?: Agent;
  preferredTier?: ModelTier;
  preferredEffort?: Effort;
}

export interface PhaseExecution {
  phase: PhasePlan;
  route: RouteResult;
  exitCode: number;
  durationMs: number;
  output: string;
  historyId?: string;
}

export interface AgentRunResult {
  exitCode: number;
  output: string;
  question?: string;
}

export interface SessionTurn {
  turnId: string;
  runId: string;
  timestamp: string;
  userPrompt: string;
  routeSummary: string;
  phaseSummaries: string[];
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  originalTask: string;
  turns: SessionTurn[];
}
