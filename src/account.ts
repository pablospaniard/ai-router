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
  const result = spawnSync(command, ["auth", "status"], { encoding: "utf8", timeout: 5000 });
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
    : result.status === 0 && /logged\s*in|authenticated/i.test(output);
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
  const result = spawnSync(command, ["login", "status"], { encoding: "utf8", timeout: 5000 });
  if (result.error)
    return {
      agent: "codex",
      available: false,
      authenticated: false,
      status: result.error.message,
      defaultModel,
    };
  const output = (result.stdout || result.stderr || "").trim();
  const authenticated = result.status === 0 && /logged in/i.test(output);
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

export function inspectAccounts(config: RouterConfig, cwd = process.cwd()): ProviderAccount[] {
  const defaults = detectDefaultModels(config, cwd);
  return [
    inspectClaude(config.claude.command, defaults.claude),
    inspectCodex(config.codex.command, defaults.codex),
  ];
}
