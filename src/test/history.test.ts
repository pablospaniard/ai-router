import assert from "node:assert/strict";
import test from "node:test";
import { similarity } from "../history.js";

test("returns full similarity for equivalent token sets", () => {
  assert.equal(similarity("fix flaky test", "test flaky fix"), 1);
});

test("ignores common stop words when comparing tasks", () => {
  assert.equal(similarity("fix the parser", "please fix parser"), 1);
});

test("returns zero for unrelated or empty tasks", () => {
  assert.equal(similarity("update parser", "render dashboard"), 0);
  assert.equal(similarity("", "render dashboard"), 0);
});
