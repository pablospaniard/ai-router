import { appendHistory, newHistoryId, newRunId } from "./history.js";
import { routeTask } from "./router.js";
import { commandExists, runAgent } from "./runner.js";
import type { Agent, Effort, ModelTier, PhaseExecution, PhaseKind, PhasePlan, RouteResult, RouterConfig, SessionState } from "./types.js";
import { compactSessionContext } from "./session.js";
import { RunLogger } from "./logging.js";
import { agentColor, brand, statusIcon, tierColor, ui } from "./ui.js";
import type { LogLevel } from "./types.js";

const CRITICAL = /\b(critical|production|prod|sev[ -]?[01]|p[ -]?0|outage|crash|data loss|security|vulnerability|deadlock|race condition)\b/i;
const REVIEW = /\b(review|audit|inspect|code review|pr review|pull request)\b/i;
const BUG = /\b(bug|fix|broken|failure|failing|error|crash|issue|regression|wrong|incorrect)\b/i;
const COMPLEX = /\b(architecture|migration|migrate|refactor|legacy|cross[- ]module|root cause|intermittent|flaky|concurrency|performance)\b/i;
const SIMPLE = /\b(typo|rename|lint|format|type error|typescript error|small|simple|one file|single file)\b/i;

function phase(id: string, kind: PhaseKind, title: string, instruction: string, preferredAgent?: Agent, preferredTier?: ModelTier, preferredEffort?: Effort): PhasePlan {
  return { id, kind, title, instruction, preferredAgent, preferredTier, preferredEffort };
}

export function shouldOrchestrate(task: string, config: RouterConfig): boolean {
  if (config.orchestration.mode === "adaptive") return true;
  if (config.orchestration.mode === "single") return false;
  const words = task.trim().split(/\s+/).filter(Boolean).length;
  return CRITICAL.test(task) || REVIEW.test(task) || COMPLEX.test(task) || (BUG.test(task) && words >= 12) || words >= 35;
}

export function planPhases(task: string, config: RouterConfig): PhasePlan[] {
  const critical = CRITICAL.test(task);
  const reviewOnly = REVIEW.test(task) && !BUG.test(task) && !/\b(implement|change|modify|fix)\b/i.test(task);
  const simple = SIMPLE.test(task) && !critical && !COMPLEX.test(task);
  const plans: PhasePlan[] = [];

  if (reviewOnly) {
    plans.push(phase("review", "review", "Deep review", "Review the current repository changes or relevant code against the user's request. Identify concrete defects, regressions, missing tests, risky assumptions, and actionable improvements. Do not make code changes unless the user explicitly asked for them.", "claude", critical ? "deep" : "balanced", critical ? "high" : "medium"));
    return plans;
  }

  if (!simple) {
    plans.push(phase("analyze", "analyze", critical ? "Critical root-cause analysis" : "Analyze", "Investigate the request before editing. Inspect the relevant code paths, determine the root cause or implementation approach, identify risks and affected areas, and leave the repository ready for implementation. Avoid speculative broad rewrites.", "claude", critical ? "deep" : "balanced", critical ? "high" : "medium"));
  }

  plans.push(phase("implement", "implement", critical ? "Minimal safe fix" : "Implement", "Implement the requested change using the repository's existing conventions. Keep the change scoped, preserve compatibility unless the task says otherwise, and incorporate findings left by prior phases in the working tree.", "codex", critical || COMPLEX.test(task) ? "deep" : simple ? "fast" : "balanced", critical ? "xhigh" : simple ? "low" : "medium"));

  plans.push(phase("test", "test", "Validate", "Validate the implementation. Run the most relevant existing tests, type checks, linters, or build checks available for the changed area. Fix straightforward failures caused by the change. Do not hide unrelated failures.", "codex", critical ? "balanced" : "fast", critical ? "high" : "low"));

  if (config.orchestration.autoReview && (!simple || critical)) {
    plans.push(phase("review", "review", "Regression review", "Review the final diff and relevant surrounding code for correctness, regressions, edge cases, missing tests, and unnecessary complexity. If you find a concrete issue introduced by this task, fix it and re-run the smallest relevant validation.", "claude", critical ? "deep" : "balanced", critical ? "high" : "medium"));
  }

  return plans.slice(0, config.orchestration.maxPhases);
}

