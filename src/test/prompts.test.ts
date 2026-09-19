import assert from "node:assert/strict";
import test from "node:test";
import { singleRunPrompt } from "../prompts.js";
import type { SessionState } from "../types.js";

test("includes prior session outcomes in a single-mode follow-up", () => {
  const session: SessionState = {
    sessionId: "session-1",
    cwd: "/repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    originalTask: "Improve the CLI",
    turns: [{
      turnId: "turn-1",
      runId: "run-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      userPrompt: "Add an interactive mode",
      routeSummary: "single:codex/model",
      phaseSummaries: ["Interactive mode implemented"],
    }],
  };

  const prompt = singleRunPrompt("Now improve its output", session);

  assert.match(prompt, /Original request: Improve the CLI/);
  assert.match(prompt, /Outcome: Interactive mode implemented/);
  assert.match(prompt, /Current follow-up request: Now improve its output/);
});

test("marks inspection-style single requests as read-only", () => {
  assert.match(singleRunPrompt("Confirm the setup behavior"), /read-only unless they explicitly ask for changes/);
});
