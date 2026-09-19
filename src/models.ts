import { loadConfig } from "./config.js";
import { agentColor, divider, statusIcon, ui } from "./ui.js";

export function printModels() {
  const { config, path } = loadConfig();
  console.log("");
  console.log(divider("Active model configuration"));
  console.log(`${ui.gray("config")} ${path ? ui.cyan(path) : ui.yellow("built-in defaults")}`);
  for (const agent of ["claude", "codex"] as const) {
    console.log("");
    console.log(`${statusIcon("info")} ${ui.bold(agentColor(agent, agent.toUpperCase()))}`);
    console.log(`  ${ui.gray("access ")} ${ui.bold("all provider models")}`);
    for (const tier of ["fast", "balanced", "deep"] as const) {
      const p = config[agent].models[tier];
      const label =
        tier === "fast"
          ? ui.green(tier.padEnd(18))
          : tier === "balanced"
            ? ui.yellow(tier.padEnd(18))
            : ui.red(tier.padEnd(18));
      console.log(
        `  ${label} ${ui.cyan(p.model)} ${ui.gray("effort=")}${ui.magenta(p.effort ?? "auto")}`,
      );
    }
  }
  console.log("");
  console.log(
    `${ui.yellow("NOTE")} ${ui.dim("These three tiers are automatic defaults. Use `--model` or name a model in your task to override them.")}`,
  );
}
