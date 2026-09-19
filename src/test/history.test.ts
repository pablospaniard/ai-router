import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendHistory,
  historyPath,
  learningHints,
  newHistoryId,
  newRunId,
  readHistory,
  setFeedback,
  similarity,
} from "../history.js";
import type { HistoryConfig, HistoryRecord } from "../types.js";

test("returns full similarity for equivalent token sets", () => {
  assert.equal(similarity("fix flaky test", "test flaky fix"), 1);
});

test("handles disabled, missing, malformed, and individually rated history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-history-"));
  const file = path.join(dir, "history.jsonl");
  const disabled: HistoryConfig = {
    enabled: false,
    learningEnabled: true,
    similarityThreshold: 0.25,
    path: file,
  };
  const enabled = { ...disabled, enabled: true };
  try {
    assert.equal(historyPath(enabled), file);
    assert.deepEqual(readHistory(disabled), []);
    assert.deepEqual(readHistory(enabled), []);
    appendHistory(disabled, {} as HistoryRecord);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, "not-json\n");
    assert.deepEqual(readHistory(enabled), []);
    assert.throws(() => setFeedback(enabled, "bad"), /No routing history/);

    const record: HistoryRecord = {
      id: "one",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/repo",
      task: "fix parser",
      agent: "claude",
      modelTier: "deep",
      model: "model",
      effort: "high",
      complexity: 2,
      exitCode: 0,
      durationMs: 1,
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    assert.equal(setFeedback(enabled, "bad", "one", "slow")[0].feedbackNote, "slow");
    assert.equal(setFeedback(enabled, "good", "last")[0].feedback, "good");
    assert.throws(() => setFeedback(enabled, "good", "missing"), /not found/);
    assert.match(newHistoryId(), /^[0-9a-f]{8}$/);
    assert.match(newRunId(), /^[0-9a-f]{12}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("derives positive and negative learning hints from similar feedback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-learning-"));
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.2,
    path: path.join(dir, "history.jsonl"),
  };
  const base: HistoryRecord = {
    id: "good",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    task: "fix parser bug",
    agent: "claude",
    modelTier: "deep",
    model: "model",
    effort: "high",
    complexity: 2,
    exitCode: 0,
    durationMs: 1,
    feedback: "good",
  };
  try {
    appendHistory(config, base);
    appendHistory(config, {
      ...base,
      id: "bad",
      agent: "codex",
      modelTier: "fast",
      feedback: "bad",
    });
    const hints = learningHints("fix parser bug", config);
    assert.ok(hints.agentBoosts.claude > 0);
    assert.ok(hints.agentBoosts.codex < 0);
    assert.match(hints.notes[0], /2 similar/);
    assert.deepEqual(learningHints("anything", { ...config, learningEnabled: false }).notes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const config: HistoryConfig = {
    enabled: true,
    learningEnabled: true,
    similarityThreshold: 0.25,
    path: path.join(dir, "history.jsonl"),
  };
  const base: HistoryRecord = {
    id: "phase-1",
    runId: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    task: "task",
    agent: "codex",
    modelTier: "fast",
    model: "model",
    effort: "low",
    complexity: 1,
    exitCode: 0,
    durationMs: 1,
  };
  try {
    appendHistory(config, base);
    appendHistory(config, { ...base, id: "phase-2" });

    const updated = setFeedback(config, "good", "run-1");

    assert.equal(updated.length, 2);
    assert.deepEqual(
      readHistory(config).map((record) => record.feedback),
      ["good", "good"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
