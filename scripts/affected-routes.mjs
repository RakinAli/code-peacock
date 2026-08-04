#!/usr/bin/env node
// Which routes does this branch actually change?
//
// Grepping imports and following them by eye is the flakiest step in the
// pipeline: miss a route and the run reports on a subset while claiming
// completeness. This builds the reverse-dependency closure of the changed files
// and maps the route files it reaches back to URLs — deterministically, so route
// coverage becomes evidence instead of a claim.
//
// Uses the target project's dependency-cruiser when it has one, and falls back
// to a built-in import scanner so it works in a repo with neither.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readPeacockConfig, resolveConfigFile } from "./lib/peacock-config.mjs";

const HELP = `Usage: node affected-routes.mjs [options]

Options:
  --root <dir>      Target repository            (default: current directory)
  --base <ref>      Compare against this ref     (default: origin/HEAD, else main)
  --config <file>   Peacock config path          (default: peacock.config.json)
  --out <file>      Write JSON here              (default: .peacock/evidence/affected-routes.json)
  --json            Print JSON instead of a summary
  --help
`;

const BOOLEAN_FLAGS = new Set(["json", "help"]);
const VALUE_FLAGS = new Set(["root", "base", "config", "out"]);
const USAGE_EXIT_CODE = 2;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const INDEX_NAMES = SOURCE_EXTENSIONS.map((extension) => `index${extension}`);
const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build",
  "out", "coverage", ".peacock", ".turbo", "vendor", "target",
]);
const IMPORT_PATTERN =
  /(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']/g;
const ROUTE_GROUP = /^\(.*\)$/;
const DYNAMIC_SEGMENT = /^\[\[?\.{0,3}(.+?)\]?\]$/;
const DEFAULT_BASE_BRANCHES = ["main", "master"];

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
  const result = spawnSync("git", argumentsList, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function resolveBaseRef(root, requested) {
  // A base ref that does not exist would otherwise produce an empty diff, and an
  // empty diff reads exactly like "this branch changes no UI".
  if (requested) {
    if (!git(root, ["rev-parse", "--verify", `${requested}^{commit}`])) {
      throw new Error(`base ref "${requested}" does not exist in this repository`);
    }
    return requested;
  }
  const head = git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace("refs/remotes/", "");
  for (const branch of DEFAULT_BASE_BRANCHES) {
    if (git(root, ["rev-parse", "--verify", branch])) return branch;
  }
  return "HEAD~1";
}

function listChangedFiles(root, baseRef) {
  const committed = git(root, ["diff", "--name-only", `${baseRef}...HEAD`]);
  const working = git(root, ["diff", "--name-only", "HEAD"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  const files = [committed, working, untracked]
    .flatMap((output) => output.split("\n"))
    .map((file) => file.trim())
    .filter(Boolean);
  return [...new Set(files)];
}

async function loadPathAliases(root) {
  const aliases = [];
  for (const file of ["tsconfig.json", "jsconfig.json"]) {
    const configFile = path.join(root, file);
    if (!existsSync(configFile)) continue;
    const source = await readFile(configFile, "utf8");
    let compilerOptions = {};
    try {
      compilerOptions = JSON.parse(stripJsonc(source)).compilerOptions ?? {};
    } catch {
      continue; // a tsconfig peacock cannot parse is not a reason to stop
    }
    const baseUrl = path.join(root, compilerOptions.baseUrl ?? ".");
    for (const [pattern, targets] of Object.entries(compilerOptions.paths ?? {})) {
      aliases.push({ prefix: pattern.replace(/\*$/, ""), targets: targets.map((target) => path.join(baseUrl, target.replace(/\*$/, ""))) });
    }
  }
  return aliases.sort((left, right) => right.prefix.length - left.prefix.length);
}

function stripJsonc(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1");
}

async function collectSourceFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) files.push(full);
    }
  }
  await walk(root);
  return files;
}

async function resolveSpecifier(specifier, fromFile, root, aliases) {
  let candidate = "";
  if (specifier.startsWith(".")) {
    candidate = path.resolve(path.dirname(fromFile), specifier);
  } else {
    const alias = aliases.find((entry) => specifier.startsWith(entry.prefix));
    if (!alias) return "";
    candidate = path.join(alias.targets[0], specifier.slice(alias.prefix.length));
  }
  if (existsSync(candidate) && (await stat(candidate)).isFile()) return candidate;
  for (const extension of SOURCE_EXTENSIONS) {
    if (existsSync(candidate + extension)) return candidate + extension;
  }
  for (const indexName of INDEX_NAMES) {
    const indexFile = path.join(candidate, indexName);
    if (existsSync(indexFile)) return indexFile;
  }
  return "";
}

function readSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function dependencyCruiserGraph(root) {
  const binary = path.join(root, "node_modules", ".bin", "depcruise");
  if (!existsSync(binary)) return null;
  const result = spawnSync(binary, [".", "--output-type", "json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!result.stdout) return null;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const dependents = new Map();
  for (const module of report.modules ?? []) {
    for (const dependency of module.dependencies ?? []) {
      if (!dependency.resolved || dependency.resolved.includes("node_modules")) continue;
      const target = path.resolve(root, dependency.resolved);
      const list = dependents.get(target) ?? [];
      list.push(path.resolve(root, module.source));
      dependents.set(target, list);
    }
  }
  return dependents;
}

async function scannedGraph(root) {
  const aliases = await loadPathAliases(root);
  const files = await collectSourceFiles(root);
  const dependents = new Map();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const specifier of readSpecifiers(source)) {
      const resolved = await resolveSpecifier(specifier, file, root, aliases);
      if (!resolved) continue;
      const list = dependents.get(resolved) ?? [];
      list.push(file);
      dependents.set(resolved, list);
    }
  }
  return dependents;
}

function closeOverDependents(changedFiles, dependents) {
  const reached = new Set(changedFiles);
  const queue = [...changedFiles];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const dependent of dependents.get(current) ?? []) {
      if (reached.has(dependent)) continue;
      reached.add(dependent);
      queue.push(dependent);
    }
  }
  return reached;
}

function toRoute(relativeFile) {
  const segments = relativeFile.split(path.sep);
  const fileName = segments.pop() ?? "";
  const base = path.basename(fileName, path.extname(fileName));
  const anchor = segments.findIndex((segment) => segment === "app" || segment === "pages" || segment === "routes");
  if (anchor < 0) return null;

  const isAppRouter = base === "page" || base === "+page";
  const isPagesRouter = segments[anchor] === "pages" && !base.startsWith("_") && !base.startsWith("+");
  if (!isAppRouter && !isPagesRouter) return null;

  const parts = segments.slice(anchor + 1).filter((segment) => !ROUTE_GROUP.test(segment));
  if (isPagesRouter && base !== "index") parts.push(base);
  const route = `/${parts.map(toRouteSegment).join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return route || "/";
}

function toRouteSegment(segment) {
  const dynamic = segment.match(DYNAMIC_SEGMENT);
  return dynamic ? `:${dynamic[1]}` : segment;
}

function buildReport({ root, baseRef, changedFiles, reached, source }) {
  const routes = [];
  const nonRouteModules = [];
  for (const file of reached) {
    const relative = path.relative(root, file);
    const route = toRoute(relative);
    if (!route) {
      nonRouteModules.push(relative);
      continue;
    }
    routes.push({ route, file: relative, needsParams: route.includes(":") });
  }
  routes.sort((left, right) => left.route.localeCompare(right.route));
  return {
    baseRef,
    graphSource: source,
    changedFiles,
    affectedModuleCount: reached.size,
    routes,
    routesNeedingParams: routes.filter((entry) => entry.needsParams).map((entry) => entry.route),
    nonRouteModuleCount: nonRouteModules.length,
  };
}

function printSummary(report) {
  console.log(`base ${report.baseRef} · graph from ${report.graphSource}`);
  console.log(`${report.changedFiles.length} changed files -> ${report.affectedModuleCount} affected modules`);
  for (const entry of report.routes) {
    console.log(`  ${entry.route}${entry.needsParams ? "   (needs a real id)" : ""}   ${entry.file}`);
  }
  if (report.routes.length === 0) console.log("  no route files reached — non-UI change, or an unrecognised router layout");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  // Resolve symlinks on both sides: git reports the real path of the repository
  // root, and on macOS a /var/... project root is really /private/var/..., so an
  // unresolved comparison silently discards every changed file.
  const root = realpathSync(path.resolve(flags.root ?? process.cwd()));
  const config = await readPeacockConfig(resolveConfigFile(root, flags.config));
  const baseRef = resolveBaseRef(root, flags.base);
  const changedFiles = listChangedFiles(root, baseRef);
  // git reports paths from the repository root, which is not the project root in
  // a monorepo — resolve against the former and keep only what lives under the latter.
  const reportedGitRoot = git(root, ["rev-parse", "--show-toplevel"]);
  const gitRoot = reportedGitRoot ? realpathSync(reportedGitRoot) : root;
  const changedSourceFiles = changedFiles
    .filter((file) => SOURCE_EXTENSIONS.includes(path.extname(file)))
    .map((file) => path.resolve(gitRoot, file))
    .filter((file) => existsSync(file) && file.startsWith(`${root}${path.sep}`));

  const cruised = dependencyCruiserGraph(root);
  const dependents = cruised ?? (await scannedGraph(root));
  const reached = closeOverDependents(changedSourceFiles, dependents);
  const report = buildReport({
    root,
    baseRef,
    changedFiles,
    reached,
    source: cruised ? "dependency-cruiser" : "built-in scanner",
  });

  for (const route of config.routes?.include ?? []) {
    if (!report.routes.some((entry) => entry.route === route)) {
      report.routes.push({ route, file: "(peacock.config.json routes.include)", needsParams: false });
    }
  }
  const excluded = new Set(config.routes?.exclude ?? []);
  report.routes = report.routes.filter((entry) => !excluded.has(entry.route));

  const outFile = path.resolve(root, flags.out ?? path.join(".peacock", "evidence", "affected-routes.json"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(String(error.message ?? error));
  console.error(HELP);
  process.exitCode = USAGE_EXIT_CODE;
}
