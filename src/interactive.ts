import type { Agent, LogLevel, ModelTier } from "./types.js";

export type InteractiveMode = "auto" | "adaptive" | "single";

export interface InteractivePreferences {
  mode: InteractiveMode;
  agent: "auto" | Agent;
  tier?: ModelTier;
  logLevel: LogLevel;
}

export type InteractiveAction =
  | { kind: "empty" }
  | { kind: "task"; task: string }
  | { kind: "quit" }
  | { kind: "help" }
  | { kind: "new"; title?: string }
  | { kind: "status" }
  | { kind: "sessions" }
  | { kind: "models" }
  | { kind: "clear" }
  | { kind: "set-mode"; value: InteractiveMode }
  | { kind: "set-agent"; value: "auto" | Agent }
  | { kind: "set-tier"; value?: ModelTier }
  | { kind: "set-log"; value: LogLevel }
  | { kind: "error"; message: string };

export const INTERACTIVE_COMMANDS = [
  "/help", "/status", "/new", "/sessions", "/models", "/mode",
  "/agent", "/tier", "/log", "/clear", "/exit"
];

export function parseInteractiveInput(input: string): InteractiveAction {
  const value = input.trim();
  if (!value) return { kind: "empty" };
  if (!value.startsWith("/")) return { kind: "task", task: value };

  const [rawCommand, ...args] = value.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const first = args[0]?.toLowerCase();

  if (command === "/exit" || command === "/quit") return { kind: "quit" };
  if (command === "/help" || command === "/?") return { kind: "help" };
  if (command === "/status") return { kind: "status" };
  if (command === "/sessions") return { kind: "sessions" };
  if (command === "/models") return { kind: "models" };
  if (command === "/clear") return { kind: "clear" };
  if (command === "/new") return { kind: "new", title: args.join(" ").trim() || undefined };

  if (command === "/mode") {
    if (first === "auto" || first === "adaptive" || first === "single") return { kind: "set-mode", value: first };
    return { kind: "error", message: "Usage: /mode auto|adaptive|single" };
  }
  if (command === "/agent") {
    if (first === "auto" || first === "claude" || first === "codex") return { kind: "set-agent", value: first };
    return { kind: "error", message: "Usage: /agent auto|claude|codex" };
  }
  if (command === "/tier") {
    if (first === "auto") return { kind: "set-tier", value: undefined };
    if (first === "fast" || first === "balanced" || first === "deep") return { kind: "set-tier", value: first };
    return { kind: "error", message: "Usage: /tier auto|fast|balanced|deep" };
  }
  if (command === "/log") {
    if (first === "compact" || first === "live" || first === "verbose") return { kind: "set-log", value: first };
    return { kind: "error", message: "Usage: /log compact|live|verbose" };
  }
  return { kind: "error", message: `Unknown command: ${rawCommand}. Use /help to list commands.` };
}

export function taskArgs(task: string, preferences: InteractivePreferences): string[] {
  const args = ["--continue"];
  if (preferences.mode === "adaptive") args.push("--adaptive");
  if (preferences.mode === "single") args.push("--single");
  if (preferences.agent !== "auto") args.push("--agent", preferences.agent);
  if (preferences.tier) args.push("--tier", preferences.tier);
  args.push("--log", preferences.logLevel, task);
  return args;
}
