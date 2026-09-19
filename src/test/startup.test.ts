import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunInitialSetup, shouldShowWelcome } from "../startup.js";

test("launches first-run setup only for an interactive invocation without config", () => {
  assert.equal(shouldRunInitialSetup([], true, false), true);
  assert.equal(shouldRunInitialSetup(["doctor"], true, false), true);
  assert.equal(shouldRunInitialSetup([], false, false), false);
  assert.equal(shouldRunInitialSetup([], true, true), false);
  assert.equal(shouldRunInitialSetup(["--help"], true, false), false);
  assert.equal(shouldRunInitialSetup(["setup"], true, false), false);
});

test("shows welcome once per interactive invocation, regardless of config", () => {
  assert.equal(shouldShowWelcome([], true), true);
  assert.equal(shouldShowWelcome(["doctor"], true), true);
  assert.equal(shouldShowWelcome([], false), false);
  assert.equal(shouldShowWelcome(["--help"], true), false);
  assert.equal(shouldShowWelcome(["--version"], true), false);
});
