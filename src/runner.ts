import { spawn, spawnSync } from "node:child_process";
import type { Agent, AgentRunResult, RouteResult, RouterConfig } from "./types.js";
import type { PhaseLogMeta, RunLogger } from "./logging.js";

export function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

export function commandVersion(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (result.error) return `ERROR: ${result.error.message}`;
  return (result.stdout || result.stderr || "").trim() || `exit ${result.status}`;
}

function argsForRoute(route: RouteResult, prompt: string, config: RouterConfig, headless: boolean, structuredProgress: boolean): { args: string[]; env: any } {
  const provider = config[route.agent];
  const env: any = { ...process.env };
  const args = [...(provider.args ?? [])];

  if (route.agent === "claude") {
    if (headless) args.push("-p");
    args.push("--model", route.model);
    if (structuredProgress && headless) args.push("--output-format", "stream-json", "--verbose");
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

function compactJson(value: unknown, max = 280): string {
  let s: string;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function claudeProgress(event: any): { messages: Array<{ category: string; text: string }>; output: string[] } {
  const messages: Array<{ category: string; text: string }> = [];
  const output: string[] = [];
  if (!event || typeof event !== "object") return { messages, output };

  if (event.type === "system") {
    if (event.subtype === "init") messages.push({ category: "system", text: `initialized${event.model ? ` model=${event.model}` : ""}${event.session_id ? ` session=${event.session_id}` : ""}` });
    else if (event.subtype === "api_retry") messages.push({ category: "retry", text: `API retry ${event.attempt ?? "?"}/${event.max_retries ?? "?"} in ${event.retry_delay_ms ?? "?"}ms (${event.error ?? "unknown"})` });
    else if (event.subtype === "plugin_install") messages.push({ category: "system", text: `plugin install ${event.status ?? "update"}${event.name ? `: ${event.name}` : ""}` });
  }

  if (event.type === "assistant" && event.message?.content && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block?.type === "text" && block.text) {
        messages.push({ category: "message", text: String(block.text) });
        output.push(String(block.text));
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
    if (event.result && output.length === 0) output.push(String(event.result));
    const bits = [event.subtype ?? "completed"];
    if (event.duration_ms != null) bits.push(`${Math.round(event.duration_ms/1000)}s`);
    if (event.total_cost_usd != null) bits.push(`cost=$${Number(event.total_cost_usd).toFixed(4)}`);
    messages.push({ category: "result", text: bits.join(" ") });
  }

  // Intentionally do not surface raw thinking/reasoning content.
  return { messages, output };
}

function codexProgress(event: any): { messages: Array<{ category: string; text: string }>; output: string[] } {
  const messages: Array<{ category: string; text: string }> = [];
  const output: string[] = [];
  if (!event || typeof event !== "object") return { messages, output };

  if (event.type === "thread.started") messages.push({ category: "system", text: `thread started${event.thread_id ? ` ${event.thread_id}` : ""}` });
  else if (event.type === "turn.started") messages.push({ category: "system", text: "turn started" });
  else if (event.type === "turn.failed") messages.push({ category: "error", text: `turn failed${event.error?.message ? `: ${event.error.message}` : ""}` });
  else if (event.type === "error") messages.push({ category: "error", text: event.message ?? compactJson(event) });
  else if (event.type === "turn.completed") {
    const u = event.usage;
    messages.push({ category: "result", text: u ? `turn completed tokens in=${u.input_tokens ?? "?"} cached=${u.cached_input_tokens ?? "?"} out=${u.output_tokens ?? "?"}` : "turn completed" });
  }

  if ((event.type === "item.started" || event.type === "item.completed") && event.item) {
    const item = event.item;
    const done = event.type === "item.completed";
    switch (item.type) {
      case "command_execution":
        messages.push({ category: "tool", text: `${done ? "command completed" : "command"}: ${item.command ?? ""}${done && item.exit_code != null ? ` (exit ${item.exit_code})` : ""}` });
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
          output.push(String(item.text));
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
  return { messages, output };
}

function extractQuestion(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*AIROUTE_QUESTION:\s*(.+?)(?:\n|$)/is);
  return match?.[1]?.trim();
}

function progressFor(agent: Agent, event: any) {
  return agent === "claude" ? claudeProgress(event) : codexProgress(event);
}

export async function runAgent(
  route: RouteResult,
  prompt: string,
  config: RouterConfig,
  options: { headless?: boolean; capture?: boolean; logger?: RunLogger; logMeta?: PhaseLogMeta } = {}
): Promise<AgentRunResult> {
  const provider = config[route.agent];
  const headless = options.headless ?? false;
  const capture = options.capture ?? false;
  const structuredProgress = Boolean(options.logger && headless);
  const { args, env } = argsForRoute(route, prompt, config, headless, structuredProgress);

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
  let output = "";
  let stdoutBuffer = "";
  let question: string | undefined;

  const handleStructuredLine = (line: string) => {
    if (!line.trim()) return;
    options.logger?.rawEvent(options.logMeta!, line);
    try {
      const event = JSON.parse(line);
      const progress = progressFor(route.agent, event);
      for (const msg of progress.messages) {
        options.logger?.progress(options.logMeta!, msg.text, msg.category);
        if (!question && msg.category === "message") question = extractQuestion(msg.text);
      }
      if (progress.output.length) {
        const joined = progress.output.join("\n");
        output += `${joined}\n`;
        if (!question) question = extractQuestion(joined);
      }
    } catch {
      // Forward non-JSON provider output instead of losing it.
      options.logger?.progress(options.logMeta!, line, "output");
      output += `${line}\n`;
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
      output += s;
      process.stdout.write(s);
    }
  });

  child.stderr?.on("data", (chunk: any) => {
    const s = String(chunk);
    if (options.logger && options.logMeta) options.logger.stderr(options.logMeta, s);
    else process.stderr.write(s);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code: number | null, signal: string | null) => resolve(signal ? 128 : (code ?? 1)));
  });

  if (structuredProgress && stdoutBuffer.trim()) handleStructuredLine(stdoutBuffer);
  if (!question) question = extractQuestion(output);
  return { exitCode, output: output.trim(), question };
}
