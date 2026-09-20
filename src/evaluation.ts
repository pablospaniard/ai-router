import type {
  HistoryRecord,
  PhaseKind,
  RouteEvaluation,
  RouteOutcome,
  TaskCategory,
  TaskFeatures,
  TokenUsage,
} from "./types.js";

const FAILURE =
  /(?:^|\n)\s*(?:status:\s*)?(?:failed|unresolved|unable to complete|could not complete)\b/im;
const VERIFIED =
  /\b(?:all\s+)?(?:tests?|checks?|build|lint|typecheck)\s+(?:passed|succeeded|completed)|\b0\s+(?:failures?|errors?)\b/i;
const UNVERIFIED =
  /\b(?:not|wasn't|were not|couldn't|unable to)\s+(?:run|verify|test)|\bnot\s+verified\b/i;
const REGRESSION =
  /\b(?:regression|introduced (?:an? )?(?:bug|issue)|critical issue|test failure)\b/i;

export function tokenCount(usage?: TokenUsage): number | undefined {
  if (!usage) return undefined;
  return (
    usage.uncachedInputTokens +
    usage.cachedInputTokens +
    usage.cacheWriteInputTokens +
    usage.outputTokens
  );
}

export function evaluateRoute(
  output: string,
  exitCode: number,
  phaseKind: PhaseKind | undefined,
  options: { retries?: number; recoveries?: number; durationMs: number; usage?: TokenUsage },
): { evaluation: RouteEvaluation; outcome: RouteOutcome } {
  const signals: string[] = [];
  const failed = exitCode !== 0 || FAILURE.test(output);
  const verificationClaim = VERIFIED.test(output);
  const unverified = UNVERIFIED.test(output);
  const verified = !failed && !unverified && (verificationClaim || phaseKind === "test");
  const regressions = REGRESSION.test(output) && phaseKind === "review" ? 1 : 0;
  if (exitCode === 0) signals.push("provider exited successfully");
  else signals.push(`provider exited with code ${exitCode}`);
  if (verificationClaim) signals.push("output reports passing verification");
  if (unverified) signals.push("output reports missing verification");
  if (regressions) signals.push("review reports a possible regression");
  const completion = failed ? 0 : 1;
  const verification = verified ? 1 : unverified ? 0 : 0.5;
  const confidence = Math.min(
    1,
    0.45 + (verificationClaim ? 0.35 : 0) + (exitCode !== 0 ? 0.2 : 0),
  );
  const quality = Math.max(
    0,
    Math.min(1, completion * 0.55 + verification * 0.35 - regressions * 0.25 + 0.1),
  );
  return {
    evaluation: { taskSatisfied: !failed, verified, quality, confidence, signals },
    outcome: {
      completion,
      verification,
      retries: options.retries ?? 0,
      recoveries: options.recoveries ?? 0,
      regressions,
      durationMs: options.durationMs,
      tokens: tokenCount(options.usage),
      confidence,
    },
  };
}

const CATEGORY: Array<[TaskCategory, RegExp]> = [
  ["debug", /\b(?:bug|fix|debug|failure|broken|error|regression|root cause|flaky)\b/i],
  ["review", /\b(?:review|audit|inspect|pull request|\bpr\b)\b/i],
  ["test", /\b(?:test|validate|verify|lint|typecheck|build)\b/i],
  ["research", /\b(?:research|investigate|compare|explain|analyze|architecture)\b/i],
  ["implement", /\b(?:implement|add|create|build|change|refactor|migrate)\b/i],
];

const LANGUAGES: Array<[string, RegExp]> = [
  ["typescript", /\b(?:typescript|tsx?|node(?:\.js)?)\b/i],
  ["javascript", /\b(?:javascript|jsx?)\b/i],
  ["python", /\b(?:python|django|flask|pytest)\b/i],
  ["rust", /\b(?:rust|cargo)\b/i],
  ["go", /\b(?:golang|go\s+(?:code|module|test))\b/i],
  ["swift", /\b(?:swift|swiftui|ios)\b/i],
];

const SYNONYMS: Record<string, string> = {
  flaky: "intermittent",
  concurrency: "race",
  concurrent: "race",
  investigate: "analyze",
  inspect: "review",
  repair: "fix",
  failure: "error",
  failing: "error",
  implement: "build",
  create: "build",
};

function normalizedTokens(task: string): string[] {
  return (task.toLowerCase().match(/[a-z0-9_+#.-]{2,}/g) ?? [])
    .map((token) => SYNONYMS[token] ?? token)
    .filter(
      (token) => !new Set(["the", "and", "for", "with", "this", "that", "please"]).has(token),
    );
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

function embedding(tokens: string[], dimensions = 64): number[] {
  const vector = Array<number>(dimensions).fill(0);
  const features = [
    ...tokens,
    ...tokens.slice(1).map((token, index) => `${tokens[index]}_${token}`),
  ];
  for (const feature of features) {
    const value = hash(feature);
    vector[value % dimensions] += value & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function extractTaskFeatures(task: string, complexity = 2): TaskFeatures {
  const tokens = normalizedTokens(task);
  return {
    category: CATEGORY.find(([, pattern]) => pattern.test(task))?.[0] ?? "general",
    language: LANGUAGES.find(([, pattern]) => pattern.test(task))?.[0],
    risk: /\b(?:production|security|critical|data loss|outage|payment|auth)\b/i.test(task)
      ? "high"
      : /\b(?:migration|database|api|breaking|concurrency)\b/i.test(task)
        ? "medium"
        : "low",
    complexity,
    tokens: [...new Set(tokens)].slice(0, 80),
    embedding: embedding(tokens),
  };
}

export function enrichHistoryRecord(
  record: HistoryRecord,
  phaseKind = record.phaseKind,
): HistoryRecord {
  const result = evaluateRoute(record.outputExcerpt ?? "", record.exitCode, phaseKind, {
    durationMs: record.durationMs,
    usage: record.usage,
  });
  return {
    ...record,
    taskFeatures:
      record.taskFeatures ??
      extractTaskFeatures(record.originalTask ?? record.task, record.complexity),
    evaluation: record.evaluation ?? result.evaluation,
    outcome: record.outcome ?? result.outcome,
  };
}
