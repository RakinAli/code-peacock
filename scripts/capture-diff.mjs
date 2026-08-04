#!/usr/bin/env node
// Compare two capture runs — this branch against its base — and say which routes
// actually moved.
//
// Two payoffs: the report gets a real before/after/diff triple instead of two
// pictures a human squints at, and the UX phase can skip every route whose pixels
// did not change, which is the difference between reviewing four screenshots and
// reviewing forty.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { requireFromProject } from "./lib/peacock-require.mjs";

const HELP = `Usage: node capture-diff.mjs --before <dir> --after <dir> [options]

Options:
  --before <dir>     Capture directory from the base branch   (required)
  --after <dir>      Capture directory from this branch       (required)
  --out <dir>        Where diff images go        (default: <after>/diff)
  --threshold <n>    Per-pixel colour tolerance, 0–1          (default 0.1)
  --root <dir>       Project the differ is resolved from      (default: current directory)
  --json             Print the manifest instead of a summary
  --help

Needs an image differ in the target project — odiff-bin (fastest) or
pixelmatch + pngjs:  npm i -D odiff-bin
`;

const BOOLEAN_FLAGS = new Set(["json", "help"]);
const VALUE_FLAGS = new Set(["before", "after", "out", "threshold", "root"]);
const USAGE_EXIT_CODE = 2;
const DEFAULT_THRESHOLD = 0.1;
const SCREENSHOT_KIND = "screenshot";

function parseArgs(argumentsList) {
  const flags = {};
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (!argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    const key = argument.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    flags[key] = value;
    index++;
  }
  return flags;
}

async function readScreenshots(directory) {
  const manifestFile = path.join(directory, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`no manifest.json in ${directory}`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const byKey = new Map();
  for (const capture of manifest.captures ?? []) {
    if (capture.kind !== SCREENSHOT_KIND) continue;
    byKey.set(`${capture.route}::${capture.viewport}`, capture.file);
  }
  return byKey;
}

function loadDiffer(root, threshold) {
  const odiff = requireFromProject(root, ["odiff-bin"]);
  if (odiff?.compare) {
    return {
      name: "odiff-bin",
      async compare(beforeFile, afterFile, diffFile) {
        const result = await odiff.compare(beforeFile, afterFile, diffFile, { threshold });
        if (result.match) return { changedPixels: 0, changedPercent: 0 };
        if (result.reason && result.reason !== "pixel-diff") {
          throw new Error(`${result.reason}: ${result.file ?? ""}`);
        }
        return { changedPixels: result.diffCount ?? 0, changedPercent: result.diffPercentage ?? 0 };
      },
    };
  }
  const pixelmatch = requireFromProject(root, ["pixelmatch"]);
  const pngjs = requireFromProject(root, ["pngjs"]);
  if (!pixelmatch || !pngjs) return null;
  const match = pixelmatch.default ?? pixelmatch;
  const { PNG } = pngjs;
  return {
    name: "pixelmatch",
    async compare(beforeFile, afterFile, diffFile) {
      const before = PNG.sync.read(await readFile(beforeFile));
      const after = PNG.sync.read(await readFile(afterFile));
      if (before.width !== after.width || before.height !== after.height) {
        throw new Error(`size changed: ${before.width}x${before.height} -> ${after.width}x${after.height}`);
      }
      const diff = new PNG({ width: before.width, height: before.height });
      const changedPixels = match(before.data, after.data, diff.data, before.width, before.height, { threshold });
      await writeFile(diffFile, PNG.sync.write(diff));
      const total = before.width * before.height;
      return { changedPixels, changedPercent: total === 0 ? 0 : (changedPixels / total) * 100 };
    },
  };
}

function printSummary(manifest) {
  console.log(`${manifest.differ}: ${manifest.changed.length} changed, ${manifest.identical.length} identical`);
  for (const entry of manifest.comparisons.filter((item) => item.changedPixels > 0)) {
    console.log(`  ${entry.route} (${entry.viewport}) ${entry.changedPercent.toFixed(2)}% -> ${entry.diffFile}`);
  }
  for (const entry of manifest.unpaired) console.log(`  new in this branch: ${entry}`);
  for (const entry of manifest.missing) console.log(`  gone from this branch: ${entry}`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || !flags.before || !flags.after) {
    console.log(HELP);
    return flags.help ? 0 : USAGE_EXIT_CODE;
  }
  const root = path.resolve(flags.root ?? process.cwd());
  const threshold = Number(flags.threshold ?? DEFAULT_THRESHOLD);
  const differ = loadDiffer(root, threshold);
  if (!differ) {
    console.error("no image differ available — install one in the project:\n  npm i -D odiff-bin");
    return USAGE_EXIT_CODE;
  }

  const before = await readScreenshots(flags.before);
  const after = await readScreenshots(flags.after);
  const out = flags.out ?? path.join(flags.after, "diff");
  await mkdir(out, { recursive: true });

  const comparisons = [];
  const failures = [];
  for (const [key, afterFile] of after) {
    const beforeFile = before.get(key);
    const [route, viewport] = key.split("::");
    if (!beforeFile) continue;
    const diffFile = path.join(out, `${path.basename(afterFile, ".png")}-diff.png`);
    try {
      const result = await differ.compare(beforeFile, afterFile, diffFile);
      comparisons.push({
        route,
        viewport,
        beforeFile,
        afterFile,
        diffFile: result.changedPixels > 0 ? diffFile : "",
        ...result,
      });
    } catch (error) {
      failures.push({ route, viewport, error: String(error.message ?? error) });
    }
  }

  const manifest = {
    differ: differ.name,
    threshold,
    comparisons,
    changed: comparisons.filter((entry) => entry.changedPixels > 0).map((entry) => entry.route),
    identical: comparisons.filter((entry) => entry.changedPixels === 0).map((entry) => entry.route),
    unpaired: [...after.keys()].filter((key) => !before.has(key)),
    missing: [...before.keys()].filter((key) => !after.has(key)),
    failures,
  };
  const manifestFile = path.join(out, "diff-manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  if (flags.json) console.log(JSON.stringify(manifest, null, 2));
  else printSummary(manifest);
  console.log(`\n-> ${manifestFile}`);
  return failures.length > 0 ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = USAGE_EXIT_CODE;
}
