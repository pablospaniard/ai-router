#!/usr/bin/env node
import readline from "node:readline";
import { agentColor, brand, command as commandColor, divider, panel, promptLabel, statusIcon, tierColor, ui } from "./ui.js";
import fs from "node:fs";
import { loadConfig, writeProjectConfig } from "./config.js";
import { runSetup } from "./setup.js";
import { printModels } from "./models.js";
import { appendHistory, historyPath, newHistoryId, readHistory, setFeedback } from "./history.js";
import { orchestrate, planPhases, shouldOrchestrate } from "./orchestrator.js";
import { agentForModel, routeTask } from "./router.js";
import { addTokenUsage, commandExists, commandVersion, isApprovalAnswer, runAgent } from "./runner.js";
import { appendTurn, clearActiveSession, createSession, getActiveSession, listSessions, loadSession, setActiveSession } from "./session.js";
import { findRunLogs, followFile, logsRoot, recentRunDirs, RunLogger } from "./logging.js";
import type { Agent, Effort, FeedbackRating, LogLevel, ModelTier, SessionState } from "./types.js";
import { VERSION } from "./version.js";
import { INTERACTIVE_COMMANDS, parseFeedbackAnswer, parseInteractiveInput, taskArgs, type InteractivePreferences } from "./interactive.js";
import { migrateLegacyPaths } from "./paths.js";
import { shouldRunInitialSetup } from "./startup.js";
import { singleRunPrompt } from "./prompts.js";
import { inspectAccounts } from "./account.js";
import { buildUsageReport, nonCachedTokens, processedTokens } from "./usage.js";

function requireText(file: string): string { return fs.readFileSync(file, "utf8"); }

function help() {
  console.log("");
  console.log(divider(`AIRO v${VERSION}`));
  console.log(`${brand()} ${ui.dim("Adaptive Intelligence Routing & Orchestration")}`);
  console.log("");
  console.log(ui.bold("Core"));
  console.log(`  ${commandColor("airo")}                                   ${ui.gray("open the interactive workspace")}`);
  console.log(`  ${commandColor('airo "task"')}                            ${ui.gray("new logical session")}`);
  console.log(`  ${commandColor('airo --continue "follow-up"')}             ${ui.gray("continue active repo session")}`);
  console.log(`  ${commandColor('airo chat')}                               ${ui.gray("interactive follow-up mode")}`);
  console.log(`  ${commandColor('airo --adaptive "task"')}                 ${ui.gray("force multi-phase orchestration")}`);
  console.log(`  ${commandColor('airo --single "task"')}                   ${ui.gray("force one agent/model")}`);
  console.log("");
  console.log(ui.bold("Models & setup"));
  console.log(`  ${commandColor('airo setup')}                              ${ui.gray("configure the three automatic model tiers")}`);
  console.log(`  ${commandColor('airo models')}                             ${ui.gray("show active model mapping")}`);
  console.log(`  ${commandColor('airo doctor')}                             ${ui.gray("check providers and paths")}`);
  console.log(`  ${commandColor('airo account')}                            ${ui.gray("show provider login and default models")}`);
  console.log("");
  console.log(ui.bold("Observability"));
  console.log(`  ${commandColor('airo logs [runId]')}                       ${ui.gray("show persisted logs")}`);
  console.log(`  ${commandColor('airo logs --follow [runId]')}              ${ui.gray("follow a run live")}`);
  console.log(`  ${commandColor('airo history [limit]')}                    ${ui.gray("show routing history")}`);
  console.log(`  ${commandColor('airo usage [limit]')}                      ${ui.gray("show token use and measured savings")}`);
  console.log(`  ${commandColor('airo feedback good|bad ...')}              ${ui.gray("teach the router")}`);
  console.log("");
  console.log(ui.bold("Sessions"));
  console.log(`  ${commandColor('airo session')}                            ${ui.gray("show active session")}`);
  console.log(`  ${commandColor('airo sessions')}                           ${ui.gray("list repo sessions")}`);
  console.log(`  ${commandColor('airo session new ["task"]')}              ${ui.gray("start fresh")}`);
  console.log(`  ${commandColor('airo session clear')}                      ${ui.gray("clear active session")}`);
  console.log("");
  console.log(`${statusIcon("info")} ${ui.dim("Follow-ups preserve session context but are re-routed independently.")}`);
  console.log(`${statusIcon("info")} ${ui.dim("Set NO_COLOR=1 to disable ANSI colors.")}`);
}

