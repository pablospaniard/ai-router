import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Agent, FeedbackRating, HistoryConfig, HistoryRecord, ModelTier } from "./types.js";
import { dataRootDir } from "./paths.js";

const STOP = new Set([
  "the","a","an","and","or","to","of","in","on","for","with","this","that","it","is","are","be","from","by","as","at","we","i","my","our","please","can","you","into"
]);

export function historyPath(config: HistoryConfig): string {
  return config.path ?? path.join(dataRootDir(), "history.jsonl");
}

export function newHistoryId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function newRunId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export function appendHistory(config: HistoryConfig, record: HistoryRecord): void {
  if (!config.enabled) return;
  const file = historyPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

export function readHistory(config: HistoryConfig): HistoryRecord[] {
  if (!config.enabled) return [];
  const file = historyPath(config);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line: string) => {
      try { return [JSON.parse(line) as HistoryRecord]; }
      catch { return []; }
    });
}

export function setFeedback(
  config: HistoryConfig,
  rating: FeedbackRating,
  id?: string,
  note?: string
): HistoryRecord[] {
  const records = readHistory(config);
  if (!records.length) throw new Error("No routing history yet.");
  let targets: number[] = [];

  if (!id || id === "last") {
    const last = records[records.length - 1];
    if (last.runId) targets = records.map((r, i) => r.runId === last.runId ? i : -1).filter(i => i >= 0);
    else targets = [records.length - 1];
  } else {
    const byRun = records.map((r, i) => r.runId === id ? i : -1).filter(i => i >= 0);
    if (byRun.length) targets = byRun;
    else {
      const index = records.findIndex(r => r.id === id);
      if (index >= 0) targets = [index];
    }
  }
  if (!targets.length) throw new Error(`History item or run ${id} not found.`);

  for (const index of targets) {
    records[index] = { ...records[index], feedback: rating, feedbackNote: note };
  }
  const file = historyPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  return targets.map(i => records[i]);
}

function tokens(s: string): Set<string> {
  const words = s.toLowerCase().match(/[a-z0-9_+#.-]{2,}/g) ?? [];
  return new Set(words.filter(w => !STOP.has(w)));
}

export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  const union = A.size + B.size - intersection;
  return union ? intersection / union : 0;
}

export interface LearningHint {
  agentBoosts: Record<Agent, number>;
  tierBoosts: Record<ModelTier, number>;
  notes: string[];
}

export function learningHints(task: string, config: HistoryConfig): LearningHint {
  const empty: LearningHint = {
    agentBoosts: { claude: 0, codex: 0 },
    tierBoosts: { fast: 0, balanced: 0, deep: 0 },
    notes: []
  };
  if (!config.enabled || !config.learningEnabled) return empty;

  const similar = readHistory(config)
    .filter(r => r.feedback)
    .map(r => ({ r, sim: similarity(task, r.task) }))
    .filter(x => x.sim >= config.similarityThreshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 30);

  for (const { r, sim } of similar) {
    const sign = r.feedback === "good" ? 1 : -1;
    empty.agentBoosts[r.agent] += sign * 4 * sim;
    empty.tierBoosts[r.modelTier] += sign * 3 * sim;
  }

  if (similar.length) {
    const best = similar[0];
    empty.notes.push(`learned from ${similar.length} similar rated phase(s); closest ${(best.sim * 100).toFixed(0)}%`);
  }
  return empty;
}
