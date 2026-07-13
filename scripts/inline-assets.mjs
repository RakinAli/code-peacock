#!/usr/bin/env node
// Rewrites local <img>/<video>/<source> references in an HTML report to data URIs,
// making the report a single self-contained file (safe to publish as an artifact,
// which blocks all external/file requests).
//
// Usage: node inline-assets.mjs <report.html> [--max-video-mb 8]

import { readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

const [reportPath, ...rest] = process.argv.slice(2);
if (!reportPath) {
  console.error("Usage: node inline-assets.mjs <report.html> [--max-video-mb 8]");
  process.exit(2);
}
const maxVideoIndex = rest.indexOf("--max-video-mb");
const maxVideoMb = maxVideoIndex === -1 ? 8 : Number(rest[maxVideoIndex + 1]);
if (!Number.isFinite(maxVideoMb) || maxVideoMb <= 0) {
  console.error("--max-video-mb requires a positive number");
  process.exit(2);
}
const maxVideoBytes = maxVideoMb * 1024 * 1024;

const html = await readFile(reportPath, "utf8");
const reportDir = path.dirname(path.resolve(reportPath));
let inlined = 0;
const skipped = [];

async function toDataUri(src) {
  const mime = MIME_TYPES[path.extname(src).toLowerCase()];
  if (!mime) return null;
  const file = path.resolve(reportDir, src);
  if (!existsSync(file)) {
    skipped.push(`${src} (not found)`);
    return null;
  }
  const { size } = await stat(file);
  if (mime.startsWith("video/") && size > maxVideoBytes) {
    skipped.push(`${src} (${(size / 1024 / 1024).toFixed(1)}MB video exceeds limit)`);
    return null;
  }
  const data = await readFile(file);
  inlined++;
  return `data:${mime};base64,${data.toString("base64")}`;
}

const srcPattern = /(<(?:img|video|source)\b[^>]*\bsrc=")([^"]+)(")/gi;
const replacements = [];
for (const match of html.matchAll(srcPattern)) {
  const [, prefix, src, suffix] = match;
  if (src.startsWith("data:") || src.startsWith("http")) continue;
  replacements.push({ full: match[0], prefix, src, suffix });
}

let result = html;
for (const { full, prefix, src, suffix } of replacements) {
  const dataUri = await toDataUri(src);
  if (dataUri) result = result.replace(full, `${prefix}${dataUri}${suffix}`);
}

await writeFile(reportPath, result);
console.log(`inlined ${inlined} assets into ${reportPath}`);
for (const entry of skipped) console.warn(`skipped: ${entry}`);
