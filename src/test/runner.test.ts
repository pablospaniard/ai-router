import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { RunLogger } from "../logging.js";
import { routeTask } from "../router.js";
import { addTokenUsage, assertAllowedModel, claudeProgress, codexProgress, commandExists, commandVersion, extractQuestion, isApprovalAnswer, progressFor, runAgent } from "../runner.js";

test("extracts explicit and permission-blocked clarification questions", () => {
  assert.equal(extractQuestion("AIROUTE_QUESTION: Which database should I use?"), "Which database should I use?");
  assert.equal(
    extractQuestion("The command needs your approval to run — could you approve it, or should I proceed with a manual review instead?"),
    "The command needs your approval to run — could you approve it, or should I proceed with a manual review instead?",
  );
});

test("does not mistake an optional closing offer for blocking input", () => {
  assert.equal(extractQuestion("The review is complete and no issues were found.\n\nWould you like me to open a PR?"), undefined);
});

test("only treats an explicit approve answer as permission approval", () => {
  assert.equal(isApprovalAnswer("approve"), true);
  assert.equal(isApprovalAnswer(" APPROVED "), true);
  assert.equal(isApprovalAnswer("yes"), false);
  assert.equal(isApprovalAnswer("proceed manually"), false);
});

test("parses Claude lifecycle, tool, retry, result, and usage events", () => {
  assert.deepEqual(claudeProgress(null), { messages: [] });
  assert.match(claudeProgress({ type: "system", subtype: "init", model: "m", session_id: "s" }).messages[0].text, /model=m session=s/);
  assert.match(claudeProgress({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 2, retry_delay_ms: 50, error: "busy" }).messages[0].text, /1\/2/);
  assert.match(claudeProgress({ type: "system", subtype: "plugin_install", status: "done", name: "plug" }).messages[0].text, /plug/);
  assert.match(claudeProgress({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "x" } }] } }).messages[0].text, /Bash/);
  assert.match(claudeProgress({ type: "tool", tool_name: "Read", input: { path: "x" } }).messages[0].text, /Read/);
  const result = claudeProgress({
    type: "result", subtype: "success", duration_ms: 1499, result: "done",
    usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 },
  });
  assert.match(result.messages[0].text, /1s/);
  assert.deepEqual(result.usage, { uncachedInputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 0 });
});

test("parses every Codex progress event family", () => {
  assert.deepEqual(codexProgress(undefined), { messages: [] });
  assert.match(codexProgress({ type: "thread.started", thread_id: "t" }).messages[0].text, /t/);
  assert.match(codexProgress({ type: "turn.started" }).messages[0].text, /turn started/);
  assert.match(codexProgress({ type: "turn.failed", error: { message: "bad" } }).messages[0].text, /bad/);
  assert.match(codexProgress({ type: "error", message: "oops" }).messages[0].text, /oops/);
  const completed = codexProgress({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } });
  assert.deepEqual(completed.usage, { uncachedInputTokens: 6, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 });
  for (const item of [
    { type: "command_execution", command: "echo ok" },
    { type: "file_change", path: "a.ts" },
    { type: "file_changes", changes: [{ path: "b.ts" }] },
    { type: "mcp_tool_call", server: "s", tool: "t" },
    { type: "web_search", query: "q" },
    { type: "reasoning" },
    { type: "unknown" },
  ]) assert.ok(codexProgress({ type: "item.started", item }).messages.length);
  assert.match(codexProgress({ type: "item.completed", item: { type: "command_execution", exit_code: 2 } }).messages[0].text, /exit 2/);
  assert.match(codexProgress({ type: "item.completed", item: { type: "mcp_tool_call", name: "tool" } }).messages[0].text, /completed/);
  assert.equal(progressFor("claude", { type: "result", result: "c" }).finalOutput, "c");
  assert.equal(progressFor("codex", { type: "item.completed", item: { type: "agent_message", text: "x" } }).candidateOutput, "x");
});

test("adds token usage and checks local commands", () => {
  const a = { uncachedInputTokens: 1, cachedInputTokens: 2, cacheWriteInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 5 };
  assert.equal(addTokenUsage(undefined, a), a);
  assert.equal(addTokenUsage(a, undefined), a);
  assert.deepEqual(addTokenUsage(a, a), { uncachedInputTokens: 2, cachedInputTokens: 4, cacheWriteInputTokens: 6, outputTokens: 8, reasoningOutputTokens: 10 });
  assert.equal(commandExists(process.execPath), true);
  assert.equal(commandExists("definitely-not-an-airo-command"), false);
  assert.match(commandVersion(process.execPath), /^v\d+/);
  assert.match(commandVersion("definitely-not-an-airo-command"), /^ERROR:/);
});

test("keeps Claude progress separate from the terminal result", () => {
  const progress = claudeProgress({ type: "assistant", message: { content: [{ type: "text", text: "Checking the repository." }] } });
  const result = claudeProgress({ type: "result", subtype: "success", result: "Everything is ready." });

  assert.equal(progress.candidateOutput, "Checking the repository.");
  assert.equal(progress.finalOutput, undefined);
  assert.equal(result.finalOutput, "Everything is ready.");
  assert.equal(result.candidateOutput, undefined);
});

