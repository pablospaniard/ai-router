import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RouterConfig } from "./types.js";

export const CONFIG_NOTE = "Review or change available models anytime with `airo setup`, or edit this file directly.";

export const DEFAULT_CONFIG: RouterConfig = {
  policy: "balanced",
  defaultAgent: "codex",
  claude: {
    command: "claude",
    args: [],
    allowedModels: ["haiku", "sonnet", "opus"],
    models: {
      fast: { model: "haiku", effort: "low" },
      balanced: { model: "sonnet", effort: "medium" },
      deep: { model: "opus", effort: "high" }
    }
  },
  codex: {
    command: "codex",
    args: [],
    allowedModels: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    models: {
      fast: { model: "gpt-5.6-luna", effort: "low" },
      balanced: { model: "gpt-5.6-terra", effort: "medium" },
      deep: { model: "gpt-5.6-sol", effort: "xhigh" }
    }
  },
  history: { enabled: true, learningEnabled: true, similarityThreshold: 0.25 },
  logging: { level: "live", persist: true },
  orchestration: {
    mode: "auto", maxPhases: 6, autoReview: true, recoverOnFailure: true,
    stopOnFailure: false, outputTailChars: 5000
  },
  rules: []
};

export function configCandidates(cwd = process.cwd()): string[] {
  return [
    path.join(cwd, ".airo.json"),
    path.join(cwd, ".ai-router.json"),
    path.join(os.homedir(), ".config", "airo", "config.json"),
    path.join(os.homedir(), ".config", "ai-router", "config.json")
  ];
}

export function globalConfigPath(): string {
  return path.join(os.homedir(), ".config", "airo", "config.json");
}

function mergeProvider(base: RouterConfig["claude"], value: any): RouterConfig["claude"] {
  return {
    ...base,
    ...(value ?? {}),
    allowedModels: value?.allowedModels ?? base.allowedModels,
    models: {
      fast: { ...base.models.fast, ...(value?.models?.fast ?? {}) },
      balanced: { ...base.models.balanced, ...(value?.models?.balanced ?? {}) },
      deep: { ...base.models.deep, ...(value?.models?.deep ?? {}) }
    }
  };
}

export function loadConfig(cwd = process.cwd()): { config: RouterConfig; path?: string } {
  for (const file of configCandidates(cwd)) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { config: {
      ...DEFAULT_CONFIG, ...parsed,
      claude: mergeProvider(DEFAULT_CONFIG.claude, parsed.claude),
      codex: mergeProvider(DEFAULT_CONFIG.codex, parsed.codex),
      history: { ...DEFAULT_CONFIG.history, ...(parsed.history ?? {}) },
      orchestration: { ...DEFAULT_CONFIG.orchestration, ...(parsed.orchestration ?? {}) },
      logging: { ...DEFAULT_CONFIG.logging, ...(parsed.logging ?? {}) },
      rules: Array.isArray(parsed.rules) ? parsed.rules : []
    }, path: file };
  }
  return { config: DEFAULT_CONFIG };
}

export function writeProjectConfig(cwd = process.cwd()): string {
  const file = path.join(cwd, ".airo.json");
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  fs.writeFileSync(file, JSON.stringify({ _comment: CONFIG_NOTE, ...DEFAULT_CONFIG }, null, 2) + "\n");
  return file;
}

export function writeGlobalConfig(config: RouterConfig): string {
  const file = globalConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ _comment: CONFIG_NOTE, ...config }, null, 2) + "\n");
  return file;
}
