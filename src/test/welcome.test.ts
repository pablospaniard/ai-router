import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { plainText } from "../ui.js";
import { firstRunWelcome } from "../welcome.js";

test("introduces AIRO and its initial model setup on first run", () => {
  const welcome = plainText(firstRunWelcome());

  assert.match(welcome, /█████╗/);
  assert.match(welcome, /Adaptive Intelligence Routing & Orchestration/);
  assert.match(welcome, /existing provider CLI logins/);
  assert.match(welcome, /Codex\s+fast \/ balanced \/ deep: fast gpt-5\.6-luna \(low\)/);
  assert.match(welcome, /Claude fast \/ balanced \/ deep: fast haiku \(low\)/);
  assert.match(welcome, /Tie-break provider: codex/);
  assert.match(welcome, /Press Enter to keep each displayed default/);
  assert.match(welcome, /~\/.config\/airo\/config\.json/);
  assert.match(welcome, /airo setup/);
  assert.match(welcome, /airo models/);
});

test("uses the supplied configuration when documenting defaults", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.defaultAgent = "claude";
  config.codex.models.fast.model = "custom-fast";

  const welcome = plainText(firstRunWelcome(config));
  assert.match(welcome, /custom-fast/);
  assert.match(welcome, /Tie-break provider: claude/);
});
