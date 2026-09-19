import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunInitialSetup } from "../startup.js";

test("launches first-run setup only for an interactive invocation without config", () => {
  assert.equal(shouldRunInitialSetup([], true, false), true);
  assert.equal(shouldRunInitialSetup(["doctor"], true, false), true);
  assert.equal(shouldRunInitialSetup([], false, false), false);
  assert.equal(shouldRunInitialSetup([], true, true), false);
  assert.equal(shouldRunInitialSetup(["--help"], true, false), false);
  assert.equal(shouldRunInitialSetup(["setup"], true, false), false);
});
