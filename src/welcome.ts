import { DEFAULT_CONFIG } from "./config.js";
import type { RouterConfig } from "./types.js";
import { agentColor, command, divider, sectionRule, ui } from "./ui.js";

function tierDefaults(config: RouterConfig, agent: "claude" | "codex"): string {
  return (["fast", "balanced", "deep"] as const)
    .map(tier => {
      const profile = config[agent].models[tier];
      return `${tier} ${profile.model} (${profile.effort ?? "auto"})`;
    })
    .join(" · ");
}

/** The introduction shown immediately before the interactive first-run setup. */
export function firstRunWelcome(config: RouterConfig = DEFAULT_CONFIG): string {
  const logo = [
    "     █████╗ ██╗██████╗   ██████╗ ",
    "    ██╔══██╗██║██╔══██╗ ██╔═══██╗",
    "    ███████║██║██████╔╝ ██║   ██║",
    "    ██╔══██║██║██╔══██╗ ██║   ██║",
    "    ██║  ██║██║██║  ██║ ╚██████╔╝",
    "    ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝  ╚═════╝ ",
  ].map(line => ui.bold(ui.cyan(line)));

  return [
    "",
    ...logo,
    ui.dim("             Adaptive Intelligence Routing & Orchestration"),
    "",
    divider("Welcome"),
    `${ui.bold("AIRO")} routes each coding task between ${agentColor("claude", "Claude Code")} and ${agentColor("codex", "Codex CLI")}, choosing a model tier for the work.`,
    ui.gray("It uses your existing provider CLI logins; AIRO does not require another API key."),
    sectionRule("Initial defaults"),
    `${agentColor("codex", "Codex ")} ${ui.gray("fast / balanced / deep:")} ${ui.cyan(tierDefaults(config, "codex"))}`,
    `${agentColor("claude", "Claude")} ${ui.gray("fast / balanced / deep:")} ${ui.magenta(tierDefaults(config, "claude"))}`,
    `${ui.gray("Tie-break provider:")} ${agentColor(config.defaultAgent, config.defaultAgent)}`,
    sectionRule("Next"),
    `${ui.gray("Setup will let you choose models for these tiers. Press")} ${ui.bold("Enter")} ${ui.gray("to keep each displayed default.")}`,
    `${ui.gray("Your settings will be saved to")} ${ui.cyan("~/.config/airo/config.json")}.`,
    `${ui.gray("You can revisit them with")} ${command("airo setup")} ${ui.gray("and inspect them with")} ${command("airo models")}.`,
    "",
  ].join("\n");
}