function parseArgs(argv: string[]) {
  let agent: "auto" | Agent = "auto";
  let tier: ModelTier | undefined;
  let model: string | undefined;
  let effort: Effort | undefined;
  let dryRun = false, explain = false, adaptive = false, single = false, continueMode = false;
  let logLevel: LogLevel | undefined;
  let sessionId: string | undefined;
  const taskParts: string[] = [];
  for (let i=0; i<argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") agent = argv[++i] as any;
    else if (arg === "--tier") tier = argv[++i] as ModelTier;
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--effort") effort = argv[++i] as Effort;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--explain") explain = true;
    else if (arg === "--adaptive") adaptive = true;
    else if (arg === "--single") single = true;
    else if (arg === "--continue") continueMode = true;
    else if (arg === "--session") sessionId = argv[++i];
    else if (arg === "--log") {
      const v = argv[++i] as LogLevel;
      if (!["compact","live","verbose"].includes(v)) throw new Error(`Invalid --log: ${v}`);
      logLevel = v;
    }
    else if (arg === "-h" || arg === "--help") { help(); process.exit(0); }
    else taskParts.push(arg);
  }
  if (adaptive && single) throw new Error("Use either --adaptive or --single, not both");
  if (!["auto","claude","codex"].includes(agent)) throw new Error(`Invalid --agent: ${agent}`);
  return { agent, tier, model, effort, dryRun, explain, adaptive, single, continueMode, sessionId, logLevel, task: taskParts.join(" ").trim() };
}

async function askTerminal(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>(resolve => rl.question(`${promptLabel()}${ui.yellow("answer")}: `, resolve));
  } finally {
    rl.close();
  }
}

async function askFeedbackTerminal(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>(resolve => rl.question(`${ui.yellow("?")} ${ui.bold("Was this result helpful?")} ${ui.gray("[y/n, Enter to skip]")} `, resolve));
  } finally {
    rl.close();
  }
}

async function collectRunFeedback(runId: string, config: any, askFeedback: () => Promise<string>): Promise<void> {
  if (!process.stdin.isTTY || !config.history.enabled || !config.history.learningEnabled) return;
  const rating = parseFeedbackAnswer(await askFeedback());
  if (!rating) {
    console.log(`${statusIcon("info")} ${ui.gray("feedback skipped")}`);
    return;
  }
  setFeedback(config.history, rating, runId);
  console.log(`${statusIcon("ok")} ${ui.gray("feedback saved ·")} ${rating === "good" ? ui.green("helpful") : ui.red("not helpful")}`);
}

