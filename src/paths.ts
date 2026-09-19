import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataRootDir(): string {
  const current = path.join(os.homedir(), ".local", "share", "airo");
  const legacy = path.join(os.homedir(), ".local", "share", "ai-router");
  return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}
