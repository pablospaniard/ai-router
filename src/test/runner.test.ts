import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { RunLogger } from "../logging.js";
import { routeTask } from "../router.js";
import { assertAllowedModel, claudeProgress, codexProgress, runAgent } from "../runner.js";

test("keeps Claude progress separate from the terminal result", () => {
  const progress = claudeProgress({ type: "assistant", message: { content: [{ type: "text", text: "Checking the repository." }] } });
  const result = claudeProgress({ type: "result", subtype: "success", result: "Everything is ready." });

  assert.equal(progress.candidateOutput, "Checking the repository.");
  assert.equal(progress.finalOutput, undefined);
  assert.equal(result.finalOutput, "Everything is ready.");
  assert.equal(result.candidateOutput, undefined);
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
  const resultEvent = JSON.stringify({ type: "result", subtype: "success", result: "Final result only." });
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
