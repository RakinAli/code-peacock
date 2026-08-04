#!/usr/bin/env node
// Did the browser actually run the code this branch changed?
//
// Intersects the lines the diff touched with the coverage ui-capture collected
// while driving the app. A run that screenshots ten routes without executing a
// single changed line has verified nothing, and should not be allowed to say
// "ship" — so this exits non-zero when the intersection is empty.

import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const HELP = `Usage: node diff-coverage.mjs [options]

Options:
  --root <dir>       Target repository        (default: current directory)
  --base <ref>       Compare against this ref (default: origin/HEAD, else main)
  --captures <dir>   Where capture runs live  (default: .peacock/captures)
  --out <file>       Write JSON here          (default: .peacock/evidence/diff-coverage.json)
  --json             Print JSON instead of a summary
  --help

Exit codes: 0 some changed code ran · 1 none of it did · 2 usage.
`;

const BOOLEAN_FLAGS = new Set(["json", "help"]);
const VALUE_FLAGS = new Set(["root", "base", "captures", "out"]);
const USAGE_EXIT_CODE = 2;
const NOTHING_EXERCISED_EXIT_CODE = 1;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const DEFAULT_BASE_BRANCHES = ["main", "master"];
const FULL_PERCENT = 100;

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

function git(root, argumentsList) {
  const result = spawnSync("git", argumentsList, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : "";
}

function resolveBaseRef(root, requested) {
  if (requested) {
    if (!git(root, ["rev-parse", "--verify", `${requested}^{commit}`])) {
      throw new Error(`base ref "${requested}" does not exist in this repository`);
    }
    return requested;
  }
  const head = git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
  if (head) return head.replace("refs/remotes/", "");
  for (const branch of DEFAULT_BASE_BRANCHES) {
    if (git(root, ["rev-parse", "--verify", branch])) return branch;
  }
  return "HEAD~1";
}

// Only added and modified lines matter: a line this branch deleted cannot be run.
function readChangedLines(root, baseRef, gitRoot) {
  const diff = git(root, ["diff", "-U0", `${baseRef}...HEAD`]);
  const changed = new Map();
  let currentFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const repoRelative = line.slice("+++ b/".length).trim();
      const absolute = path.resolve(gitRoot, repoRelative);
      currentFile = absolute.startsWith(`${root}${path.sep}`) ? path.relative(root, absolute) : "";
      if (currentFile && !SOURCE_EXTENSIONS.includes(path.extname(currentFile))) currentFile = "";
      continue;
    }
    const hunk = line.match(HUNK_HEADER);
    if (!hunk || !currentFile) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = changed.get(currentFile) ?? new Set();
    for (let offset = 0; offset < count; offset++) lines.add(start + offset);
    changed.set(currentFile, lines);
  }
  return changed;
}

async function readCoverageRuns(capturesDirectory) {
  if (!existsSync(capturesDirectory)) return [];
  const runs = [];
  for (const entry of await readdir(capturesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(capturesDirectory, entry.name, "coverage.json");
    if (!existsSync(file)) continue;
    runs.push(JSON.parse(await readFile(file, "utf8")));
  }
  return runs;
}

function mergeCoverage(runs) {
  const coveredLines = new Map();
  const loadedFiles = new Set();
  const routes = new Set();
  let fidelity = "loaded";
  for (const run of runs) {
    if (run.fidelity === "line") fidelity = "line";
    for (const route of run.routes ?? []) routes.add(route);
    for (const file of run.loadedFiles ?? []) loadedFiles.add(file);
    for (const [file, lines] of Object.entries(run.coveredLines ?? {})) {
      const merged = coveredLines.get(file) ?? new Set();
      for (const line of lines) merged.add(line);
      coveredLines.set(file, merged);
    }
  }
  return { fidelity, coveredLines, loadedFiles, routes: [...routes].sort() };
}

function buildReport({ baseRef, changed, coverage }) {
  const files = [];
  let changedLineTotal = 0;
  let coveredLineTotal = 0;
  for (const [file, lines] of [...changed].sort()) {
    const covered = coverage.coveredLines.get(file) ?? new Set();
    const coveredHere = [...lines].filter((line) => covered.has(line));
    changedLineTotal += lines.size;
    coveredLineTotal += coveredHere.length;
    files.push({
      file,
      changedLines: lines.size,
      coveredLines: coveredHere.length,
      loaded: coverage.loadedFiles.has(file),
      exercised: coverage.fidelity === "line" ? coveredHere.length > 0 : coverage.loadedFiles.has(file),
    });
  }
  const exercised = files.filter((entry) => entry.exercised);
  return {
    baseRef,
    fidelity: coverage.fidelity,
    routes: coverage.routes,
    changedFileCount: files.length,
    exercisedFileCount: exercised.length,
    changedLineTotal,
    coveredLineTotal,
    coveredLinePercent: changedLineTotal === 0 ? 0 : (coveredLineTotal / changedLineTotal) * FULL_PERCENT,
    files,
    notExercised: files.filter((entry) => !entry.exercised).map((entry) => entry.file),
  };
}

function printSummary(report) {
  if (report.changedFileCount === 0) {
    console.log("no changed source files to account for");
    return;
  }
  const headline =
    report.fidelity === "line"
      ? `${report.coveredLineTotal} of ${report.changedLineTotal} changed lines executed ` +
        `(${report.coveredLinePercent.toFixed(1)}%)`
      : `${report.exercisedFileCount} of ${report.changedFileCount} changed files reached the browser ` +
        `(no v8-to-istanbul, so this is file-level, not line-level)`;
  console.log(`base ${report.baseRef} · ${report.routes.length} routes captured`);
  console.log(headline);
  for (const entry of report.files) {
    const detail =
      report.fidelity === "line" ? `${entry.coveredLines}/${entry.changedLines} lines` : entry.loaded ? "loaded" : "never loaded";
    console.log(`  ${entry.exercised ? "ran " : "MISS"} ${entry.file}  ${detail}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  const root = realpathSync(path.resolve(flags.root ?? process.cwd()));
  const baseRef = resolveBaseRef(root, flags.base);
  const reportedGitRoot = git(root, ["rev-parse", "--show-toplevel"]).trim();
  const gitRoot = reportedGitRoot ? realpathSync(reportedGitRoot) : root;

  const changed = readChangedLines(root, baseRef, gitRoot);
  const runs = await readCoverageRuns(path.resolve(root, flags.captures ?? path.join(".peacock", "captures")));
  if (runs.length === 0) {
    console.error("no coverage.json found — rerun ui-capture.mjs with --coverage");
    return USAGE_EXIT_CODE;
  }
  const report = buildReport({ baseRef, changed, coverage: mergeCoverage(runs) });

  const outFile = path.resolve(root, flags.out ?? path.join(".peacock", "evidence", "diff-coverage.json"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);

  const nothingRan = report.changedFileCount > 0 && report.exercisedFileCount === 0;
  return nothingRan ? NOTHING_EXERCISED_EXIT_CODE : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = USAGE_EXIT_CODE;
}
