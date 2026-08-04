#!/usr/bin/env node
// The run's event log.
//
// Everything else peacock produces is a file you read after the fact. This is the
// one thing that only exists in the agent's head — which phase it is on, what it
// just decided — so `peacock serve` has nothing to show without it. One JSONL
// line per event, appended, never rewritten.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HELP = `Usage: node peacock-run.mjs <command> [options]

Commands:
  start      Begin a run and print its id
  phase      Record a phase boundary:  phase "Phase 5 — capture" --state start|done
  note       Record anything worth seeing live: a finding, a decision, a gap
  finish     Close the run:  finish --verdict ship|fix-then-ship|rethink

Options:
  --state <start|done>   phase only                          (default: start)
  --verdict <text>       finish only
  --detail <text>        Free text shown next to the event
  --branch <name>        start only
  --base <ref>           start only
  --run <id>             Target a specific run  (default: the current one)
  --root <dir>           Target repository      (default: current directory)
  --help
`;

const COMMANDS = new Set(["start", "phase", "note", "finish"]);
const VALUE_FLAGS = new Set(["state", "verdict", "detail", "branch", "base", "run", "root"]);
const USAGE_EXIT_CODE = 2;
const RUNS_DIRECTORY = path.join(".peacock", "runs");
const CURRENT_POINTER = path.join(RUNS_DIRECTORY, "current");
const EVENTS_FILE = "events.jsonl";

function parseArgs(argumentsList) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (key === "help") {
      flags.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    flags[key] = value;
    index++;
  }
  return { flags, positional };
}

function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readCurrentRun(root) {
  const pointer = path.join(root, CURRENT_POINTER);
  if (!existsSync(pointer)) throw new Error("no run in progress — run `peacock-run.mjs start` first");
  return (await readFile(pointer, "utf8")).trim();
}

async function append(root, runId, event) {
  const directory = path.join(root, RUNS_DIRECTORY, runId);
  await mkdir(directory, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  await appendFile(path.join(directory, EVENTS_FILE), `${line}\n`);
}

async function main(argumentsList) {
  const [command, ...rest] = argumentsList;
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return command ? 0 : USAGE_EXIT_CODE;
  }
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}`);
  const { flags, positional } = parseArgs(rest);
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  const root = path.resolve(flags.root ?? process.cwd());
  const message = positional.join(" ").trim();

  if (command === "start") {
    const runId = flags.run ?? newRunId();
    await mkdir(path.join(root, RUNS_DIRECTORY), { recursive: true });
    await writeFile(path.join(root, CURRENT_POINTER), `${runId}\n`);
    await append(root, runId, {
      type: "run:start",
      branch: flags.branch ?? "",
      base: flags.base ?? "",
      detail: flags.detail ?? message,
    });
    console.log(runId);
    return 0;
  }

  const runId = flags.run ?? (await readCurrentRun(root));
  if (command === "phase") {
    if (!message) throw new Error("phase needs a name");
    await append(root, runId, { type: `phase:${flags.state ?? "start"}`, name: message, detail: flags.detail ?? "" });
    return 0;
  }
  if (command === "note") {
    if (!message) throw new Error("note needs something to say");
    await append(root, runId, { type: "note", detail: message });
    return 0;
  }
  await append(root, runId, { type: "run:finish", verdict: flags.verdict ?? "", detail: flags.detail ?? message });
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = USAGE_EXIT_CODE;
}
