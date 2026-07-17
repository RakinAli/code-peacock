#!/usr/bin/env node
// Discover and run a target repository's own verification commands, preserving
// complete logs and a normalized manifest under .peacock/evidence/.

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const HELP = `Usage: node project-checks.mjs [options]

Options:
  --root <dir>       Target repository                    (default: current directory)
  --config <file>    Peacock config path                  (default: peacock.config.json)
  --out <dir>        Evidence directory                   (default: .peacock/evidence)
  --dry-run          Discover checks without running them
  --help             Show this help
`;

const BOOLEAN_FLAGS = new Set(["dry-run", "help"]);
const VALUE_FLAGS = new Set(["root", "config", "out"]);
const PACKAGE_SCRIPT_CHECKS = [
  ["lint", "lint"],
  ["format", "format:check"],
  ["format", "check:format"],
  ["types", "typecheck"],
  ["types", "type-check"],
  ["types", "check:types"],
  ["test", "test:unit"],
  ["test", "test"],
  ["e2e", "test:e2e"],
  ["e2e", "e2e"],
  ["build", "build"],
];
const PYTHON_CONFIG_MARKERS = {
  lint: ["[tool.ruff", "ruff"],
  types: ["[tool.mypy", "mypy"],
  test: ["[tool.pytest", "pytest"],
};
const CHECKS_MANIFEST_VERSION = 1;
const FAILED_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;

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

function stripJsonComments(source) {
  let result = "";
  let isString = false;
  let isEscaped = false;
  let comment = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (comment === "line") {
      if (character === "\n") {
        comment = null;
        result += character;
      }
      continue;
    }
    if (comment === "block") {
      if (character === "*" && next === "/") {
        comment = null;
        index++;
      }
      continue;
    }
    if (!isString && character === "/" && next === "/") {
      comment = "line";
      index++;
      continue;
    }
    if (!isString && character === "/" && next === "*") {
      comment = "block";
      index++;
      continue;
    }
    result += character;
    if (character === '"' && !isEscaped) isString = !isString;
    isEscaped = isString && character === "\\" && !isEscaped;
    if (character !== "\\") isEscaped = false;
  }
  return result;
}

async function readText(file) {
  if (!existsSync(file)) return "";
  return readFile(file, "utf8");
}

async function loadConfig(file) {
  const source = await readText(file);
  if (!source) return {};
  return validateConfig(JSON.parse(stripJsonComments(source)));
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("peacock config must be an object");
  }
  const checks = config.checks;
  if (checks === undefined) return config;
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
    throw new Error("checks must be an object");
  }
  if (checks.skip !== undefined && (!Array.isArray(checks.skip) || checks.skip.some((entry) => typeof entry !== "string"))) {
    throw new Error("checks.skip must be an array of category names");
  }
  if (checks.commands !== undefined && !Array.isArray(checks.commands)) {
    throw new Error("checks.commands must be an array");
  }
  for (const entry of checks.commands ?? []) validateCustomCheck(entry);
  return config;
}

function validateCustomCheck(entry) {
  if (typeof entry === "string" && entry.trim()) return;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("checks.commands entries must be command strings or objects");
  }
  if (typeof entry.command !== "string" || !entry.command.trim()) {
    throw new Error("checks.commands entries require a non-empty command");
  }
  if (entry.name !== undefined && typeof entry.name !== "string") {
    throw new Error("checks.commands entry names must be strings");
  }
  if (entry.category !== undefined && typeof entry.category !== "string") {
    throw new Error("checks.commands entry categories must be strings");
  }
}

function commandExists(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function packageManagerFor(projectRoot, packageManifest) {
  const declared = packageManifest.packageManager?.split("@")[0];
  if (declared) return declared;
  if (existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(projectRoot, "bun.lockb")) || existsSync(path.join(projectRoot, "bun.lock"))) return "bun";
  return "npm";
}

function packageRunCommand(packageManager, scriptName) {
  if (packageManager === "yarn") return `yarn ${shellQuote(scriptName)}`;
  return `${packageManager} run ${shellQuote(scriptName)}`;
}

async function discoverPackageChecks(projectRoot) {
  const manifestFile = path.join(projectRoot, "package.json");
  if (!existsSync(manifestFile)) return [];
  const packageManifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const packageManager = packageManagerFor(projectRoot, packageManifest);
  const scripts = packageManifest.scripts ?? {};
  return PACKAGE_SCRIPT_CHECKS.filter(([, scriptName]) => scripts[scriptName]).map(
    ([category, scriptName]) => ({
      id: `package-${scriptName.replaceAll(":", "-")}`,
      category,
      source: `package.json#scripts.${scriptName}`,
      command: packageRunCommand(packageManager, scriptName),
    })
  );
}

