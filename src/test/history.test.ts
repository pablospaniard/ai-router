import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendHistory, readHistory, setFeedback, similarity } from "../history.js";
import type { HistoryConfig, HistoryRecord } from "../types.js";

test("returns full similarity for equivalent token sets", () => {
  assert.equal(similarity("fix flaky test", "test flaky fix"), 1);
});

test("ignores common stop words when comparing tasks", () => {
  assert.equal(similarity("fix the parser", "please fix parser"), 1);
});

test("returns zero for unrelated or empty tasks", () => {
  assert.equal(similarity("update parser", "render dashboard"), 0);
  assert.equal(similarity("", "render dashboard"), 0);
});

test("rates every history record belonging to a run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-feedback-"));
  const config: HistoryConfig = { enabled: true, learningEnabled: true, similarityThreshold: 0.25, path: path.join(dir, "history.jsonl") };
  const base: HistoryRecord = {
    id: "phase-1", runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo", task: "task",
    agent: "codex", modelTier: "fast", model: "model", effort: "low", complexity: 1, exitCode: 0, durationMs: 1,
  };
  try {
    appendHistory(config, base);
    appendHistory(config, { ...base, id: "phase-2" });

    const updated = setFeedback(config, "good", "run-1");

    assert.equal(updated.length, 2);
    assert.deepEqual(readHistory(config).map(record => record.feedback), ["good", "good"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