function phaseTask(originalTask: string, phasePlan: PhasePlan, prior: PhaseExecution[]): string {
  const priorSummary = prior.length
    ? `\n\nPrior phase outcomes:\n${prior.map(p => `- ${p.phase.kind}: exit=${p.exitCode}; ${tail(p.output, 1200)}`).join("\n")}`
    : "";
  return `[adaptive phase: ${phasePlan.kind}]\nOriginal request: ${originalTask}\n\nPhase objective: ${phasePlan.instruction}${priorSummary}\n\nClarification protocol: If you cannot safely continue without a user decision, do not guess. Output exactly one line in the form AIROUTE_QUESTION: <your concise question> and stop. Otherwise continue normally.`;
}

function tail(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : clean.slice(-n);
}

export function applyPhasePreference(base: RouteResult, p: PhasePlan, config: RouterConfig): RouteResult {
  const route = { ...base, reasons: [...base.reasons], modelReasons: [...base.modelReasons] };
  if (p.preferredAgent) {
    route.agent = p.preferredAgent;
    route.reasons.push({ agent: p.preferredAgent, points: 20, reason: `phase ${p.kind} preference` });
  }
  if (p.preferredTier && !route.userRequestedTier) route.modelTier = p.preferredTier;
  const profile = config[route.agent].models[route.modelTier];
  route.model = profile.model;
  route.effort = route.userRequestedTier
    ? profile.effort ?? route.effort
    : p.preferredEffort ?? profile.effort ?? route.effort;
  route.modelReasons.push(`phase ${p.kind} → ${route.agent}/${route.modelTier}`);
  return route;
}

function fallbackIfMissing(route: RouteResult, config: RouterConfig): RouteResult {
  if (commandExists(config[route.agent].command)) return route;
  const fallback: Agent = route.agent === "claude" ? "codex" : "claude";
  if (!commandExists(config[fallback].command)) throw new Error("Neither Claude Code nor Codex CLI is available in PATH");
  const p = config[fallback].models[route.modelTier];
  return { ...route, agent: fallback, model: p.model, effort: p.effort ?? route.effort };
}

export function needsRecovery(exec: PhaseExecution): boolean {
  if (exec.exitCode !== 0) return true;
  return /(?:^|\n)\s*(?:status:\s*)?(?:failed|unresolved|unable to complete|could not complete)\b/im.test(exec.output);
}