async function discoverPythonChecks(projectRoot) {
  const pyprojectFile = path.join(projectRoot, "pyproject.toml");
  if (!existsSync(pyprojectFile)) return [];
  const pyproject = await readFile(pyprojectFile, "utf8");
  const python = commandExists("python3") ? "python3" : "python";
  const definitions = [
    ["lint", "ruff", `${python} -m ruff check .`],
    ["types", "mypy", `${python} -m mypy .`],
    ["test", "pytest", `${python} -m pytest`],
  ];
  return definitions
    .filter(([category]) => PYTHON_CONFIG_MARKERS[category].some((marker) => pyproject.includes(marker)))
    .map(([category, tool, command]) => ({
      id: `python-${tool}`,
      category,
      source: `pyproject.toml (${tool})`,
      command,
    }));
}

function discoverNativeChecks(projectRoot) {
  const checks = [];
  if (existsSync(path.join(projectRoot, "go.mod"))) {
    checks.push(
      { id: "go-vet", category: "lint", source: "go.mod", command: "go vet ./..." },
      { id: "go-test", category: "test", source: "go.mod", command: "go test ./..." }
    );
  }
  if (existsSync(path.join(projectRoot, "Cargo.toml"))) {
    checks.push(
      { id: "cargo-fmt", category: "format", source: "Cargo.toml", command: "cargo fmt --check" },
      { id: "cargo-clippy", category: "lint", source: "Cargo.toml", command: "cargo clippy --all-targets --all-features -- -D warnings" },
      { id: "cargo-test", category: "test", source: "Cargo.toml", command: "cargo test" }
    );
  }
  if (existsSync(path.join(projectRoot, "Gemfile"))) {
    if (existsSync(path.join(projectRoot, ".rubocop.yml"))) checks.push({ id: "ruby-rubocop", category: "lint", source: ".rubocop.yml", command: "bundle exec rubocop" });
    if (existsSync(path.join(projectRoot, "spec"))) checks.push({ id: "ruby-rspec", category: "test", source: "spec/", command: "bundle exec rspec" });
  }
  return checks;
}

async function discoverConventionalChecks(projectRoot) {
  const checks = [];
  if (existsSync(path.join(projectRoot, "pom.xml"))) {
    const command = existsSync(path.join(projectRoot, "mvnw")) ? "./mvnw verify" : "mvn verify";
    checks.push({ id: "maven-verify", category: "test", source: "pom.xml", command });
  }
  const hasGradleProject = existsSync(path.join(projectRoot, "build.gradle")) || existsSync(path.join(projectRoot, "build.gradle.kts"));
  if (hasGradleProject) {
    const command = existsSync(path.join(projectRoot, "gradlew")) ? "./gradlew check" : "gradle check";
    checks.push({ id: "gradle-check", category: "test", source: "Gradle build", command });
  }
  if (existsSync(path.join(projectRoot, "Package.swift"))) {
    checks.push({ id: "swift-test", category: "test", source: "Package.swift", command: "swift test" });
  }
  if (existsSync(path.join(projectRoot, "mix.exs"))) {
    checks.push(
      { id: "mix-format", category: "format", source: "mix.exs", command: "mix format --check-formatted" },
      { id: "mix-test", category: "test", source: "mix.exs", command: "mix test" }
    );
  }
  const testsDirectory = path.join(projectRoot, "tests");
  if (existsSync(testsDirectory)) {
    const shellTests = (await readdir(testsDirectory)).filter((entry) => entry.endsWith(".sh")).sort();
    for (const shellTest of shellTests) {
      checks.push({
        id: `shell-${shellTest.slice(0, -3)}`,
        category: "test",
        source: `tests/${shellTest}`,
        command: `bash ${shellQuote(path.join("tests", shellTest))}`,
      });
    }
  }
  return checks;
}

async function discoverDotnetChecks(projectRoot) {
  const entries = await readdir(projectRoot);
  const projectFile = entries.find((entry) => entry.endsWith(".sln") || entry.endsWith(".csproj"));
  if (!projectFile) return [];
  return [{ id: "dotnet-test", category: "test", source: projectFile, command: `dotnet test ${shellQuote(projectFile)}` }];
}

function customChecks(config) {
  const commands = config.checks?.commands ?? [];
  return commands.map((entry, index) => {
    if (typeof entry === "string") {
      return { id: `custom-${index + 1}`, category: "custom", source: "peacock.config.json", command: entry };
    }
    return {
      id: entry.name ?? `custom-${index + 1}`,
      category: entry.category ?? "custom",
      source: "peacock.config.json",
      command: entry.command,
    };
  });
}

