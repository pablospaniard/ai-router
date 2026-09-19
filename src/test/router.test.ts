import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { applyPhasePreference, needsRecovery, planPhases, shouldOrchestrate } from "../orchestrator.js";
import { agentForModel, requestedModel, requestedModelTier, routeTask } from "../router.js";
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

test("honors an explicit request for the most powerful model", () => {
  const current = config();
  const task = "use most powerfull model and review again";
  const route = routeTask(task, current);
  const review = planPhases(task, current)[0];
  const phaseRoute = applyPhasePreference(route, review, current);

  assert.equal(requestedModelTier(task), "deep");
  assert.equal(phaseRoute.userRequestedTier, "deep");
  assert.equal(phaseRoute.modelTier, "deep");
  assert.equal(phaseRoute.model, current.claude.models.deep.model);
  assert.equal(phaseRoute.effort, current.claude.models.deep.effort);
});

test("does not mistake a negative model instruction for a deep-tier request", () => {
  assert.equal(requestedModelTier("do not use the most powerful model"), undefined);
});

test("routes explicit models outside the automatic tier defaults", () => {
  const current = config();
  const codex = routeTask("use gpt-6-astra and tell me the time", current);
  const claude = routeTask("please use claude-opus-5 for this review", current);

  assert.deepEqual(requestedModel("use gpt-6-astra", current), { agent: "codex", model: "gpt-6-astra" });
  assert.equal(agentForModel("sonnet", current), "claude");
  assert.equal(agentForModel("o3", current), "codex");
  assert.equal(agentForModel("unknown-model", current), undefined);
  assert.equal(requestedModel("use GPT for this task", current), undefined);
  assert.equal(codex.agent, "codex");
  assert.equal(codex.model, "gpt-6-astra");
  assert.equal(codex.userRequestedModel, "gpt-6-astra");
  assert.equal(claude.agent, "claude");
  assert.equal(claude.model, "claude-opus-5");
});

test("preserves an explicit model through adaptive phase preferences", () => {
  const current = config();
  const route = routeTask("use gpt-6-astra to review the architecture", current);
  const phaseRoute = applyPhasePreference(route, planPhases("review the architecture", current)[0], current);

  assert.equal(phaseRoute.agent, "codex");
  assert.equal(phaseRoute.model, "gpt-6-astra");
});

test("ignores negated explicit model requests", () => {
  assert.equal(requestedModel("do not use gpt-6-astra for this", config()), undefined);
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
