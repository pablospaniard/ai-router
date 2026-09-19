import readline from "node:readline";
import { DEFAULT_CONFIG, loadConfig, writeGlobalConfig } from "./config.js";
import type { Agent, Effort, ModelProfile, ModelTier, RouterConfig } from "./types.js";
import { agentColor, divider, promptLabel, statusIcon, ui } from "./ui.js";
import { detectDefaultModels } from "./account.js";

function ask(rl: any, question: string): Promise<string> {
  return new Promise(resolve => rl.question(`${promptLabel()}${question} `, resolve));
}

function parseSelection(input: string, max: number): number[] {
  return [...new Set(input.split(",").map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n >= 1 && n <= max))];
}

async function pickModels(rl: any, agent: Agent, candidates: string[], current: string[]): Promise<string[]> {
  console.log("");
  console.log(divider(`${agentColor(agent, agent.toUpperCase())} models`));
  console.log(ui.dim("Select every model this router is allowed to use."));
  candidates.forEach((m, i) => {
    const selected = current.includes(m);
    console.log(`  ${selected ? statusIcon("ok") : ui.gray("○")} ${ui.cyan(String(i + 1).padStart(2))}  ${ui.bold(m)}`);
  });
  const defaults = candidates.map((m,i)=>current.includes(m)?i+1:0).filter(Boolean).join(",");
  const answer = (await ask(rl, `Select ${agentColor(agent, agent)} models [${ui.dim(defaults || "all")}]:`)).trim();
  const indexes = answer ? parseSelection(answer, candidates.length) : (defaults ? parseSelection(defaults, candidates.length) : candidates.map((_,i)=>i+1));
  const selected = indexes.length ? indexes.map(i=>candidates[i-1]) : current;
  const extra = (await ask(rl, `Additional ${agentColor(agent, agent)} model IDs, comma-separated [${ui.dim("none")}]:`)).trim();
  const extras = extra ? extra.split(",").map(x=>x.trim()).filter(Boolean) : [];
  return [...new Set([...selected, ...extras])];
}

async function pickTier(rl: any, agent: Agent, tier: ModelTier, models: string[], current: ModelProfile): Promise<ModelProfile> {
  console.log("");
  console.log(`${statusIcon("info")} ${ui.bold(tier.toUpperCase())} ${ui.gray("tier")}`);
  models.forEach((m,i)=>console.log(`    ${m===current.model?statusIcon("ok"):ui.gray("○")} ${ui.cyan(String(i+1))} ${m}`));
  const currentIndex = Math.max(0, models.indexOf(current.model));
  const answer = (await ask(rl, `Model for ${ui.bold(tier)} [${currentIndex+1}]:`)).trim();
  const idx = answer && Number(answer)>=1 && Number(answer)<=models.length ? Number(answer)-1 : currentIndex;
  const effort = ((await ask(rl, `Effort for ${ui.bold(tier)} [${ui.dim(current.effort ?? "auto")}]:`)).trim() || current.effort || "auto") as Effort;
  return { model: models[idx], effort };
}

export async function runSetup(): Promise<string> {
  const existing = loadConfig().config;
  const config: RouterConfig = JSON.parse(JSON.stringify(existing));

  console.log("");
  console.log(ui.bold(ui.cyan("╭────────────────────────────────────────────────────────╮")));
  console.log(ui.bold(ui.cyan("│                    AIRO SETUP                         │")));
  console.log(ui.bold(ui.cyan("╰────────────────────────────────────────────────────────╯")));
  console.log(`${statusIcon("info")} ${ui.bold("Choose models once; routing remains automatic afterwards.")}`);
  console.log(`${ui.gray("Config")} ${ui.cyan("~/.config/airo/config.json")}`);
  console.log(`${ui.gray("Tip   ")} ${ui.yellow("Run `airo setup` anytime to review or change this list.")}`);

  const rl = readline.createInterface({input:process.stdin, output:process.stdout});
  try {
    const claudeCandidates = [...new Set([...(DEFAULT_CONFIG.claude.allowedModels ?? []), ...(config.claude.allowedModels ?? [])])];
    const codexCandidates = [...new Set([...(DEFAULT_CONFIG.codex.allowedModels ?? []), ...(config.codex.allowedModels ?? [])])];
    config.claude.allowedModels = await pickModels(rl, "claude", claudeCandidates, config.claude.allowedModels ?? claudeCandidates);
    config.codex.allowedModels = await pickModels(rl, "codex", codexCandidates, config.codex.allowedModels ?? codexCandidates);

    console.log(""); console.log(divider("Tier mapping"));
    console.log(ui.dim("Map your selected models to fast / balanced / deep."));
    for (const agent of ["claude","codex"] as const) {
      console.log(""); console.log(ui.bold(agentColor(agent, agent.toUpperCase())));
      for (const tier of ["fast","balanced","deep"] as const) {
        config[agent].models[tier] = await pickTier(rl, agent, tier, config[agent].allowedModels ?? [], config[agent].models[tier]);
      }
    }

    console.log(""); console.log(divider("Usage comparison"));
    console.log(ui.dim("AIRO compares measured runs with each provider's normal default model."));
    const detectedDefaults = detectDefaultModels(config);
    for (const agent of ["claude", "codex"] as const) {
      const current = config[agent].defaultModel;
      const automatic = detectedDefaults[agent] ?? "not detected";
      const hint = current ? current : `auto: ${automatic}`;
      const answer = (await ask(rl, `Default ${agentColor(agent, agent)} model for comparison [${ui.dim(hint)}]:`)).trim();
      if (answer.toLowerCase() === "auto") delete config[agent].defaultModel;
      else if (answer) config[agent].defaultModel = answer;
    }

    const tie = (await ask(rl, `Default provider on a tie [${agentColor(config.defaultAgent, config.defaultAgent)}]:`)).trim().toLowerCase();
    if (tie === "claude" || tie === "codex") config.defaultAgent = tie;

    const file = writeGlobalConfig(config);
    console.log(""); console.log(divider("Setup complete"));
    console.log(`${statusIcon("ok")} ${ui.green("Saved")} ${ui.cyan(file)}`);
    console.log(`${statusIcon("info")} ${ui.yellow("Review/modify later:")} ${ui.bold("airo setup")} ${ui.gray("or edit the config file directly")}`);
    console.log(`${statusIcon("info")} ${ui.gray("Inspect active mapping:")} ${ui.bold("airo models")}`);
    return file;
  } finally { rl.close(); }
}