test("normalizes provider token telemetry", () => {
  const claude = claudeProgress({ type: "result", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 3 } });
  const codex = codexProgress({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 7, reasoning_output_tokens: 2 } });

  assert.deepEqual(claude.usage, { uncachedInputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 3, reasoningOutputTokens: 0 });
  assert.deepEqual(codex.usage, { uncachedInputTokens: 20, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 2 });
});

test("uses the latest completed Codex agent message as the result candidate", () => {
  const first = codexProgress({ type: "item.completed", item: { type: "agent_message", text: "I will inspect the changes." } });
  const final = codexProgress({ type: "item.completed", item: { type: "agent_message", text: "Committed successfully." } });

  assert.equal(first.candidateOutput, "I will inspect the changes.");
  assert.equal(final.candidateOutput, "Committed successfully.");
});

test("rejects models outside the configured allowlist", () => {
  const route = routeTask("rename this type", structuredClone(DEFAULT_CONFIG));
  route.model = "unapproved-model";

  assert.throws(() => assertAllowedModel(route, DEFAULT_CONFIG), /not allowed/);
});

test("returns only Claude's result event from a structured run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-"));
  const command = path.join(dir, "mock-claude");
  const assistant = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I am checking." }] } });
  const resultEvent = JSON.stringify({ type: "result", subtype: "success", result: "Final result only.", usage: { input_tokens: 10, output_tokens: 3 } });
  fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${assistant}' '${resultEvent}'\n`);
  fs.chmodSync(command, 0o755);

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = command;
    const route = routeTask("investigate architecture", config);
    route.agent = "claude";
    route.modelTier = "balanced";
    route.model = config.claude.models.balanced.model;
    const logger = new RunLogger({ runId: "test", level: "compact", persist: false });
    const run = await runAgent(route, "task", config, {
      headless: true,
      capture: true,
      logger,
      logMeta: { phaseIndex: 1, phaseTotal: 1, phaseKind: "single", agent: "claude", model: route.model, effort: route.effort, tier: route.modelTier },
    });

    assert.equal(run.output, "Final result only.");
    assert.equal(run.usage?.outputTokens, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("returns only the latest Codex agent message from a structured run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-"));
  const command = path.join(dir, "mock-codex");
  const first = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I will inspect first." } });
  const final = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final result only." } });
  const completed = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '${first}' '${final}' '${completed}'\n`);
  fs.chmodSync(command, 0o755);

  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = command;
    const route = routeTask("rename this type", config);
    route.agent = "codex";
    route.modelTier = "fast";
    route.model = config.codex.models.fast.model;
    const logger = new RunLogger({ runId: "test", level: "compact", persist: false });
    const run = await runAgent(route, "task", config, {
      headless: true,
      capture: true,
      logger,
      logMeta: { phaseIndex: 1, phaseTotal: 1, phaseKind: "single", agent: "codex", model: route.model, effort: route.effort, tier: route.modelTier },
    });

    assert.equal(run.output, "Final result only.");
    assert.equal(run.usage?.outputTokens, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("passes a one-run Claude permission override and captures malformed output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-permission-"));
  const command = path.join(dir, "mock-claude");
  fs.writeFileSync(command, `#!/usr/bin/env node
const mode = process.argv[process.argv.indexOf("--permission-mode") + 1];
process.stdout.write("not-json\\n");
process.stdout.write(JSON.stringify({type:"result", subtype:"success", result:mode}) + "\\n");
process.stderr.write("diagnostic\\n");
`);
  fs.chmodSync(command, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.claude.command = command;
    const route = routeTask("review architecture", config);
    route.agent = "claude";
    route.model = config.claude.models.balanced.model;
    route.modelTier = "balanced";
    const logger = new RunLogger({ runId: "permission", level: "compact", persist: false });
    const run = await runAgent(route, "prompt", config, {
      headless: true, capture: true, logger, permissionMode: "bypassPermissions",
      logMeta: { phaseIndex: 1, phaseTotal: 1, phaseKind: "single", agent: "claude", model: route.model, effort: route.effort, tier: route.modelTier },
    });
    assert.equal(run.output, "bypassPermissions");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("supports plain captured and inherited provider execution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-runner-plain-"));
  const command = path.join(dir, "mock-codex");
  fs.writeFileSync(command, "#!/bin/sh\nprintf plain-output\nprintf diagnostic >&2\nexit 0\n");
  fs.chmodSync(command, 0o755);
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.command = command;
    const route = routeTask("rename type", config);
    route.agent = "codex";
    route.model = config.codex.models.fast.model;
    route.modelTier = "fast";
    assert.equal((await runAgent(route, "prompt", config, { capture: true })).output, "plain-output");
    assert.equal((await runAgent(route, "prompt", config)).exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
