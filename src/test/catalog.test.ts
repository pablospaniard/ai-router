import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cachedCatalog, candidateModels } from "../catalog.js";
import { DEFAULT_CONFIG } from "../config.js";

test("catalog reads tolerate invalid cache data and retain current configured models", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-catalog-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const dir = path.join(home, ".local", "share", "airo");
  const file = path.join(dir, "model-catalog.json");
  try {
    assert.equal(cachedCatalog("codex"), undefined);
    assert.equal(fs.existsSync(dir), false, "a cache read should not create directories");
    fs.mkdirSync(dir, { recursive: true });
    for (const entries of [null, [], { codex: {} }, { codex: { models: [null] } }]) {
      fs.writeFileSync(file, JSON.stringify({ version: 2, entries }));
      assert.equal(cachedCatalog("codex"), undefined);
      assert.ok(candidateModels("codex", DEFAULT_CONFIG).length);
    }
    fs.writeFileSync(file, "invalid json");
    assert.equal(cachedCatalog("codex"), undefined);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        entries: {
          codex: {
            agent: "codex",
            models: [{ id: "discovered-model" }],
            source: "cli",
            fingerprint: "test@1",
            contextFingerprint: "context",
            probedAt: new Date().toISOString(),
          },
        },
      }),
    );
    const config = structuredClone(DEFAULT_CONFIG);
    config.codex.models.fast.model = "new-config-model";
    const ids = candidateModels("codex", config).map((model) => model.id);
    assert.ok(ids.includes("discovered-model"));
    assert.ok(ids.includes("new-config-model"));
    assert.equal(new Set(ids).size, ids.length);
    fs.rmSync(path.join(home, ".local"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local"), "blocked directory");
    assert.equal(cachedCatalog("codex"), undefined);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
