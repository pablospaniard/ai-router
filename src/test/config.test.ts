import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { configCandidates } from "../config.js";

test("prefers AIRO project config while retaining the legacy filename", () => {
  const cwd = path.resolve("fixture-project");
  const candidates = configCandidates(cwd);

  assert.equal(candidates[0], path.join(cwd, ".airo.json"));
  assert.equal(candidates[1], path.join(cwd, ".ai-router.json"));
  assert.match(candidates[2], /[\\/]\.config[\\/]airo[\\/]config\.json$/);
  assert.match(candidates[3], /[\\/]\.config[\\/]ai-router[\\/]config\.json$/);
});