async function singleRun(args: ReturnType<typeof parseArgs>, config: any, path: string | undefined, session?: SessionState, askUser: (question: string) => Promise<string> = askTerminal) {
  let routed = routeTask(args.task, config);
  if (args.agent === "auto" && args.model) {
    const inferredAgent = agentForModel(args.model, config);
    if (inferredAgent && inferredAgent !== routed.agent) {
      routed.agent = inferredAgent;
      routed.effort = args.effort ?? config[inferredAgent].models[routed.modelTier].effort ?? routed.effort;
    }
  }
  if (args.agent !== "auto") {
    routed.agent = args.agent;
    const profile = config[routed.agent].models[args.tier ?? routed.modelTier];
    routed.modelTier = args.tier ?? routed.modelTier;
    routed.model = args.model ?? profile.model;
    routed.effort = args.effort ?? profile.effort ?? routed.effort;
  } else {
    if (args.tier) {
      routed.modelTier = args.tier;
      const profile = config[routed.agent].models[args.tier];
      routed.model = args.model ?? profile.model;
      routed.effort = args.effort ?? profile.effort ?? routed.effort;
    }
    if (args.model) routed.model = args.model;
    if (args.effort) routed.effort = args.effort;
  }
  const singleRunId = `single-${Date.now().toString(36)}`;
  const logger = new RunLogger({ runId: singleRunId, sessionId: session?.sessionId, level: args.logLevel ?? config.logging.level, persist: config.logging.persist });
  const logMeta = { phaseIndex: 1, phaseTotal: 1, phaseKind: "single" as const, agent: routed.agent, model: routed.model, effort: routed.effort, tier: routed.modelTier };
  logger.phaseStart(logMeta);
  if (path) console.log(`${statusIcon("info")} ${brand()} ${ui.gray("config")} ${ui.cyan(path)}`);
  if (args.explain || args.dryRun) {
    console.log(`${statusIcon("info")} ${ui.bold("provider scores")} ${agentColor("claude", `Claude ${routed.claudeScore.toFixed(1)}`)} ${ui.gray("/")} ${agentColor("codex", `Codex ${routed.codexScore.toFixed(1)}`)}`);
    for (const r of routed.reasons) console.log(`  ${agentColor(r.agent, r.agent === "claude" ? "C" : "X")} ${ui.yellow(`${r.points >= 0 ? "+" : ""}${r.points.toFixed(1)}`)} ${ui.gray("·")} ${r.reason}`);
  }
  if (args.dryRun) return { exitCode: 0, runId: "dry-run", summaries: [`single:${routed.agent}/${routed.model}`] };
  if (!commandExists(config[routed.agent].command)) throw new Error(`${config[routed.agent].command} not available in PATH`);
  const started = Date.now();
  const basePrompt = singleRunPrompt(args.task, session);
  let effectivePrompt = basePrompt;
  let result = await runAgent(routed, effectivePrompt, config, { headless: true, capture: true, logger, logMeta });
  let usage = result.usage;
  let clarificationCount = 0;
  while (result.question && clarificationCount < 4) {
    clarificationCount++;
    logger.question(result.question);
    const answer = await askUser(result.question);
    const permissionMode = routed.agent === "claude" && isApprovalAnswer(answer) ? "bypassPermissions" : undefined;
    logger.status(permissionMode
      ? "approval received → resuming single phase with elevated permissions"
      : "input received → resuming single phase");
    effectivePrompt = `${basePrompt}\n\nPrevious clarification question: ${result.question}\nUser answer: ${answer}\n\nContinue the task using this answer. If another blocking decision is required, use AIROUTE_QUESTION: <question>.`;
    result = await runAgent(routed, effectivePrompt, config, { headless: true, capture: true, logger, logMeta, permissionMode });
    usage = addTokenUsage(usage, result.usage);
  }
  const durationMs = Date.now() - started;
  logger.phaseEnd(logMeta, result.exitCode, durationMs);
  logger.finalOutput(result.output);
  if (logger.persist) logger.status(`logs: ${logger.runDir}`);
  appendHistory(config.history, {
    id: newHistoryId(), runId: singleRunId, sessionId: session?.sessionId, parentRunId: session?.turns.at(-1)?.runId,
    timestamp: new Date().toISOString(), cwd: process.cwd(), task: args.task, originalTask: args.task,
    agent: routed.agent, modelTier: routed.modelTier, model: routed.model, effort: routed.effort,
    complexity: routed.complexity, exitCode: result.exitCode, durationMs,
    outputExcerpt: result.output.slice(-config.orchestration.outputTailChars), usage,
  });
  return { exitCode: result.exitCode, runId: singleRunId, output: result.output, summaries: [`single:${routed.agent}/${routed.model} exit=${result.exitCode}`] };
}

