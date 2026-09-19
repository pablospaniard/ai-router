const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (open: string, close: string, value: string) => enabled ? `${open}${value}${close}` : value;

export const ui = {
  dim: (s: string) => wrap("\x1b[2m", "\x1b[22m", s),
  bold: (s: string) => wrap("\x1b[1m", "\x1b[22m", s),
  cyan: (s: string) => wrap("\x1b[36m", "\x1b[39m", s),
  blue: (s: string) => wrap("\x1b[34m", "\x1b[39m", s),
  green: (s: string) => wrap("\x1b[32m", "\x1b[39m", s),
  yellow: (s: string) => wrap("\x1b[33m", "\x1b[39m", s),
  red: (s: string) => wrap("\x1b[31m", "\x1b[39m", s),
  magenta: (s: string) => wrap("\x1b[35m", "\x1b[39m", s),
  gray: (s: string) => wrap("\x1b[90m", "\x1b[39m", s),
  white: (s: string) => wrap("\x1b[37m", "\x1b[39m", s),
};

export function brand(s = "airo"): string { return ui.bold(ui.cyan(s)); }
export function agentColor(agent: "claude" | "codex", s: string): string { return agent === "claude" ? ui.magenta(s) : ui.cyan(s); }
export function tierColor(tier: string): string { return tier === "fast" ? ui.green(tier) : tier === "balanced" ? ui.yellow(tier) : ui.red(tier); }
export function statusIcon(kind: "ok" | "error" | "work" | "ask" | "info"): string {
  if (kind === "ok") return ui.green("✓");
  if (kind === "error") return ui.red("✗");
  if (kind === "ask") return ui.yellow("?");
  if (kind === "work") return ui.blue("◆");
  return ui.gray("•");
}
export function divider(title?: string): string {
  const body = title ? ` ${title} ` : "";
  const width = Math.max(24, 58 - body.length);
  return ui.gray(`${"─".repeat(Math.floor(width/2))}${body}${"─".repeat(Math.ceil(width/2))}`);
}
export function sectionRule(title: string, width = 68): string {
  const label = ` ${title} `;
  return ui.gray(`──${label}${"─".repeat(Math.max(0, width - label.length - 2))}`);
}
export function promptLabel(): string { return `${ui.green("❯")} `; }
export function command(s: string): string { return ui.bold(ui.cyan(s)); }

function plainText(value: string): string { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function visibleLength(value: string): number { return plainText(value).length; }

export function panel(title: string, lines: string[], width = 68): string {
  const inner = Math.max(24, width - 4);
  const topTitle = ` ${title} `;
  const top = `╭${topTitle}${"─".repeat(Math.max(0, width - topTitle.length - 2))}╮`;
  const body = lines.map(line => {
    const clipped = visibleLength(line) > inner ? `${plainText(line).slice(0, Math.max(0, inner - 1))}…` : line;
    return `│ ${clipped}${" ".repeat(Math.max(0, inner - visibleLength(clipped)))} │`;
  });
  return [ui.cyan(top), ...body, ui.cyan(`╰${"─".repeat(width - 2)}╯`)].join("\n");
}
