import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { orchestrate } from "../orchestrator.js";

function executable(file: string, source: string): string {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function testConfig(claude: string, codex: string) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.claude.command = claude;
  config.codex.command = codex;
  config.history.enabled = false;
  config.logging.persist = false;
  config.logging.level = "compact";
  return config;
}

test("runs a dry adaptive plan without invoking providers", async () => {
  const config = testConfig("missing-claude", "missing-codex");
  const result = await orchestrate("Review this pull request", config, { dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.phases, []);
});

test("includes durable process guidance in adaptive phase prompts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-process-"));
  const promptLog = path.join(dir, "prompt");
  const provider = executable(
    path.join(dir, "provider"),
    `require("node:fs").writeFileSync(${JSON.stringify(promptLog)}, process.argv.at(-1));
console.log(JSON.stringify({type:"result", subtype:"success", result:"done"}));`,
  );
  try {
    const config = testConfig(provider, provider);
    config.orchestration.maxPhases = 1;
    await orchestrate("Start the dev server and leave it running", config);

    const prompt = fs.readFileSync(promptLog, "utf8");
    assert.match(prompt, /tool-managed command session/);
    assert.match(prompt, /tool session ID is not evidence/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("routes each follow-up from the current prompt instead of persisted session models", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-routing-"));
  const provider = executable(
    path.join(dir, "provider"),
    `console.log(JSON.stringify({type:"result", subtype:"success", result:"done"}));`,
  );
  try {
    const result = await orchestrate(
      "switch to Claude Opus model and review this PR",
      testConfig(provider, provider),
      {
        session: {
          sessionId: "routing-session",
          cwd: dir,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          originalTask: "Use Codex",
          turns: [
            {
              turnId: "old-turn",
              runId: "old-run",
              timestamp: new Date(0).toISOString(),
              userPrompt: "fix all, use gpt-5.6-sol model",
              routeSummary: "single:codex/gpt-5.6-sol exit=0",
              phaseSummaries: ["single:codex/gpt-5.6-sol exit=0"],
            },
          ],
        },
      },
    );
    assert.equal(result.phases[0].route.agent, "claude");
    assert.equal(result.phases[0].route.model, DEFAULT_CONFIG.claude.models.deep.model);
    assert.equal(result.phases[0].route.modelTier, "deep");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resumes the same Claude review with elevated permissions after approve", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-approve-"));
  const count = path.join(dir, "count");
  const argsLog = path.join(dir, "args");
  const claude = executable(
    path.join(dir, "claude"),
    `
const fs = require("node:fs");
const countFile = ${JSON.stringify(count)};
const argsFile = ${JSON.stringify(argsLog)};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(argsFile, process.argv.slice(2).join(" ") + "\\n");
const result = n === 0 ? "The command needs your approval. Could you approve permission to continue?" : "Review completed.";
console.log(JSON.stringify({type:"result", subtype:"success", result, usage:{input_tokens:2,output_tokens:1}}));
`,
  );
  const codex = executable(
    path.join(dir, "codex"),
    `console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));`,
  );
  try {
    const answers: string[] = [];
    const result = await orchestrate("Review this pull request", testConfig(claude, codex), {
      askUser: async (question) => {
        answers.push(question);
        return "approve";
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].output, "Review completed.");
    assert.equal(result.phases[0].usage?.uncachedInputTokens, 4);
    assert.equal(answers.length, 1);
    assert.match(fs.readFileSync(argsLog, "utf8"), /--permission-mode bypassPermissions/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inserts recovery after an unresolved phase and falls back to an available provider", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-recover-"));
  const count = path.join(dir, "count");
  const codex = executable(
    path.join(dir, "codex"),
    `
const fs = require("node:fs");
const file = ${JSON.stringify(count)};
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
fs.writeFileSync(file, String(n + 1));
const text = n === 0 ? "Status: unresolved — retry needed." : "Recovered and complete.";
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,cached_input_tokens:2,output_tokens:1}}));
`,
  );
  try {
    const config = testConfig("definitely-missing-claude", codex);
    config.orchestration.maxPhases = 4;
    const result = await orchestrate("Rename a type in one file", config);
    assert.equal(result.exitCode, 0);
    assert.ok(result.phases.some((phase) => phase.phase.kind === "recover"));
    assert.ok(result.phases.every((phase) => phase.route.agent === "codex"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stops after a failed phase when recovery is disabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-stop-"));
  const codex = executable(path.join(dir, "codex"), `process.exit(2);`);
  try {
    const config = testConfig(codex, codex);
    config.orchestration.recoverOnFailure = false;
    config.orchestration.stopOnFailure = true;
    const result = await orchestrate("Rename a type in one file", config);
    assert.equal(result.exitCode, 1);
    assert.equal(result.phases.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not report success when a provider remains blocked after clarification retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-orchestrate-blocked-"));
  const codex = executable(
    path.join(dir, "codex"),
    `console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"AIROUTE_QUESTION: Permission required to bind the local server. Approve?"}}));`,
  );
  try {
    const config = testConfig(codex, codex);
    const result = await orchestrate("Rename a type in one file", config, {
      askUser: async () => "decline",
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
