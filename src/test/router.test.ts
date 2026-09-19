import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { needsRecovery, planPhases, shouldOrchestrate } from "../orchestrator.js";
import { routeTask } from "../router.js";
import type { RouterConfig } from "../types.js";

function config(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
  };
}

test("routes architecture investigations to Claude with a deep model", () => {
  const route = routeTask("Investigate the root cause and architecture trade-offs", config());

  assert.equal(route.agent, "claude");
  assert.equal(route.modelTier, "deep");
  assert.equal(route.model, DEFAULT_CONFIG.claude.models.deep.model);
  assert.ok(route.claudeScore > route.codexScore);
});

test("routes a small test implementation to Codex with a fast model", () => {
  const route = routeTask("Add a unit test for this simple type", config());

  assert.equal(route.agent, "codex");
  assert.equal(route.modelTier, "fast");
  assert.equal(route.model, DEFAULT_CONFIG.codex.models.fast.model);
});

test("applies the first matching custom routing rule", () => {
  const custom = config({
    rules: [{
      name: "docs policy",
      pattern: "documentation",
      agent: "claude",
      modelTier: "balanced",
      effort: "high",
    }],
  });

  const route = routeTask("Update the documentation", custom);

  assert.equal(route.matchedRule, "docs policy");
  assert.equal(route.agent, "claude");
  assert.equal(route.modelTier, "balanced");
  assert.equal(route.effort, "high");
});

test("ignores malformed custom rule expressions", () => {
  const custom = config({
    rules: [{ name: "broken", pattern: "[", agent: "claude" }],
  });

  assert.doesNotThrow(() => routeTask("Add a component", custom));
});

test("uses the configured default agent to break score ties", () => {
  const neutralTask = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";
  const route = routeTask(neutralTask, config({ defaultAgent: "claude" }));

  assert.equal(route.agent, "claude");
});

test("orchestrates review, complex, and long requests in auto mode", () => {
  const current = config();

  assert.equal(shouldOrchestrate("Review this pull request", current), true);
  assert.equal(shouldOrchestrate("Plan a cross-module migration", current), true);
  assert.equal(shouldOrchestrate("Rename this type", current), false);
});

test("honors explicit orchestration modes", () => {
  const adaptive = config({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "adaptive" } });
  const single = config({ orchestration: { ...DEFAULT_CONFIG.orchestration, mode: "single" } });

  assert.equal(shouldOrchestrate("Rename this type", adaptive), true);
  assert.equal(shouldOrchestrate("Investigate a production outage", single), false);
});

test("plans a review-only request without implementation phases", () => {
  const plans = planPhases("Review this pull request", config());

  assert.deepEqual(plans.map((phase) => phase.kind), ["review"]);
  assert.equal(plans[0].preferredAgent, "claude");
});

test("plans a minimal workflow for simple changes", () => {
  const plans = planPhases("Rename a type in one file", config());

  assert.deepEqual(plans.map((phase) => phase.kind), ["implement", "test"]);
});

test("caps planned phases at the configured maximum", () => {
  const current = config({
    orchestration: { ...DEFAULT_CONFIG.orchestration, maxPhases: 2 },
  });
  const plans = planPhases("Fix a critical production crash", current);

  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((phase) => phase.kind), ["analyze", "implement"]);
});

test("does not recover from historical failure wording in a successful result", () => {
  const route = routeTask("fix test", config());
  const execution = {
    phase: planPhases("rename a type", config())[0],
    route,
    exitCode: 0,
    durationMs: 1,
    output: "Tests failed initially, but the fix is complete and all tests now pass.",
  };

  assert.equal(needsRecovery(execution), false);
  assert.equal(needsRecovery({ ...execution, output: "Status: unresolved — missing credentials." }), true);
  assert.equal(needsRecovery({ ...execution, exitCode: 1 }), true);
});
