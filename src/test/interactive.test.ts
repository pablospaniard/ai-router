import assert from "node:assert/strict";
import test from "node:test";
import { parseFeedbackAnswer, parseInteractiveInput, taskArgs } from "../interactive.js";

test("treats regular interactive input as a task", () => {
  assert.deepEqual(parseInteractiveInput("  fix the parser  "), { kind: "task", task: "fix the parser" });
});

test("parses interactive preference commands", () => {
  assert.deepEqual(parseInteractiveInput("/mode adaptive"), { kind: "set-mode", value: "adaptive" });
  assert.deepEqual(parseInteractiveInput("/agent claude"), { kind: "set-agent", value: "claude" });
  assert.deepEqual(parseInteractiveInput("/tier auto"), { kind: "set-tier", value: undefined });
  assert.deepEqual(parseInteractiveInput("/log verbose"), { kind: "set-log", value: "verbose" });
});

test("returns guidance for invalid interactive commands", () => {
  assert.deepEqual(parseInteractiveInput("/mode fast"), { kind: "error", message: "Usage: /mode auto|adaptive|single" });
  assert.match(parseInteractiveInput("/wat").kind, /error/);
});

test("builds CLI arguments from interactive preferences", () => {
  assert.deepEqual(taskArgs("ship it", {
    mode: "adaptive",
    agent: "codex",
    tier: "deep",
    logLevel: "compact",
  }), ["--continue", "--adaptive", "--agent", "codex", "--tier", "deep", "--log", "compact", "ship it"]);
});

test("parses simple post-run feedback", () => {
  assert.equal(parseFeedbackAnswer("yes"), "good");
  assert.equal(parseFeedbackAnswer("Y"), "good");
  assert.equal(parseFeedbackAnswer("no"), "bad");
  assert.equal(parseFeedbackAnswer(""), undefined);
});
