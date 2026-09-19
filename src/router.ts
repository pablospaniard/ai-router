import { learningHints } from "./history.js";
import type { Agent, Effort, ModelTier, RouteResult, RouterConfig, ScoreReason } from "./types.js";

const CLAUDE_SIGNALS: Array<[RegExp, number, string]> = [
  [/\b(root cause|investigat(e|ion)|diagnos(e|is)|why does|why is|unknown bug)\b/i, 4, "investigation/root-cause task"],
  [/\b(architecture|architectural|design|trade-?off|strategy)\b/i, 4, "architecture/design reasoning"],
  [/\b(race condition|deadlock|concurrency|intermittent|flaky|occasionally|nondeterministic)\b/i, 5, "hard-to-reproduce/concurrency issue"],
  [/\b(legacy|migration|migrate|cross[- ]module|cross[- ]cutting)\b/i, 3, "migration or cross-cutting change"],
  [/\b(large refactor|major refactor|re-?architect|rewrite)\b/i, 4, "large refactor"],
  [/\b(ios|android|xcode|gradle|swift|objective-c|kotlin|jni)\b/i, 2, "native/mobile context"],
  [/\b(performance|memory leak|profil(e|ing)|security|vulnerability)\b/i, 3, "performance/security investigation"],
  [/\b(analyze|analyse|explore|understand|audit|review architecture)\b/i, 2, "repo exploration/review"]
];

const CODEX_SIGNALS: Array<[RegExp, number, string]> = [
  [/\b(implement|add|create|write|build)\b/i, 2, "clear implementation request"],
  [/\b(unit test|integration test|tests|test coverage)\b/i, 3, "test implementation"],
  [/\b(rename|lint|format|typing|type error|typescript error|interface|types)\b/i, 3, "mechanical/types task"],
  [/\b(component|hook|endpoint|api client|schema|serializer|dto)\b/i, 2, "well-scoped implementation"],
  [/\b(boilerplate|scaffold|generate|dependency update|upgrade package)\b/i, 3, "mechanical/scaffolding task"],
  [/\b(fix this|change this|update this|replace this)\b/i, 2, "direct localized change"]
];

const DEEP_SIGNALS: Array<[RegExp, number, string]> = [
  [/\b(architecture|root cause|race condition|deadlock|security|vulnerability|large refactor|rewrite|migration)\b/i, 2, "deep reasoning signal"],
  [/\b(intermittent|flaky|occasionally|nondeterministic|unknown bug)\b/i, 2, "uncertain/reproduction-heavy task"],
  [/\b(across|cross[- ]module|without breaking|backward compatible|legacy)\b/i, 1, "cross-cutting constraints"]
];

const FAST_SIGNALS: Array<[RegExp, number, string]> = [
  [/\b(rename|lint|format|typo|types?|interface|add test|unit test|boilerplate)\b/i, 1, "mechanical/low-risk task"],
  [/\b(single file|one file|small change|simple|straightforward)\b/i, 1, "explicitly small scope"]
];

function add(reasons: ScoreReason[], agent: Agent, points: number, reason: string) {
  reasons.push({ agent, points, reason });
}

function clampComplexity(n: number) { return Math.max(1, Math.min(5, n)); }
function tierFromComplexity(c: number): ModelTier {
  if (c <= 2) return "fast";
  if (c === 3) return "balanced";
  return "deep";
}
function effortForTier(tier: ModelTier): Effort {
  return tier === "fast" ? "low" : tier === "balanced" ? "medium" : "high";
}

export function routeTask(task: string, config: RouterConfig): RouteResult {
  const reasons: ScoreReason[] = [];
  const modelReasons: string[] = [];
  let forcedAgent: Agent | undefined;
  let forcedTier: ModelTier | undefined;
  let forcedEffort: Effort | undefined;
  let matchedRule: string | undefined;

  for (const rule of config.rules) {
    try {
      if (new RegExp(rule.pattern, "i").test(task)) {
        forcedAgent = rule.agent;
        forcedTier = rule.modelTier;
        forcedEffort = rule.effort;
        matchedRule = rule.name;
        if (rule.agent) add(reasons, rule.agent, 100, `matched rule: ${rule.name}`);
        if (rule.modelTier) modelReasons.push(`rule ${rule.name} forced ${rule.modelTier} tier`);
        break;
      }
    } catch { /* ignore malformed regex */ }
  }

  for (const [pattern, points, reason] of CLAUDE_SIGNALS) if (pattern.test(task)) add(reasons, "claude", points, reason);
  for (const [pattern, points, reason] of CODEX_SIGNALS) if (pattern.test(task)) add(reasons, "codex", points, reason);

  const words = task.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 45) add(reasons, "claude", 2, "long/compound request");
  if (words <= 12) add(reasons, "codex", 1, "short/well-scoped request");
  const compounds = (task.match(/\b(and|also|while|without|across|then|after|before)\b/gi) ?? []).length;
  if (compounds >= 3) add(reasons, "claude", 2, "multiple constraints/subtasks");
  if (config.policy === "claude-heavy") add(reasons, "claude", 2, "claude-heavy policy");
  if (config.policy === "codex-heavy") add(reasons, "codex", 2, "codex-heavy policy");

  const learned = learningHints(task, config.history);
  if (learned.agentBoosts.claude !== 0) add(reasons, "claude", learned.agentBoosts.claude, "history feedback on similar tasks");
  if (learned.agentBoosts.codex !== 0) add(reasons, "codex", learned.agentBoosts.codex, "history feedback on similar tasks");
  modelReasons.push(...learned.notes);

  const claudeScore = reasons.filter(r => r.agent === "claude").reduce((s, r) => s + r.points, 0);
  const codexScore = reasons.filter(r => r.agent === "codex").reduce((s, r) => s + r.points, 0);
  const agent = forcedAgent ?? (claudeScore === codexScore ? config.defaultAgent : claudeScore > codexScore ? "claude" : "codex");

  let complexity = 2;
  if (words >= 20) complexity += 1;
  if (words >= 55) complexity += 1;
  for (const [pattern, points, reason] of DEEP_SIGNALS) if (pattern.test(task)) { complexity += points; modelReasons.push(reason); }
  for (const [pattern, points, reason] of FAST_SIGNALS) if (pattern.test(task)) { complexity -= points; modelReasons.push(reason); }
  if (compounds >= 3) complexity += 1;
  complexity = clampComplexity(complexity);

  let modelTier = forcedTier ?? tierFromComplexity(complexity);
  if (!forcedTier && config.history.learningEnabled) {
    const scores = learned.tierBoosts;
    const best = (Object.keys(scores) as ModelTier[]).sort((a,b) => scores[b] - scores[a])[0];
    if (scores[best] >= 1.25 && scores[best] > scores[modelTier] + 0.5) {
      modelReasons.push(`history favored ${best} tier for similar tasks`);
      modelTier = best;
    }
  }

  const profile = config[agent].models[modelTier];
  const effort = forcedEffort ?? profile.effort ?? effortForTier(modelTier);
  modelReasons.unshift(`complexity ${complexity}/5 → ${modelTier} tier`);

  return {
    agent, modelTier, model: profile.model, effort, complexity,
    claudeScore, codexScore, reasons, modelReasons, matchedRule
  };
}
