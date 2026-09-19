import { spawn, spawnSync } from "node:child_process";
import type { Agent, AgentRunResult, RouteResult, RouterConfig, TokenUsage } from "./types.js";
import type { PhaseLogMeta, RunLogger } from "./logging.js";

export function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

/** Provider errors that usually mean this account/model cannot serve the request right now. */
export function isUsageLimitError(text: string, exitCode?: number): boolean {
  if (!text && exitCode === 0) return false;
  return /(?:usage|quota|rate|session|request|message|token)[ -]?(?:limit|limited|exhausted|exceeded)|(?:hit|reached|exceeded|ran out of).{0,40}(?:limit|quota|credits?|balance)|(?:credit|credits|balance)[ -]?(?:limit|exhausted|insufficient)|too many requests|(?:429|resource_exhausted|rate_limit_error|quota_exceeded)|billing.{0,30}(?:limit|disabled|past due)|out of credits/i.test(text);
}

export function commandVersion(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.error) return `ERROR: ${result.error.message}`;
  return (result.stdout || result.stderr || "").trim() || `exit ${result.status}`;
}

function argsForRoute(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  headless: boolean,
  structuredProgress: boolean,
  permissionMode?: RouterConfig["claude"]["permissionMode"],
): { args: string[]; env: any } {
  const provider = config[route.agent];
  const env: any = { ...process.env };
  const args = [...(provider.args ?? [])];

  if (route.agent === "claude") {
    if (headless) args.push("-p");
    args.push("--model", route.model);
    if (structuredProgress && headless) args.push("--output-format", "stream-json", "--verbose");
    const effectivePermissionMode = permissionMode ?? provider.permissionMode;
    if (headless && effectivePermissionMode) args.push("--permission-mode", effectivePermissionMode);
    if (route.effort !== "auto") env.CLAUDE_CODE_EFFORT_LEVEL = route.effort;
    args.push(prompt);
  } else {
    if (headless) args.push("exec");
    if (structuredProgress && headless) args.push("--json");
    args.push("--model", route.model);
    if (route.effort !== "auto") args.push("-c", `model_reasoning_effort=\"${route.effort}\"`);
    args.push(prompt);
  }
  return { args, env };
}

function compactJson(value: unknown, max = 140): string {
  let s: string;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export interface ParsedProviderEvent {
  messages: Array<{ category: string; text: string }>;
  candidateOutput?: string;
  finalOutput?: string;
  usage?: TokenUsage;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function addTokenUsage(a?: TokenUsage, b?: TokenUsage): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

export function claudeProgress(event: any): ParsedProviderEvent {
  const messages: Array<{ category: string; text: string }> = [];
  const candidate: string[] = [];
  if (!event || typeof event !== "object") return { messages };

  if (event.type === "system") {
    if (event.subtype === "init") messages.push({ category: "system", text: `initialized${event.model ? ` model=${event.model}` : ""}${event.session_id ? ` session=${event.session_id}` : ""}` });
    else if (event.subtype === "api_retry") messages.push({ category: "retry", text: `API retry ${event.attempt ?? "?"}/${event.max_retries ?? "?"} in ${event.retry_delay_ms ?? "?"}ms (${event.error ?? "unknown"})` });
    else if (event.subtype === "plugin_install") messages.push({ category: "system", text: `plugin install ${event.status ?? "update"}${event.name ? `: ${event.name}` : ""}` });
  }

  if (event.type === "assistant" && event.message?.content && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block?.type === "text" && block.text) {
        messages.push({ category: "message", text: String(block.text) });
        candidate.push(String(block.text));
      } else if (block?.type === "tool_use") {
        const name = block.name ?? "tool";
        const details = block.input ? ` ${compactJson(block.input)}` : "";
        messages.push({ category: "tool", text: `${name}${details}` });
      }
    }
  }

  // Some versions emit top-level tool progress fields.
  if (event.type === "tool_use" || event.type === "tool") {
    messages.push({ category: "tool", text: `${event.name ?? event.tool_name ?? "tool"}${event.input ? ` ${compactJson(event.input)}` : ""}` });
  }

  if (event.type === "result") {
    const bits = [event.subtype ?? "completed"];
    if (event.duration_ms != null) bits.push(`${Math.round(event.duration_ms/1000)}s`);
    messages.push({ category: "result", text: bits.join(" ") });
  }

  // Intentionally do not surface raw thinking/reasoning content.
  const rawUsage = event.type === "result" ? event.usage : undefined;
  const usage = rawUsage ? {
    uncachedInputTokens: number(rawUsage.input_tokens),
    cachedInputTokens: number(rawUsage.cache_read_input_tokens),
    cacheWriteInputTokens: number(rawUsage.cache_creation_input_tokens),
    outputTokens: number(rawUsage.output_tokens),
    reasoningOutputTokens: 0,
  } : undefined;
  return {
    messages,
    candidateOutput: candidate.length ? candidate.join("\n") : undefined,
    finalOutput: event.type === "result" && event.result ? String(event.result) : undefined,
    usage,
  };
}