async function execute(args: ReturnType<typeof parseArgs>, session: SessionState | undefined, config: any, path?: string, askUser: (question: string) => Promise<string> = askTerminal, askFeedback: () => Promise<string> = askFeedbackTerminal) {
  const adaptive = args.adaptive || (!args.single && shouldOrchestrate(args.task, config));
  if (adaptive) {
    const result = await orchestrate(args.task, config, { dryRun: args.dryRun, explain: args.explain, session, logLevel: args.logLevel, askUser });
    if (session && !args.dryRun) appendTurn(session, {
      turnId: result.runId + "-turn", runId: result.runId, timestamp: new Date().toISOString(), userPrompt: args.task,
      routeSummary: result.phases.map(p => `${p.phase.kind}:${p.route.agent}/${p.route.model}`).join(" → "),
      phaseSummaries: result.phases.map(p => `${p.phase.kind} exit=${p.exitCode}; ${p.output.replace(/\s+/g," ").slice(-400)}`)
    });
    if (!args.dryRun) await collectRunFeedback(result.runId, config, askFeedback);
    return result.exitCode;
  }
  const r = await singleRun(args, config, path, session, askUser);
  if (session && !args.dryRun) appendTurn(session, {
    turnId: r.runId + "-turn", runId: r.runId, timestamp: new Date().toISOString(), userPrompt: args.task,
    routeSummary: r.summaries[0] ?? "single", phaseSummaries: r.summaries
  });
  if (!args.dryRun) await collectRunFeedback(r.runId, config, askFeedback);
  return r.exitCode;
}

function interactivePrompt(session: SessionState, preferences: InteractivePreferences): string {
  const mode = preferences.mode === "auto" ? ui.green("auto") : preferences.mode === "adaptive" ? ui.magenta("adaptive") : ui.yellow("single");
  const agent = preferences.agent === "auto" ? ui.gray("auto-agent") : agentColor(preferences.agent, preferences.agent);
  return `${brand()} ${ui.gray(session.sessionId.slice(0, 6))} ${mode} ${agent} ${ui.green("❯")} `;
}

function interactiveStatus(session: SessionState, preferences: InteractivePreferences, config: any, path?: string): string {
  const provider = (agent: Agent) => {
    const available = commandExists(config[agent].command);
    return `${available ? statusIcon("ok") : statusIcon("error")} ${agentColor(agent, agent.padEnd(6))} ${ui.gray(config[agent].models.balanced.model)}`;
  };
  return panel(`AIRO v${VERSION}`, [
    `${ui.bold("session")}  ${ui.cyan(session.sessionId)} ${ui.gray(`· ${session.turns.length} turn(s)`)}`,
    `${ui.bold("mode")}     ${ui.cyan(preferences.mode)} ${ui.gray("·")} ${ui.bold("agent")} ${ui.cyan(preferences.agent)} ${ui.gray("·")} ${ui.bold("tier")} ${tierColor(preferences.tier ?? "auto")}`,
    `${ui.bold("output")}   ${ui.cyan(preferences.logLevel)} ${ui.gray("· config ")} ${path ? ui.cyan(path) : ui.yellow("defaults")}`,
    `${provider("claude")}    ${provider("codex")}`,
  ]);
}

function interactiveHelp(): string {
  return panel("Interactive commands", [
    `${commandColor("/new [title]")}        ${ui.gray("start a fresh session")}`,
    `${commandColor("/status")}             ${ui.gray("show session and run preferences")}`,
    `${commandColor("/mode auto|adaptive|single")} ${ui.gray("set workflow mode")}`,
    `${commandColor("/agent auto|claude|codex")}   ${ui.gray("pin or auto-select a provider")}`,
    `${commandColor("/tier auto|fast|balanced|deep")} ${ui.gray("set model tier")}`,
    `${commandColor("/log compact|live|verbose")}  ${ui.gray("set output detail")}`,
    `${commandColor("/models")} ${commandColor("/sessions")} ${commandColor("/clear")} ${commandColor("/exit")}`,
  ], 76);
}

