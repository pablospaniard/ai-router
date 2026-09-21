import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * The shell probes run `-i` so version-manager PATH setup in `.zshrc` applies,
 * but an interactive shell opens the controlling terminal and takes over its
 * foreground process group. That leaves the parent's next terminal read failing
 * with EIO, which killed the interactive prompt after every command. `detached`
 * starts a new session, so the shell has no terminal to take.
 *
 * Provider CLIs are usually installed by a version manager whose PATH only
 * exists in an interactive login shell, so a plain `spawnSync` from a GUI
 * launched process cannot find them. Every probe in AIRO resolves the binary
 * and the environment through the user's login shell for that reason.
 */
export function resolveCommand(command: string): { command?: string; error?: string } {
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
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

export function loginShellEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === "win32") return { ...process.env };
  const shell = process.env.SHELL || "/bin/sh";
  const marker = "__AIRO_ENV_BEGIN__";
  const result = spawnSync(shell, ["-ilc", `printf '${marker}\\0'; env -0`], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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

/**
 * Run a provider CLI for inspection only. `stdin` is closed on purpose: some
 * CLIs treat an unrecognised subcommand as a prompt and would otherwise wait
 * forever for input that a probe is never going to send.
 */
export function runProviderCommand(
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
      stdio: ["ignore", "pipe", "pipe"],
      env: loginShellEnvironment(),
    }),
  };
}

export function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Read a top-level string assignment out of a TOML file without a parser. */
export function readTomlValue(file: string, key: string): string | undefined {
  try {
    const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`);
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(pattern);
      if (match) return match[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read a string assignment from a named TOML table. */
export function readTomlTableValue(file: string, table: string[], key: string): string | undefined {
  try {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tablePattern = new RegExp(
      `^\\s*\\[\\s*${table
        .map((part) => `(?:${escape(part)}|["']${escape(part)}["'])`)
        .join("\\s*\\.\\s*")}\\s*\\]\\s*(?:#.*)?$`,
    );
    const valuePattern = new RegExp(`^\\s*${escape(key)}\\s*=\\s*["']([^"']+)["']`);
    let inTable = false;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        inTable = tablePattern.test(line);
        continue;
      }
      if (!inTable) continue;
      const match = line.match(valuePattern);
      if (match) return match[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}
