import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalArtifact {
  path: string;
  name: string;
  mediaType?: string;
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

function localPath(value: string, cwd: string): string | undefined {
  let candidate = value.trim().replace(/^<|>$/g, "");
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith("data:")) return undefined;
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  }
  candidate = candidate.replace(/#L\d+(?::\d+)?$/, "").replace(/:\d+(?::\d+)?$/, "");
  const resolved = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(cwd, candidate);
  try {
    return fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Find real local files linked by a provider so clients can expose them as artifacts. */
export function extractLocalArtifacts(text: string, cwd = process.cwd()): LocalArtifact[] {
  const destinations: string[] = [];
  const markdown = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\n)]+))\s*\)/g;
  for (const match of text.matchAll(markdown)) destinations.push(match[1] ?? match[2]);

  // Image tools commonly return an absolute path in backticks instead of Markdown.
  const rawImage = /[`'"]((?:file:\/\/)?\/[^`'"\n]+\.(?:png|jpe?g|gif|webp|bmp|svg))[`'"]/gi;
  for (const match of text.matchAll(rawImage)) destinations.push(match[1]);

  const seen = new Set<string>();
  return destinations.flatMap((destination) => {
    const file = localPath(destination, cwd);
    if (!file || seen.has(file)) return [];
    seen.add(file);
    return [
      {
        path: file,
        name: path.basename(file),
        mediaType: MEDIA_TYPES[path.extname(file).toLowerCase()],
      },
    ];
  });
}