async function chatLoop(config: any, path?: string) {
  let session: SessionState = getActiveSession() ?? createSession("Interactive session");
  const preferences: InteractivePreferences = { mode: "auto", agent: "auto", logLevel: config.logging.level };
  console.log("");
  console.log(interactiveStatus(session, preferences, config, path));
  console.log(`${ui.gray("Type a task to begin, or")} ${commandColor("/help")} ${ui.gray("for interactive commands.")}`);
  console.log("");
  const completer = (line: string) => {
    if (!line.startsWith("/")) return [[], line];
    const hits = INTERACTIVE_COMMANDS.filter(command => command.startsWith(line));
    return [hits.length ? hits : INTERACTIVE_COMMANDS, line];
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer, historySize: 200, removeHistoryDuplicates: true });
  const ask = () => new Promise<string>(resolve => rl.question(interactivePrompt(session, preferences), resolve));
  const askAnswer = (_question: string) => new Promise<string>(resolve => rl.question(`${promptLabel()}${ui.yellow("answer")}: `, resolve));
  const askFeedback = () => new Promise<string>(resolve => rl.question(`${ui.yellow("?")} ${ui.bold("Was this result helpful?")} ${ui.gray("[y/n, Enter to skip]")} `, resolve));
  try {
    while (true) {
      const action = parseInteractiveInput(await ask());
      if (action.kind === "empty") continue;
      if (action.kind === "quit") break;
      if (action.kind === "help") { console.log(interactiveHelp()); continue; }
      if (action.kind === "status") { console.log(interactiveStatus(session, preferences, config, path)); continue; }
      if (action.kind === "clear") { process.stdout.write(process.stdout.isTTY ? "\x1b[2J\x1b[H" : "\n"); continue; }
      if (action.kind === "models") { printModels(); continue; }
      if (action.kind === "sessions") {
        const sessions = listSessions();
        console.log(panel("Repository sessions", sessions.length ? sessions.slice(0, 8).map(item =>
          `${item.sessionId === session.sessionId ? statusIcon("ok") : " "} ${ui.bold(item.sessionId)} ${ui.gray(`· ${item.turns.length} turns · ${item.originalTask}`)}`
        ) : [ui.gray("No sessions for this repository.")]));
        continue;
      }
      if (action.kind === "new") {
        session = createSession(action.title ?? "Interactive session");
        console.log(`${statusIcon("ok")} ${ui.green("new session")} ${ui.bold(session.sessionId)}${action.title ? ui.gray(` · ${action.title}`) : ""}`);
        continue;
      }
      if (action.kind === "set-mode") preferences.mode = action.value;
      else if (action.kind === "set-agent") preferences.agent = action.value;
      else if (action.kind === "set-tier") preferences.tier = action.value;
      else if (action.kind === "set-log") preferences.logLevel = action.value;
      else if (action.kind === "error") { console.log(`${statusIcon("error")} ${ui.red(action.message)}`); continue; }
      else if (action.kind === "task") {
        const args = parseArgs(taskArgs(action.task, preferences));
        const adaptive = args.adaptive || (!args.single && shouldOrchestrate(args.task, config));
        console.log(`${statusIcon("work")} ${ui.gray("workflow")} ${adaptive ? ui.magenta("adaptive") : ui.cyan("single")} ${ui.gray("· preparing run")}`);
        try {
          await execute(args, session, config, path, askAnswer, askFeedback);
          session = loadSession(session.sessionId);
        } catch (error) {
          console.log(`${statusIcon("error")} ${ui.red(error instanceof Error ? error.message : String(error))}`);
        }
        continue;
      }
      console.log(`${statusIcon("ok")} ${ui.gray("updated preferences ·")} ${ui.cyan(`mode=${preferences.mode} agent=${preferences.agent} tier=${preferences.tier ?? "auto"} log=${preferences.logLevel}`)}`);
    }
  } finally {
    rl.close();
    console.log(`${statusIcon("ok")} ${ui.gray("AIRO session saved. Goodbye.")}`);
  }
}

