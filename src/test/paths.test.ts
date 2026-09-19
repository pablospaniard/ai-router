import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateLegacyPaths } from "../paths.js";

test("copies legacy configuration and data into AIRO paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-migration-"));
  try {
    const legacyConfig = path.join(home, ".config", "ai-router", "config.json");
    const legacyHistory = path.join(home, ".local", "share", "ai-router", "history.jsonl");
    fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
    fs.mkdirSync(path.dirname(legacyHistory), { recursive: true });
    fs.writeFileSync(legacyConfig, "{}\n");
    fs.writeFileSync(legacyHistory, "history\n");

    const result = migrateLegacyPaths(home);

    assert.equal(result.errors.length, 0);
    assert.equal(fs.readFileSync(path.join(home, ".config", "airo", "config.json"), "utf8"), "{}\n");
    assert.equal(fs.readFileSync(path.join(home, ".local", "share", "airo", "history.jsonl"), "utf8"), "history\n");
    assert.equal(fs.existsSync(legacyConfig), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