export async function orchestrate(task: string, config: RouterConfig, options: { dryRun?: boolean; explain?: boolean; session?: SessionState; logLevel?: LogLevel; askUser?: (question: string) => Promise<string> } = {}): Promise<{ runId: string; phases: PhaseExecution[]; exitCode: number }> {
  const runId = newRunId();
  const routedTask = options.session ? `${compactSessionContext(options.session)}\n\nCurrent follow-up request: ${task}` : task;
  const logger = new RunLogger({ runId, sessionId: options.session?.sessionId, level: options.logLevel ?? config.logging.level, persist: config.logging.persist });
  let plans = planPhases(task, config);
  const executions: PhaseExecution[] = [];

  if (options.dryRun) {
    console.log(`${statusIcon("info")} ${brand()} ${ui.bold("adaptive plan")} ${ui.cyan(runId)} ${ui.gray("·")} ${ui.bold(String(plans.length))} ${ui.gray("phase(s)")}`);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      let route = applyPhasePreference(routeTask(phaseTask(routedTask, p, executions), config), p, config);
      console.log(`  ${ui.gray(String(i + 1).padStart(2) + ".")} ${ui.bold(p.kind.padEnd(9))} ${ui.cyan("→")} ${agentColor(route.agent, route.agent)}${ui.gray("/")}${ui.cyan(route.model)} ${ui.gray("effort=")}${ui.magenta(route.effort)} ${ui.gray("tier=")}${tierColor(route.modelTier)} ${ui.gray("—")} ${p.title}`);
    }
    return { runId, phases: [], exitCode: 0 };
  }

  logger.status(`adaptive run ${runId} started: ${plans.length} phase(s)`);
  logger.metadata(`cwd=${process.cwd()} session=${options.session?.sessionId ?? "none"}`);

  for (let i = 0; i < plans.length && i < config.orchestration.maxPhases; i++) {
    const p = plans[i];
    const prompt = phaseTask(routedTask, p, executions);
    let route = applyPhasePreference(routeTask(prompt, config), p, config);
    route = fallbackIfMissing(route, config);

    const logMeta = { phaseIndex: i + 1, phaseTotal: plans.length, phaseKind: p.kind, agent: route.agent, model: route.model, effort: route.effort, tier: route.modelTier };
    logger.phaseStart(logMeta);
    const started = Date.now();
    let effectivePrompt = prompt;
    let result = await runAgent(route, effectivePrompt, config, { headless: true, capture: true, logger, logMeta });
    let clarificationCount = 0;
    while (result.question && options.askUser && clarificationCount < 4) {
      clarificationCount++;
      logger.question(result.question);
      const answer = (await options.askUser(result.question)).trim();
      logger.status(`input received → resuming ${p.kind}`);
      effectivePrompt = `${prompt}\n\nThe previous attempt paused for clarification.\nQuestion: ${result.question}\nUser answer: ${answer}\n\nContinue the same phase using this answer. Do not repeat the question unless another genuinely blocking decision is required.`;
      result = await runAgent(route, effectivePrompt, config, { headless: true, capture: true, logger, logMeta });
    }
    const execution: PhaseExecution = { phase: p, route, exitCode: result.exitCode, durationMs: Date.now() - started, output: result.output };
    executions.push(execution);
    logger.phaseEnd(logMeta, result.exitCode, execution.durationMs);

    const recordId = newHistoryId();
    execution.historyId = recordId;
    appendHistory(config.history, {
      id: recordId, runId, sessionId: options.session?.sessionId, parentRunId: options.session?.turns.at(-1)?.runId, timestamp: new Date().toISOString(), cwd: process.cwd(),
      task: prompt, originalTask: task, phaseKind: p.kind, phaseIndex: i + 1,
      agent: route.agent, modelTier: route.modelTier, model: route.model, effort: route.effort,
      complexity: route.complexity, exitCode: result.exitCode, durationMs: execution.durationMs,
      outputExcerpt: tail(result.output, config.orchestration.outputTailChars)
    });

    if (needsRecovery(execution) && config.orchestration.recoverOnFailure && plans.length < config.orchestration.maxPhases) {
      const recovery = phase(`recover-${i}`, "recover", "Escalated recovery", "The previous phase failed or reported an unresolved problem. Diagnose the failure using the current working tree and command output, fix the root cause if it is within scope, and run the smallest validation needed to prove recovery.", "claude", "deep", "high");
      plans.splice(i + 1, 0, recovery);
      logger.status("unresolved/failing phase detected → inserted deep recovery phase");
    }

    if (result.exitCode !== 0 && config.orchestration.stopOnFailure && !config.orchestration.recoverOnFailure) break;
  }

  const exitCode = executions.some(e => e.exitCode !== 0) ? 1 : 0;
  const finalExecution = [...executions].reverse().find(e => e.output.trim().length > 0);
  logger.status(`adaptive run ${runId} complete exit=${exitCode}`);
  if (finalExecution) logger.finalOutput(finalExecution.output);
  if (logger.persist) logger.status(`logs: ${logger.runDir}`);
  logger.status(`rate: airo feedback good ${runId}  |  airo feedback bad ${runId}`);
  return { runId, phases: executions, exitCode };
}
