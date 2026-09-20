import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractLocalArtifacts } from "../artifacts.js";

test("extracts existing local artifacts from regular and angle-bracket Markdown links", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-artifacts-"));
  const image = path.join(dir, "cover image.png");
  const report = path.join(dir, "report.pdf");
  fs.writeFileSync(image, "image");
  fs.writeFileSync(report, "report");
  try {
    assert.deepEqual(
      extractLocalArtifacts(
        `![Cover](<${image}>)\n[Report](${report})\n[Missing](${dir}/nope.png)`,
      ),
      [
        { path: image, name: "cover image.png", mediaType: "image/png" },
        { path: report, name: "report.pdf", mediaType: undefined },
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extracts a generated image path quoted in prose and removes duplicates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airo-artifacts-"));
  const image = path.join(dir, "generated.webp");
  fs.writeFileSync(image, "image");
  try {
    const artifacts = extractLocalArtifacts(`Saved to \`${image}\`. [Open](<${image}>)`);
    assert.deepEqual(artifacts, [{ path: image, name: "generated.webp", mediaType: "image/webp" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