export function codexProgress(event: any): ParsedProviderEvent {
  const messages: Array<{ category: string; text: string }> = [];
  let candidateOutput: string | undefined;
  let usage: TokenUsage | undefined;
  if (!event || typeof event !== "object") return { messages };

  if (event.type === "thread.started") messages.push({ category: "system", text: `thread started${event.thread_id ? ` ${event.thread_id}` : ""}` });
  else if (event.type === "turn.started") messages.push({ category: "system", text: "turn started" });
  else if (event.type === "turn.failed") messages.push({ category: "error", text: `turn failed${event.error?.message ? `: ${event.error.message}` : ""}` });
  else if (event.type === "error") messages.push({ category: "error", text: event.message ?? compactJson(event) });
  else if (event.type === "turn.completed") {
    const u = event.usage;
    messages.push({ category: "result", text: u ? `turn completed tokens in=${u.input_tokens ?? "?"} cached=${u.cached_input_tokens ?? "?"} out=${u.output_tokens ?? "?"}` : "turn completed" });
    if (u) {
      const input = number(u.input_tokens);
      const cached = number(u.cached_input_tokens);
      usage = {
        uncachedInputTokens: Math.max(0, input - cached),
        cachedInputTokens: cached,
        cacheWriteInputTokens: number(u.cache_write_input_tokens),
        outputTokens: number(u.output_tokens),
        reasoningOutputTokens: number(u.reasoning_output_tokens),
      };
    }
  }

  if ((event.type === "item.started" || event.type === "item.completed") && event.item) {
    const item = event.item;
    const done = event.type === "item.completed";
    switch (item.type) {
      case "command_execution":
        messages.push({ category: "tool", text: done ? `command completed${item.exit_code != null ? ` (exit ${item.exit_code})` : ""}` : `command: ${String(item.command ?? "").slice(0, 140)}` });
        break;
      case "file_change":
      case "file_changes":
        messages.push({ category: "file", text: `${done ? "file change completed" : "file change"}${item.path ? `: ${item.path}` : item.changes ? `: ${compactJson(item.changes)}` : ""}` });
        break;
      case "mcp_tool_call":
        messages.push({ category: "tool", text: `MCP ${item.server ?? ""}${item.tool ?? item.name ? `/${item.tool ?? item.name}` : ""}${done ? " completed" : ""}` });
        break;
      case "web_search":
        messages.push({ category: "tool", text: `web search${item.query ? `: ${item.query}` : ""}${done ? " completed" : ""}` });
        break;
      case "agent_message":
        if (item.text) {
          messages.push({ category: "message", text: String(item.text) });
          if (done) candidateOutput = String(item.text);
        }
        break;
      case "reasoning":
        // Do not expose chain-of-thought. A status marker is enough for progress visibility.
        if (!done) messages.push({ category: "status", text: "reasoning…" });
        break;
      default:
        if (!done) messages.push({ category: "status", text: `${item.type ?? "item"} started` });
        break;
    }
  }
  return { messages, candidateOutput, usage };
}

