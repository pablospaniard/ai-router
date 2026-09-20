import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRoute, extractTaskFeatures, tokenCount } from "../evaluation.js";

test("requires reported verification evidence instead of trusting a successful test phase", () => {
  const unverified = evaluateRoute("Done.", 0, "test", { durationMs: 10 });
  const verified = evaluateRoute("All tests passed with 0 failures.", 0, "test", {
    durationMs: 10,
  });

  assert.equal(unverified.evaluation.verified, false);
  assert.equal(verified.evaluation.verified, true);
  assert.ok(verified.evaluation.quality > unverified.evaluation.quality);
});

test("does not treat an explicit clean review as a regression", () => {
  const clean = evaluateRoute("Review complete: no regressions found.", 0, "review", {
    durationMs: 1,
  });
  const issue = evaluateRoute("Review found a regression in authentication.", 0, "review", {
    durationMs: 1,
  });

  assert.equal(clean.outcome.regressions, 0);
  assert.equal(issue.outcome.regressions, 1);
});

test("extracts local task features and token totals", () => {
  const features = extractTaskFeatures("Fix a critical TypeScript parser race", 4);
  assert.equal(features.category, "debug");
  assert.equal(features.language, "typescript");
  assert.equal(features.risk, "high");
  assert.equal(features.complexity, 4);
  assert.equal(features.embedding.length, 64);
  assert.equal(
    tokenCount({
      uncachedInputTokens: 1,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 3,
      outputTokens: 4,
      reasoningOutputTokens: 0,
    }),
    10,
  );
  assert.equal(tokenCount(), undefined);
});