async function main() {
  const raw = process.argv.slice(2);

  if (raw[0] === "--version" || raw[0] === "-v") {
    console.log(VERSION);
    return;
  }

  const migration = migrateLegacyPaths();
  for (const error of migration.errors) console.error(`${statusIcon("error")} ${ui.yellow(`legacy data migration skipped: ${error}`)}`);
  let { config, path } = loadConfig();

  if (shouldRunInitialSetup(raw, Boolean(process.stdin.isTTY), Boolean(path))) {
    console.log(`${statusIcon("info")} ${brand()} ${ui.bold("first run detected")}`);
    console.log(`${ui.gray("No config found. Starting model setup; you can rerun it anytime with")} ${commandColor("airo setup")}.`);
    await runSetup();
    ({ config, path } = loadConfig());
  }

  if (raw[0] === "setup") { await runSetup(); return; }
  if (raw[0] === "models") { printModels(); return; }

  if (raw[0] === "account") {
    console.log(divider("Provider accounts"));
    for (const account of inspectAccounts(config)) {
      const icon = account.available && account.authenticated ? statusIcon("ok") : statusIcon("error");
      const identity = account.identity ?? (account.authenticated ? "identity not exposed by CLI" : account.status);
      console.log(`${icon} ${agentColor(account.agent, account.agent.padEnd(6))} ${ui.bold(identity)}`);
      if (account.authMethod) console.log(`  ${ui.gray("authentication")} ${ui.cyan(account.authMethod)}`);
      console.log(`  ${ui.gray("default model ")} ${account.defaultModel ? ui.cyan(account.defaultModel) : ui.yellow("not detected; set defaultModel in AIRO config")}`);
      const tiers = (["fast", "balanced", "deep"] as const).map(tier => `${tier}=${config[account.agent].models[tier].model}`).join(" · ");
      console.log(`  ${ui.gray("AIRO models   ")} ${ui.dim(tiers)}`);
    }
    return;
  }

  if (raw[0] === "doctor") {
    console.log(divider("Doctor")); console.log(`${ui.gray("Config ")} ${path ? ui.cyan(path) : ui.yellow("built-in defaults")}`);
    console.log(`${ui.gray("History")} ${ui.cyan(historyPath(config.history))}`);
    for (const agent of ["claude", "codex"] as const) {
      const command = config[agent].command;
      const exists = commandExists(command);
      console.log(`${exists ? statusIcon("ok") : statusIcon("error")} ${agentColor(agent, agent.padEnd(6))} ${ui.cyan(command)} ${exists ? ui.gray(`→ ${commandVersion(command)}`) : ui.red("→ not found in PATH")}`);
    }
    return;
  }
  if (raw[0] === "history") {
    const limit = Math.max(1, Number(raw[1] ?? 15));
    for (const r of readHistory(config.history).slice(-limit).reverse()) console.log(`${r.id}${r.runId ? ` run=${r.runId}` : ""}${r.sessionId ? ` session=${r.sessionId}` : ""} ${r.agent}/${r.model} ${r.effort} exit=${r.exitCode} ${r.feedback ?? ""}`);
    return;
  }
  if (raw[0] === "usage") {
    const limit = Math.max(1, Number(raw[1] ?? 20));
    const report = buildUsageReport(config, limit);
    console.log(divider(`Token usage · last ${report.records.length} measured phase(s)`));
    if (!report.records.length) {
      console.log(`${statusIcon("info")} ${ui.gray("No provider token telemetry is available yet. Run a task with persisted logging enabled.")}`);
      return;
    }
    console.log(`${ui.bold("Non-cached")} ${ui.cyan(nonCachedTokens(report.totals).toLocaleString())} ${ui.gray("tokens")}`);
    console.log(`${ui.bold("Cache reads")} ${ui.cyan(report.totals.cachedInputTokens.toLocaleString())} ${ui.gray("tokens")}`);
    console.log(`${ui.bold("Processed")}  ${ui.cyan(processedTokens(report.totals).toLocaleString())} ${ui.gray("tokens")}`);
    console.log(`${ui.bold("Output")}     ${ui.cyan(report.totals.outputTokens.toLocaleString())} ${ui.gray("tokens (included above)")}`);
    for (const agent of ["claude", "codex"] as const) {
      console.log(`${agentColor(agent, agent.padEnd(6))} ${ui.gray("default model")} ${report.defaults[agent] ? ui.cyan(report.defaults[agent]!) : ui.yellow("not detected")}`);
    }
    if (report.savings) {
      const value = Math.abs(report.savings.percent).toFixed(1);
      const comparison = report.savings.percent >= 0 ? `AIRO used ${value}% fewer non-cached tokens` : `AIRO used ${value}% more non-cached tokens`;
      console.log(`${statusIcon(report.savings.percent >= 0 ? "ok" : "info")} ${ui.bold(comparison)} ${ui.gray("than comparable successful runs on provider-default models.")}`);
      console.log(`${ui.gray(`Coverage: ${report.savings.comparedRecords}/${report.savings.totalRecords} measured phase(s). This is a historical estimate, not a same-task A/B test.`)}`);
    } else {
      console.log(`${statusIcon("info")} ${ui.gray("Default-model comparison unavailable: at least two comparable measured runs on a detected provider-default model are needed.")}`);
    }
    return;
  }
  if (raw[0] === "feedback") {
    const rating = raw[1] as FeedbackRating;
    if (!["good","bad"].includes(rating)) throw new Error("Use: airo feedback good|bad [id|runId|last] [note]");
    const updated = setFeedback(config.history, rating, raw[2] ?? "last", raw.slice(3).join(" ") || undefined);
    console.log(`${statusIcon("ok")} ${brand()} ${ui.gray("feedback=")}${rating === "good" ? ui.green(rating) : ui.red(rating)} ${ui.gray("saved for")} ${ui.bold(String(updated.length))} ${ui.gray("item(s)")}`); return;
  }
  if (raw[0] === "config" && raw[1] === "init") { console.log(`${statusIcon("ok")} ${ui.green("Created")} ${ui.cyan(writeProjectConfig())}`); return; }
  if (raw[0] === "logs") {
    const follow = raw.includes("--follow");
    const idArg = raw.slice(1).find((x: string) => x !== "--follow");
    if (!idArg) {
      const runs = recentRunDirs(20);
      if (!runs.length) console.log(`${statusIcon("info")} ${ui.gray("No logs yet. Root:")} ${ui.cyan(logsRoot())}`);
      for (const r of runs) console.log(`${statusIcon("info")} ${ui.bold(r.runId)} ${ui.gray(r.mtime.toISOString())} ${ui.cyan(r.path)}`);
      return;
    }
    const dir = findRunLogs(idArg);
    if (!dir) throw new Error(`Run logs not found: ${idArg}`);
    const file = `${dir}/combined.log`;
    if (follow) { console.log(`${statusIcon("work")} ${brand()} ${ui.gray("following")} ${ui.cyan(file)} ${ui.gray("— Ctrl-C to stop")}`); await followFile(file); }
    else { console.log(requireText(file)); }
    return;
  }
  if (raw[0] === "chat" || (raw.length === 0 && process.stdin.isTTY)) { await chatLoop(config, path); return; }
  if (raw[0] === "sessions") {
    const list = listSessions();
    if (!list.length) console.log(`${statusIcon("info")} ${ui.gray("No sessions for this repo.")}`);
    for (const s of list) console.log(`${statusIcon("info")} ${ui.bold(s.sessionId)} ${ui.gray(s.updatedAt)} ${ui.cyan(`turns=${s.turns.length}`)} ${s.originalTask}`);
    return;
  }
  if (raw[0] === "session") {
    if (raw[1] === "clear") { clearActiveSession(); console.log(`${statusIcon("ok")} ${ui.green("Cleared active session for this repo.")}`); return; }
    if (raw[1] === "new") {
      const task = raw.slice(2).join(" ").trim() || "New session";
      const s = createSession(task); console.log(`${statusIcon("ok")} ${ui.green("Created and activated session")} ${ui.bold(s.sessionId)}`);
      if (raw.length > 2) { const args = parseArgs(raw.slice(2)); process.exitCode = await execute(args, s, config, path); }
      return;
    }
    const s = getActiveSession();
    console.log(s ? `${divider("Active session")}\n${ui.cyan(JSON.stringify(s, null, 2))}` : `${statusIcon("info")} ${ui.gray("No active session for this repo.")}`); return;
  }

  const args = parseArgs(raw);
  if (!args.task) { help(); process.exitCode = 2; return; }
  let session: SessionState | undefined;
  if (args.sessionId) { session = loadSession(args.sessionId); setActiveSession(process.cwd(), session.sessionId); }
  else if (args.continueMode) { session = getActiveSession(); if (!session) throw new Error('No active session. Start with: airo session new "task"'); }
  else session = createSession(args.task);
  process.exitCode = await execute(args, session, config, path);
}

main().catch(err => { console.error(`${statusIcon("error")} ${ui.red(err instanceof Error ? err.message : String(err))}`); process.exitCode = 1; });
