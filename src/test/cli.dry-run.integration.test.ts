import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";

test("dry-run follow-ups do not persist implicit feedback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-dry-run-"));
  const home = path.join(dir, "home");
  const dataDir = path.join(home, ".local", "share", "airo");
  const configDir = path.join(home, ".config", "airo");
  const historyFile = path.join(dir, "history.jsonl");
  const feedbackFile = path.join(dir, "history.feedback.jsonl");
  const sessionId = "dry-run-session";
  const runId = "previous-run";
  const cli = path.resolve("dist/cli.js");

  try {
    fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.history.path = historyFile;
    config.logging.persist = false;
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config));
    fs.writeFileSync(
      historyFile,
      `${JSON.stringify({
        id: "previous-phase",
        runId,
        timestamp: new Date().toISOString(),
        cwd: dir,
        task: "implement parser",
        agent: "codex",
        modelTier: "fast",
        model: "model",
        effort: "low",
        complexity: 1,
        exitCode: 0,
        durationMs: 1,
      })}\n`,
    );
    fs.writeFileSync(
      path.join(dataDir, "sessions", `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        cwd: dir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        originalTask: "implement parser",
        turns: [
          {
            turnId: "previous-turn",
            runId,
            timestamp: new Date().toISOString(),
            userPrompt: "implement parser",
            routeSummary: "single:codex/model exit=0",
            phaseSummaries: ["single:codex/model exit=0"],
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dataDir, "active-sessions.json"),
      JSON.stringify({ [dir]: sessionId }),
    );

    const env = { ...process.env, HOME: home, NO_COLOR: "1" };
    env.NODE_V8_COVERAGE = path.join(dir, ".child-coverage");
    const result = spawnSync(
      process.execPath,
      [cli, "--single", "--session", sessionId, "--dry-run", "fix that"],
      { cwd: dir, env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(feedbackFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