export function extractQuestion(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*AIROUTE_QUESTION:\s*(.+?)(?:\n|$)/is);
  const question = match?.[1]?.trim();
  if (question && !/[<>]/.test(question)) return question;

  // Providers occasionally ignore the marker after a tool is denied and turn the
  // denial into a natural-language blocking question. Only recognize a narrow
  // fallback here so optional closing offers do not unexpectedly resume a run.
  const paragraphs = text.trim().split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last || !/\?\s*$/.test(last)) return undefined;
  const blockingSignal = /\b(?:approval|permission|authori[sz]ation|your (?:input|decision|confirmation)|need you to|cannot (?:continue|proceed)|can't (?:continue|proceed)|blocked)\b/i;
  return blockingSignal.test(last) ? last : undefined;
}

export function isApprovalAnswer(answer: string): boolean {
  return /^(?:approve|approved)$/i.test(answer.trim());
}

export function progressFor(agent: Agent, event: any): ParsedProviderEvent {
  return agent === "claude" ? claudeProgress(event) : codexProgress(event);
}

export async function runAgent(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  options: { headless?: boolean; capture?: boolean; logger?: RunLogger; logMeta?: PhaseLogMeta; permissionMode?: RouterConfig["claude"]["permissionMode"] } = {}
): Promise<AgentRunResult> {
  const provider = config[route.agent];
  const headless = options.headless ?? false;
  const capture = options.capture ?? false;
  const structuredProgress = Boolean(options.logger && headless);
  const { args, env } = argsForRoute(route, prompt, config, headless, structuredProgress, options.permissionMode);

  options.logger?.metadata(`command=${provider.command} args=${JSON.stringify(args.slice(0, -1))} promptChars=${prompt.length}`);

  if (!capture && !options.logger) {
    const child = spawn(provider.command, args, { cwd: process.cwd(), stdio: "inherit", env });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code: number | null, signal: string | null) => resolve(signal ? 128 : (code ?? 1)));
    });
    return { exitCode, output: "" };
  }

  const child = spawn(provider.command, args, { cwd: process.cwd(), stdio: ["inherit", "pipe", "pipe"], env });
  let fallbackOutput = "";
  let candidateOutput = "";
  let finalOutput = "";
  let stdoutBuffer = "";
  let stderrOutput = "";
  let question: string | undefined;
  let usage: TokenUsage | undefined;

  const handleStructuredLine = (line: string) => {
    if (!line.trim()) return;
    options.logger?.rawEvent(options.logMeta!, line);
    try {
      const event = JSON.parse(line);
      const progress = progressFor(route.agent, event);
      for (const msg of progress.messages) {
        options.logger?.progress(options.logMeta!, msg.text, msg.category);
        // Structured providers may report failures only as progress events. Keep
        // error text in the captured result so callers can decide whether to
        // retry on another provider.
        if (msg.category === "error") fallbackOutput += `${msg.text}\n`;
        if (!question && msg.category === "message") question = extractQuestion(msg.text);
      }
      if (progress.candidateOutput) candidateOutput = progress.candidateOutput;
      if (progress.finalOutput) finalOutput = progress.finalOutput;
      usage = addTokenUsage(usage, progress.usage);
      const semanticOutput = progress.finalOutput ?? progress.candidateOutput;
      if (!question && semanticOutput) question = extractQuestion(semanticOutput);
    } catch {
      // Forward non-JSON provider output instead of losing it.
      options.logger?.progress(options.logMeta!, line, "output");
      fallbackOutput += `${line}\n`;
    }
  };

  child.stdout?.on("data", (chunk: any) => {
    const s = String(chunk);
    if (structuredProgress) {
      stdoutBuffer += s;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleStructuredLine(line);
    } else {
      fallbackOutput += s;
      process.stdout.write(s);
    }
  });

  child.stderr?.on("data", (chunk: any) => {
    const s = String(chunk);
    stderrOutput += s;
    if (options.logger && options.logMeta) options.logger.stderr(options.logMeta, s);
    else process.stderr.write(s);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code: number | null, signal: string | null) => resolve(signal ? 128 : (code ?? 1)));
  });

  if (structuredProgress && stdoutBuffer.trim()) handleStructuredLine(stdoutBuffer);
  const output = `${(finalOutput || candidateOutput || fallbackOutput).trim()}${exitCode !== 0 && stderrOutput.trim() ? `\n${stderrOutput.trim()}` : ""}`.trim();
  if (!question) question = extractQuestion(output);
  return { exitCode, output, question, usage };
}
