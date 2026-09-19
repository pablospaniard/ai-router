import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SessionState, SessionTurn } from "./types.js";
import { dataRootDir } from "./paths.js";

function rootDir(): string {
  const dir = dataRootDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionsDir(): string {
  const dir = path.join(rootDir(), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function activeMapPath(): string {
  return path.join(rootDir(), "active-sessions.json");
}
function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

function readActiveMap(): Record<string, string> {
  const p = activeMapPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeActiveMap(map: Record<string, string>) {
  fs.writeFileSync(activeMapPath(), JSON.stringify(map, null, 2) + "\n");
}

export function createSession(originalTask: string, cwd = process.cwd()): SessionState {
  const now = new Date().toISOString();
  const s: SessionState = {
    sessionId: crypto.randomBytes(5).toString("hex"),
    cwd: path.resolve(cwd),
    createdAt: now,
    updatedAt: now,
    originalTask,
    turns: [],
  };
  saveSession(s);
  setActiveSession(s.cwd, s.sessionId);
  return s;
}

export function saveSession(s: SessionState) {
  s.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionPath(s.sessionId), JSON.stringify(s, null, 2) + "\n");
}

export function loadSession(id: string): SessionState {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) throw new Error(`Session not found: ${id}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function setActiveSession(cwd: string, id: string) {
  const map = readActiveMap();
  map[path.resolve(cwd)] = id;
  writeActiveMap(map);
}

export function getActiveSession(cwd = process.cwd()): SessionState | undefined {
  const id = readActiveMap()[path.resolve(cwd)];
  if (!id) return undefined;
  try {
    return loadSession(id);
  } catch {
    return undefined;
  }
}

export function clearActiveSession(cwd = process.cwd()) {
  const map = readActiveMap();
  delete map[path.resolve(cwd)];
  writeActiveMap(map);
}

export function appendTurn(s: SessionState, turn: SessionTurn) {
  s.turns.push(turn);
  saveSession(s);
}

export function compactSessionContext(s: SessionState, maxTurns = 6): string {
  const recent = s.turns.slice(-maxTurns);
  const lines = [`Session: ${s.sessionId}`, `Original request: ${s.originalTask}`];
  for (const t of recent) {
    lines.push(`User follow-up: ${t.userPrompt}`);
    lines.push(`Route: ${t.routeSummary}`);
    for (const p of t.phaseSummaries.slice(-4)) lines.push(`Outcome: ${p}`);
  }
  return lines.join("\n");
}

export function listSessions(cwd = process.cwd()): SessionState[] {
  return fs
    .readdirSync(sessionsDir())
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), "utf8")) as SessionState;
      } catch {
        return undefined;
      }
    })
    .filter((x: SessionState | undefined): x is SessionState => Boolean(x))
    .filter((s: SessionState) => path.resolve(s.cwd) === path.resolve(cwd))
    .sort((a: SessionState, b: SessionState) => b.updatedAt.localeCompare(a.updatedAt));
}
