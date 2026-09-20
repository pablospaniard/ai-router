import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";

function executable(file: string, source: string): string {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function writeConfig(home: string, codex: string, mode: "prompt" | "fullAccess"): void {
  const config = structuredClone(DEFAULT_CONFIG);
  config.codex.command = codex;
  config.permissions.mode = mode;
  config.history.enabled = false;
  config.logging.persist = false;
  config.logging.level = "compact";
  const directory = path.join(home, ".config", "airo");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
}

function runCli(cwd: string, home: string, input = ""): ReturnType<typeof spawnSync> {
  const env = { ...process.env, HOME: home, NO_COLOR: "1" };
  env.NODE_V8_COVERAGE = path.join(cwd, ".child-coverage");
  return spawnSync(
    process.execPath,
    [path.resolve("dist/cli.js"), "--single", "--agent", "codex", "perform protected action"],
    {
      cwd,
      env,
      input,
      encoding: "utf8",
    },
  );
}

test("terminal CLI accepts yes before elevating a provider-reported access failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-permission-"));
  const home = path.join(dir, "home");
  const count = path.join(dir, "count");
  const argsLog = path.join(dir, "args");
  const codex = executable(
    path.join(dir, "codex"),
    `
const fs = require("node:fs");
const countFile = ${JSON.stringify(count)};
const argsFile = ${JSON.stringify(argsLog)};
const args = process.argv.slice(2);
if (!args.includes("exec")) {
  console.log(args.includes("--version") ? "codex-cli 1.0.0" : "Logged in using ChatGPT");
  process.exit(0);
}
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(argsFile, JSON.stringify(args) + "\\n");
const text = n === 0
  ? "AIROUTE_QUESTION: GitHub API access is blocked, so I can't open the PR. Please enable network access."
  : "Protected action completed.";
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:1}}));
`,
  );

  try {
    writeConfig(home, codex, "prompt");
    const result = runCli(dir, home, "yes\n");
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Permission required to access GitHub and retry the blocked action/,
    );
    assert.match(result.stdout, /approval received.*elevated permissions/);
    assert.match(result.stdout, /Protected action completed/);
    const invocations = fs
      .readFileSync(argsLog, "utf8")
      .trim()
      .split("\n")
      .map((line: string) => (JSON.parse(line) as string[]).join(" "));
    assert.equal(invocations.length, 2);
    assert.match(invocations[0], /--sandbox workspace-write/);
    assert.match(invocations[0], /sandbox_workspace_write\.network_access=true/);
    assert.match(invocations[0], /--ask-for-approval never/);
    assert.match(invocations[1], /--sandbox danger-full-access/);
    assert.match(invocations[1], /--ask-for-approval never/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal CLI honors the global full-access provider policy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-cli-full-access-"));
  const home = path.join(dir, "home");
  const argsLog = path.join(dir, "args");
  const codex = executable(
    path.join(dir, "codex"),
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("exec")) {
  console.log(args.includes("--version") ? "codex-cli 1.0.0" : "Logged in using ChatGPT");
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Completed with full access."}}));
`,
  );

  try {
    writeConfig(home, codex, "fullAccess");
    const result = runCli(dir, home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Completed with full access/);
    const invocation = (JSON.parse(fs.readFileSync(argsLog, "utf8")) as string[]).join(" ");
    assert.match(invocation, /--sandbox danger-full-access/);
    assert.doesNotMatch(invocation, /--sandbox workspace-write/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