function uniqueChecks(checks, skippedCategories) {
  const commands = new Set();
  const identifiers = new Map();
  return checks.filter((check) => {
    if (skippedCategories.has(check.category) || commands.has(check.command)) return false;
    commands.add(check.command);
    return true;
  }).map((check) => {
    const count = (identifiers.get(check.id) ?? 0) + 1;
    identifiers.set(check.id, count);
    return count === 1 ? check : { ...check, id: `${check.id}-${count}` };
  });
}

function assignLogNames(checks) {
  const usedNames = new Set();
  return checks.map((check) => {
    const base = safeFileName(check.id);
    let logName = base;
    for (let suffix = 2; usedNames.has(logName); suffix++) {
      logName = `${base}-${suffix}`;
    }
    usedNames.add(logName);
    return { ...check, logName };
  });
}

async function discoverChecks(projectRoot, config) {
  const detected = [
    ...(await discoverPackageChecks(projectRoot)),
    ...(await discoverPythonChecks(projectRoot)),
    ...discoverNativeChecks(projectRoot),
    ...(await discoverDotnetChecks(projectRoot)),
    ...(await discoverConventionalChecks(projectRoot)),
    ...customChecks(config),
  ];
  return assignLogNames(uniqueChecks(detected, new Set(config.checks?.skip ?? [])));
}

function safeFileName(identifier) {
  return identifier.replace(/[^a-zA-Z0-9.-]+/g, "-");
}

async function runCheck(check, projectRoot, logsDirectory) {
  const startedAt = new Date();
  const logFile = path.join(logsDirectory, `${check.logName}.log`);
  const logStream = createWriteStream(logFile);
  logStream.write(`$ ${check.command}\n\n`);
  process.stdout.write(`\n[${check.category}] ${check.command}\n`);
  const exitCode = await new Promise((resolve) => {
    const child = spawn(check.command, { cwd: projectRoot, env: process.env, shell: true });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });
    child.on("error", (error) => {
      logStream.write(`\n${error.stack ?? error}\n`);
      resolve(FAILED_EXIT_CODE);
    });
    child.on("close", (code) => resolve(code ?? FAILED_EXIT_CODE));
  });
  await new Promise((resolve) => logStream.end(resolve));
  return {
    ...check,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    log: path.relative(path.dirname(logsDirectory), logFile),
  };
}

function summarize(results, skippedCategories) {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  return { total: results.length, passed, failed, skipped: skippedCategories.length };
}

async function writeManifest(file, projectRoot, status, checks, results, skippedCategories) {
  const manifest = {
    schemaVersion: CHECKS_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    projectRoot,
    status,
    summary: summarize(results, skippedCategories),
    configuration: { skippedCategories },
    discovered: checks,
    results,
  };
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }
  const projectRoot = path.resolve(flags.root ?? process.cwd());
  const configFile = path.resolve(projectRoot, flags.config ?? "peacock.config.json");
  const outputDirectory = path.resolve(projectRoot, flags.out ?? path.join(".peacock", "evidence"));
  const logsDirectory = path.join(outputDirectory, "logs");
  const manifestFile = path.join(outputDirectory, "checks.json");
  if (outputDirectory === projectRoot || outputDirectory === path.parse(outputDirectory).root) {
    throw new Error("--out must be a dedicated evidence directory, not the project or filesystem root");
  }
  await mkdir(outputDirectory, { recursive: true });
  await rm(manifestFile, { force: true });
  const config = await loadConfig(configFile);
  const skippedCategories = config.checks?.skip ?? [];
  const checks = await discoverChecks(projectRoot, config);
  console.log(`peacock discovered ${checks.length} project check${checks.length === 1 ? "" : "s"}`);
  for (const check of checks) console.log(`  ${check.category.padEnd(7)} ${check.command}`);
  await rm(logsDirectory, { force: true, recursive: true });
  if (flags["dry-run"]) {
    await writeManifest(manifestFile, projectRoot, "dry-run", checks, [], skippedCategories);
    console.log(`discovery evidence -> ${manifestFile}`);
    return;
  }
  await mkdir(logsDirectory, { recursive: true });
  const results = [];
  await writeManifest(manifestFile, projectRoot, "running", checks, results, skippedCategories);
  for (const check of checks) {
    results.push(await runCheck(check, projectRoot, logsDirectory));
    await writeManifest(manifestFile, projectRoot, "running", checks, results, skippedCategories);
  }
  let status = "passed";
  if (checks.length === 0) status = "no-checks";
  if (results.some((result) => result.status === "failed")) status = "failed";
  await writeManifest(manifestFile, projectRoot, status, checks, results, skippedCategories);
  console.log(`\nproject checks: ${status} -> ${manifestFile}`);
  if (status === "failed") process.exitCode = FAILED_EXIT_CODE;
}

main().catch((error) => {
  console.error(`project checks failed: ${error.stack ?? error}`);
  process.exitCode = USAGE_EXIT_CODE;
});
