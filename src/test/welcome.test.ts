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
  assert.match(welcome, /Provider\s+Tier\s+Model\s+Effort/);
  assert.match(welcome, /codex\s+fast\s+gpt-5\.6-luna\s+low/);
  assert.match(welcome, /claude\s+fast\s+haiku\s+low/);
  assert.match(welcome, /Tie-break provider: codex/);
  assert.match(welcome, /Choose models for these tiers, or press Enter to keep the displayed defaults/);
  assert.doesNotMatch(welcome, /Next/);
  assert.match(welcome, /~\/.config\/airo\/config\.json/);
  assert.match(welcome, /airo setup/);
  assert.match(welcome, /airo models/);

  const sectionTitles = welcome.split("\n").filter(line => /(?:Welcome|Initial defaults)/.test(line));
  assert.equal(sectionTitles.length, 2);
  assert.equal(new Set(sectionTitles.map(line => line.length)).size, 1);
});

test("uses the supplied configuration when documenting defaults", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.defaultAgent = "claude";
  config.codex.models.fast.model = "custom-fast";

  const welcome = plainText(firstRunWelcome(config));
  assert.match(welcome, /custom-fast/);
  assert.match(welcome, /Tie-break provider: claude/);
});
