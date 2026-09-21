import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Agent, RouterConfig } from "./types.js";

export interface ProviderAccount {
  agent: Agent;
  available: boolean;
  authenticated: boolean;
  authMethod?: string;
  identity?: string;
  status: string;
  defaultModel?: string;
}

function resolveCommand(command: string): { command?: string; error?: string } {
  if (process.platform === "win32" || command.includes(path.sep)) {
    return { command };
  }
  const shell = process.env.SHELL || "/bin/sh";
  const marker = "__AIRO_COMMAND_BEGIN__";
  const result = spawnSync(
    shell,
    ["-ilc", `printf '${marker}\\n'; command -v -- "$1"`, "airo", command],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (result.error) return { error: result.error.message };
  const output = result.stdout || "";
  const markerIndex = output.indexOf(`${marker}\n`);
  const marked = markerIndex >= 0 ? output.slice(markerIndex + marker.length + 1) : output;
  const resolved = (marked || output)
    .trim()
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter(Boolean)
    .at(-1);
  return resolved ? { command: resolved } : { error: `${command} not found in PATH` };
}

function loginShellEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === "win32") return { ...process.env };
  const shell = process.env.SHELL || "/bin/sh";
  const marker = "__AIRO_ENV_BEGIN__";
  const result = spawnSync(shell, ["-ilc", `printf '${marker}\\0'; env -0`], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return { ...process.env };
  const raw = result.stdout || "";
  const start = raw.indexOf(`${marker}\0`);
  if (start < 0) return { ...process.env };
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of raw.slice(start + marker.length + 1).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function runProviderCommand(
  command: string,
  args: string[],
):
  | { result: ReturnType<typeof spawnSync>; command?: string; error?: string }
  | { result?: undefined; command?: string; error: string } {
  const resolved = resolveCommand(command);
  if (!resolved.command) return { error: resolved.error ?? `${command} not found in PATH` };
  return {
    command: resolved.command,
    result: spawnSync(resolved.command, args, {
      encoding: "utf8",
      timeout: 5000,
      env: loginShellEnvironment(),
    }),
  };
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readTomlModel(file: string): string | undefined {
  try {
    const match = fs.readFileSync(file, "utf8").match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * `Not logged in` contains `logged in`, so a plain match reports an
 * unauthenticated provider as ready. Check the negation first.
 */
function isNegatedSignIn(output: string): boolean {
  return /\b(?:not|never|isn'?t|aren'?t)\s+(?:currently\s+)?(?:logged\s*in|signed\s*in|authenticated)\b|\bno\s+(?:active\s+)?(?:account|credentials|session)\b/i.test(
    output,
  );
}

function claudeSettingsModel(cwd: string): string | undefined {
  const files = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
  let model: string | undefined;
  for (const file of files) {
    const value = readJson(file)?.model;
    if (typeof value === "string" && value.trim()) model = value.trim();
  }
  return model;
}

export function detectDefaultModels(
  config: RouterConfig,
  cwd = process.cwd(),
): Partial<Record<Agent, string>> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    claude: config.claude.defaultModel || process.env.ANTHROPIC_MODEL || claudeSettingsModel(cwd),
    codex: config.codex.defaultModel || readTomlModel(path.join(codexHome, "config.toml")),
    gemini: config.gemini.defaultModel,
    copilot: config.copilot.defaultModel,
  };
}

function inspectClaude(command: string, defaultModel?: string): ProviderAccount {
  const checked = runProviderCommand(command, ["auth", "status"]);
  if (!checked.result)
    return {
      agent: "claude",
      available: false,
      authenticated: false,
      status: checked.error ?? `${command} not found in PATH`,
      defaultModel,
    };
  const result = checked.result;
  if (result.error)
    return {
      agent: "claude",
      available: false,
      authenticated: false,
      status: result.error.message,
      defaultModel,
    };
  const output = (result.stdout || result.stderr || "").trim();
  const parsed = (() => {
    try {
      return JSON.parse(output);
    } catch {
      return undefined;
    }
  })();
  const authenticated = parsed
    ? Boolean(parsed.loggedIn)
    : result.status === 0 && !isNegatedSignIn(output) && /logged\s*in|authenticated/i.test(output);
  const identity = parsed?.emailAddress ?? parsed?.email ?? parsed?.account?.email;
  const authMethod = parsed?.authMethod ?? parsed?.subscriptionType;
  return {
    agent: "claude",
    available: true,
    authenticated,
    authMethod,
    identity: typeof identity === "string" ? identity : undefined,
    status: authenticated ? "authenticated" : "not authenticated",
    defaultModel,
  };
}

function inspectCodex(command: string, defaultModel?: string): ProviderAccount {
  const checked = runProviderCommand(command, ["login", "status"]);
  if (!checked.result)
    return {
      agent: "codex",
      available: false,
      authenticated: false,
      status: checked.error ?? `${command} not found in PATH`,
      defaultModel,
    };
  const result = checked.result;
  if (result.error)
    return {
      agent: "codex",
      available: false,
      authenticated: false,
      status: result.error.message,
      defaultModel,
    };
  const output = (result.stdout || result.stderr || "").trim();
  const authenticated =
    result.status === 0 && !isNegatedSignIn(output) && /logged in/i.test(output);
  const method = output.match(/logged in using\s+(.+)/i)?.[1]?.trim();
  return {
    agent: "codex",
    available: true,
    authenticated,
    authMethod: method,
    status: authenticated ? "authenticated" : output || `status command exited ${result.status}`,
    defaultModel,
  };
}

/**
 * Inspect one provider account. Returns undefined for providers without a
 * sign-in probe, so callers can treat them as "unknown" rather than broken.
 */
export function inspectAccount(
  agent: Agent,
  config: RouterConfig,
  cwd = process.cwd(),
): ProviderAccount | undefined {
  const defaults = detectDefaultModels(config, cwd);
  if (agent === "claude") return inspectClaude(config.claude.command, defaults.claude);
  if (agent === "codex") return inspectCodex(config.codex.command, defaults.codex);
  return undefined;
}

export function inspectAccounts(config: RouterConfig, cwd = process.cwd()): ProviderAccount[] {
  return [inspectAccount("claude", config, cwd)!, inspectAccount("codex", config, cwd)!];
}
