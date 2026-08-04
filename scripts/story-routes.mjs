#!/usr/bin/env node
// Turn a running Storybook into a capture list.
//
// The states a review most needs to see — loading, empty, error, permission-denied,
// the disabled variant — are the ones the real app hides behind a login, a seeded
// database, or a race you cannot trigger on demand. If the project already writes
// stories for them, they are one URL away.
//
// Emits the iframe routes for ui-capture.mjs, narrowed to the components this
// branch actually touched.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const HELP = `Usage: node story-routes.mjs --base-url <storybook-url> [options]

Options:
  --base-url <url>   Running Storybook, e.g. http://localhost:6006   (required)
  --paths <a,b>      Only stories whose importPath contains one of these
                     (pass the changed files from affected-routes.json)
  --out <file>       Write JSON here      (default: .peacock/evidence/stories.json)
  --routes           Print only the comma-separated routes, for --routes
  --help

Typical use:

  ROUTES=$(node story-routes.mjs --base-url http://localhost:6006 \\
             --paths src/components/button.tsx --routes)
  node ui-capture.mjs --base-url http://localhost:6006 --routes "$ROUTES" --no-login
`;

const BOOLEAN_FLAGS = new Set(["routes", "help"]);
const VALUE_FLAGS = new Set(["base-url", "paths", "out"]);
const USAGE_EXIT_CODE = 2;
const STORY_INDEXES = ["index.json", "stories.json"];
const STORY_TYPE = "story";

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

async function fetchStoryIndex(baseUrl) {
  const failures = [];
  for (const name of STORY_INDEXES) {
    const url = new URL(name, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        failures.push(`${url} -> ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (error) {
      failures.push(`${url} -> ${String(error.message ?? error)}`);
    }
  }
  throw new Error(`no Storybook index found (${failures.join(", ")})`);
}

function readEntries(index) {
  const entries = index.entries ?? index.stories ?? {};
  return Object.values(entries).filter((entry) => (entry.type ?? STORY_TYPE) === STORY_TYPE);
}

function matchesChangedPaths(entry, wantedPaths) {
  if (wantedPaths.length === 0) return true;
  const importPath = (entry.importPath ?? "").replace(/^\.\//, "");
  return wantedPaths.some((wanted) => importPath.includes(wanted) || wanted.includes(importPath));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || !flags["base-url"]) {
    console.log(HELP);
    return flags.help ? 0 : USAGE_EXIT_CODE;
  }
  const wantedPaths = (flags.paths ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^\.\//, ""))
    .filter(Boolean);

  const index = await fetchStoryIndex(flags["base-url"]);
  const stories = readEntries(index)
    .filter((entry) => matchesChangedPaths(entry, wantedPaths))
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      name: entry.name,
      importPath: entry.importPath ?? "",
      route: `/iframe.html?id=${encodeURIComponent(entry.id)}&viewMode=story`,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const outFile = path.resolve(flags.out ?? path.join(".peacock", "evidence", "stories.json"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(
    outFile,
    `${JSON.stringify({ baseUrl: flags["base-url"], filteredBy: wantedPaths, stories }, null, 2)}\n`
  );

  if (flags.routes) {
    console.log(stories.map((story) => story.route).join(","));
    return 0;
  }
  console.log(`${stories.length} stories${wantedPaths.length > 0 ? " matching the changed files" : ""}`);
  for (const story of stories) console.log(`  ${story.title} / ${story.name}   ${story.importPath}`);
  console.log(`\n-> ${outFile}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = USAGE_EXIT_CODE;
}
