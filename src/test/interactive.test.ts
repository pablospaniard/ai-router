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
  assert.deepEqual(parseInteractiveInput(""), { kind: "empty" });
  assert.deepEqual(parseInteractiveInput("/exit"), { kind: "quit" });
  assert.deepEqual(parseInteractiveInput("/quit"), { kind: "quit" });
  assert.deepEqual(parseInteractiveInput("/?"), { kind: "help" });
  assert.deepEqual(parseInteractiveInput("/status"), { kind: "status" });
  assert.deepEqual(parseInteractiveInput("/sessions"), { kind: "sessions" });
  assert.deepEqual(parseInteractiveInput("/models"), { kind: "models" });
  assert.deepEqual(parseInteractiveInput("/clear"), { kind: "clear" });
  assert.deepEqual(parseInteractiveInput("/new named session"), { kind: "new", title: "named session" });
  assert.deepEqual(parseInteractiveInput("/new"), { kind: "new", title: undefined });
  assert.deepEqual(parseInteractiveInput("/mode single"), { kind: "set-mode", value: "single" });
  assert.deepEqual(parseInteractiveInput("/agent auto"), { kind: "set-agent", value: "auto" });
  assert.deepEqual(parseInteractiveInput("/tier deep"), { kind: "set-tier", value: "deep" });
  assert.deepEqual(parseInteractiveInput("/log compact"), { kind: "set-log", value: "compact" });
});

test("returns guidance for invalid interactive commands", () => {
  assert.deepEqual(parseInteractiveInput("/mode fast"), { kind: "error", message: "Usage: /mode auto|adaptive|single" });
  assert.match(parseInteractiveInput("/agent other").kind, /error/);
  assert.match(parseInteractiveInput("/tier other").kind, /error/);
  assert.match(parseInteractiveInput("/log other").kind, /error/);
  assert.match(parseInteractiveInput("/wat").kind, /error/);
});

test("builds minimal CLI arguments for automatic preferences", () => {
  assert.deepEqual(taskArgs("inspect", { mode: "auto", agent: "auto", logLevel: "live" }), ["--continue", "--log", "live", "inspect"]);
  assert.deepEqual(taskArgs("inspect", { mode: "single", agent: "claude", logLevel: "live" }), ["--continue", "--single", "--agent", "claude", "--log", "live", "inspect"]);
  assert.equal(parseFeedbackAnswer("n"), "bad");
  assert.equal(parseFeedbackAnswer("maybe"), undefined);
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
