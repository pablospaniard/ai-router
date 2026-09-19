import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, LogLevel, PhaseKind } from "./types.js";
import { agentColor, brand, divider, statusIcon, tierColor, ui } from "./ui.js";

export interface RunLoggerOptions {
  runId: string;
  sessionId?: string;
  level: LogLevel;
}

export interface PhaseLogMeta {
  phaseIndex: number;
  phaseTotal: number;
  phaseKind: PhaseKind | "single";
  agent: Agent;
  model: string;
  effort: string;
  tier: string;
}

function nowTime(): string {
  return new Date().toISOString().slice(11, 19);
}

function dataDir(): string {
  const dir = path.join(os.homedir(), ".local", "share", "ai-router", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(v: string): string {
  return v.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export class RunLogger {
  readonly runId: string;
  readonly sessionId?: string;
  readonly level: LogLevel;
  readonly runDir: string;
  readonly combinedPath: string;

  constructor(options: RunLoggerOptions) {
    this.runId = options.runId;
    this.sessionId = options.sessionId;
    this.level = options.level;
    const parent = this.sessionId ? `session-${safeName(this.sessionId)}` : "standalone";
    this.runDir = path.join(dataDir(), parent, `run-${safeName(this.runId)}`);
    fs.mkdirSync(this.runDir, { recursive: true });
    this.combinedPath = path.join(this.runDir, "combined.log");
  }

  private append(file: string, value: string) {
    fs.appendFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
  }

  private console(value: string) {
    process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
  }

  private prettyStatus(message: string): string {
    if (message.includes(" complete")) return `${ui.gray(nowTime())} ${statusIcon("ok")} ${ui.bold("airoute")} ${message}`;
    if (message.includes("phase ") || message.includes("started")) return `${ui.gray(nowTime())} ${statusIcon("work")} ${ui.bold("airoute")} ${message}`;
    if (message.includes("question") || message.includes("input")) return `${ui.gray(nowTime())} ${statusIcon("ask")} ${ui.bold("airoute")} ${ui.yellow(message)}`;
    return `${ui.gray(nowTime())} ${statusIcon("info")} ${ui.bold("airoute")} ${message}`;
  }

  status(message: string) {
    const line = `${nowTime()} [airoute] ${message}`;
    this.append(this.combinedPath, line);
    this.console(this.prettyStatus(message));
  }

  metadata(message: string) {
    const line = `${nowTime()} [meta] ${message}`;
    this.append(this.combinedPath, line);
    if (this.level === "verbose") this.console(`${ui.gray(nowTime())} ${ui.gray("[meta]")} ${ui.dim(message)}`);
  }

  phaseFile(meta: PhaseLogMeta): string {
    const index = String(meta.phaseIndex).padStart(2, "0");
    return path.join(this.runDir, `${index}-${safeName(meta.phaseKind)}-${safeName(meta.agent)}.log`);
  }

  eventsFile(meta: PhaseLogMeta): string {
    const index = String(meta.phaseIndex).padStart(2, "0");
    return path.join(this.runDir, `${index}-${safeName(meta.phaseKind)}-${safeName(meta.agent)}.events.jsonl`);
  }

  rawEvent(meta: PhaseLogMeta, rawLine: string) {
    this.append(this.eventsFile(meta), rawLine);
  }

  progress(meta: PhaseLogMeta, message: string, category = "ai") {
    if (!message.trim()) return;
    const lines = message.replace(/\r/g, "").split("\n").filter(Boolean);
    for (const text of lines) {
      const line = `${nowTime()} [${meta.phaseKind}][${meta.agent}][${category}] ${text}`;
      this.append(this.phaseFile(meta), line);
      this.append(this.combinedPath, line);
      if (this.level !== "compact") {
        const prefix = `${ui.gray(nowTime())} ${agentColor(meta.agent, `[${meta.phaseKind}]`)} ${agentColor(meta.agent, `[${meta.agent}]`)} ${ui.gray(`[${category}]`)}`;
        const colored = category === "error" ? ui.red(text) : category === "message" ? ui.bold(text) : category === "tool" || category === "file" ? ui.cyan(text) : text;
        this.console(`${prefix} ${colored}`);
      }
    }
  }

  stderr(meta: PhaseLogMeta, chunk: string) {
    // stderr often contains useful provider progress. Persist it always; show it only in verbose.
    const lines = chunk.replace(/\r/g, "").split("\n").filter(Boolean);
    for (const text of lines) {
      const line = `${nowTime()} [${meta.phaseKind}][${meta.agent}][stderr] ${text}`;
      this.append(this.phaseFile(meta), line);
      this.append(this.combinedPath, line);
      if (this.level === "verbose") this.console(`${ui.gray(nowTime())} ${agentColor(meta.agent, `[${meta.phaseKind}]`)} ${agentColor(meta.agent, `[${meta.agent}]`)} ${ui.red("[stderr]")} ${ui.red(text)}`);
    }
  }

  phaseStart(meta: PhaseLogMeta) {
    this.status(`phase ${meta.phaseIndex}/${meta.phaseTotal}: ${meta.phaseKind} → ${meta.agent}/${meta.model} effort=${meta.effort} tier=${meta.tier}`);
    this.metadata(`phase-log=${this.phaseFile(meta)}`);
    this.metadata(`events=${this.eventsFile(meta)}`);
  }

  phaseEnd(meta: PhaseLogMeta, exitCode: number, durationMs: number) {
    this.status(`phase ${meta.phaseIndex}/${meta.phaseTotal} complete: ${meta.phaseKind} exit=${exitCode} duration=${(durationMs/1000).toFixed(1)}s`);
  }

  question(question: string) {
    const line = `${nowTime()} [airoute][question] ${question}`;
    this.append(this.combinedPath, line);
    this.console("");
    this.console(divider("Input needed"));
    this.console(`${statusIcon("ask")} ${ui.yellow(ui.bold(question))}`);
  }

  finalOutput(output: string) {
    const clean = output.trim();
    if (!clean) return;
    const file = path.join(this.runDir, "final-output.txt");
    fs.writeFileSync(file, `${clean}\n`);
    this.append(this.combinedPath, `${nowTime()} [airoute][final] ${clean.replace(/\n/g, "\n[final] ")}`);

    this.console("");
    this.console(divider("Final answer"));
    this.console(ui.white(clean));
    this.console(divider());
  }
}

export function logsRoot(): string {
  return dataDir();
}

export function findRunLogs(runId: string): string | undefined {
  const root = dataDir();
  const sessions = fs.readdirSync(root, { withFileTypes: true }).filter((x: any) => x.isDirectory());
  for (const session of sessions) {
    const candidate = path.join(root, session.name, `run-${safeName(runId)}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function recentRunDirs(limit = 20): Array<{ runId: string; path: string; mtime: Date }> {
  const root = dataDir();
  const out: Array<{ runId: string; path: string; mtime: Date }> = [];
  for (const session of fs.readdirSync(root, { withFileTypes: true }).filter((x: any) => x.isDirectory())) {
    const sessionPath = path.join(root, session.name);
    for (const run of fs.readdirSync(sessionPath, { withFileTypes: true }).filter((x: any) => x.isDirectory() && x.name.startsWith("run-"))) {
      const p = path.join(sessionPath, run.name);
      out.push({ runId: run.name.slice(4), path: p, mtime: fs.statSync(p).mtime });
    }
  }
  return out.sort((a,b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, limit);
}

export async function followFile(file: string): Promise<void> {
  if (!fs.existsSync(file)) throw new Error(`Log file not found: ${file}`);
  let offset = 0;
  const printNew = () => {
    const stat = fs.statSync(file);
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = stat.size;
    process.stdout.write(buf.toString());
  };
  printNew();
  await new Promise<void>((resolve) => {
    const watcher = fs.watch(file, () => printNew());
    const stop = () => { watcher.close(); resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
