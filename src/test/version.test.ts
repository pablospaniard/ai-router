import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { VERSION } from "../version.js";

test("keeps package and documented versions aligned", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const readme = fs.readFileSync("README.md", "utf8");

  assert.equal(VERSION, "0.7.0");
  assert.equal(packageJson.version, VERSION);
  assert.match(readme, new RegExp(`^# subscription-ai-router v${VERSION.replaceAll(".", "\\.")}$`, "m"));
});
