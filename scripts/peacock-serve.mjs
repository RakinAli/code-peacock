#!/usr/bin/env node
// Watch a peacock run in a browser instead of a terminal.
//
// Nothing here instruments the pipeline: every phase already writes structured
// files under .peacock/, so the server reads that directory, streams changes over
// Server-Sent Events, and renders them. Zero dependencies, loopback only.

import { createServer } from "node:http";
import { existsSync, watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const HELP = `Usage: node peacock-serve.mjs [options]

Options:
  --root <dir>   Repository being reviewed   (default: current directory)
  --port <n>     Port                        (default: 4288)
  --host <addr>  Bind address                (default: 127.0.0.1)
  --help

Serves a live view of .peacock/ — phases, captures, page problems, accessibility
violations, coverage of the diff, and the check table — updating as files land.
`;

const VALUE_FLAGS = new Set(["root", "port", "host"]);
const USAGE_EXIT_CODE = 2;
const DEFAULT_PORT = 4288;
const DEFAULT_HOST = "127.0.0.1";
const WATCH_DEBOUNCE_MS = 250;
const PEACOCK_DIRECTORY = ".peacock";
const IMAGE_TYPES = { ".png": "image/png", ".webm": "video/webm", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

function parseArgs(argumentsList) {
  const flags = {};
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (!argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
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
  return flags;
}

async function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null; // a file caught mid-write reappears on the next watch tick
  }
}

async function readEvents(root) {
  const pointer = path.join(root, PEACOCK_DIRECTORY, "runs", "current");
  if (!existsSync(pointer)) return { runId: "", events: [] };
  const runId = (await readFile(pointer, "utf8")).trim();
  const eventsFile = path.join(root, PEACOCK_DIRECTORY, "runs", runId, "events.jsonl");
  if (!existsSync(eventsFile)) return { runId, events: [] };
  const events = (await readFile(eventsFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { runId, events };
}

async function readCaptureRuns(root) {
  const capturesDirectory = path.join(root, PEACOCK_DIRECTORY, "captures");
  if (!existsSync(capturesDirectory)) return [];
  const runs = [];
  for (const entry of await readdir(capturesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson(path.join(capturesDirectory, entry.name, "manifest.json"));
    if (!manifest) continue;
    runs.push({ name: entry.name, ...manifest });
  }
  return runs;
}

async function readReports(root) {
  const reportsDirectory = path.join(root, PEACOCK_DIRECTORY, "reports");
  if (!existsSync(reportsDirectory)) return [];
  const files = await readdir(reportsDirectory);
  return files.filter((file) => file.endsWith(".html")).sort().reverse();
}

async function buildState(root) {
  const [run, captures, checks, coverage, routes, reports] = await Promise.all([
    readEvents(root),
    readCaptureRuns(root),
    readJson(path.join(root, PEACOCK_DIRECTORY, "evidence", "checks.json")),
    readJson(path.join(root, PEACOCK_DIRECTORY, "evidence", "diff-coverage.json")),
    readJson(path.join(root, PEACOCK_DIRECTORY, "evidence", "affected-routes.json")),
    readReports(root),
  ]);
  return { root, run, captures, checks, coverage, routes, reports };
}

// Only paths inside .peacock/ are servable, and only after resolution — a run
// directory is not a place to hand out arbitrary reads from.
function resolveServableFile(root, requested) {
  const peacockRoot = path.resolve(root, PEACOCK_DIRECTORY);
  const resolved = path.resolve(root, requested);
  if (!resolved.startsWith(`${peacockRoot}${path.sep}`)) return "";
  if (resolved.includes(`${path.sep}auth${path.sep}`)) return "";
  return existsSync(resolved) ? resolved : "";
}

function watchPeacock(root, onChange) {
  const target = path.join(root, PEACOCK_DIRECTORY);
  if (!existsSync(target)) return null;
  let timer = null;
  return watch(target, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>peacock — live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;--ink:#07152f;--paper:#f7f8f3;--card:#fff;--rule:#cad5d0;--muted:#54645f;
--teal:#087f78;--emerald:#17a673;--amber:#e6a600;--danger:#c2413b;
font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);line-height:1.5}
main{width:min(1180px,calc(100% - 2rem));margin:0 auto 4rem}
header{display:flex;flex-wrap:wrap;gap:1rem;align-items:baseline;justify-content:space-between;
padding:1.5rem 0;border-bottom:3px solid var(--ink)}
h1{font-size:1.6rem;margin:0;letter-spacing:-.03em}
h2{font-size:1.1rem;margin:2rem 0 .75rem;letter-spacing:-.02em}
.label{font:800 .68rem/1.2 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:var(--emerald);margin-right:.4rem}
.dot[data-state="stale"]{background:var(--muted)}
.grid{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:.9rem;min-width:0}
.card b{display:block;font-size:1.5rem;letter-spacing:-.03em}
ol.phases{list-style:none;padding:0;margin:0}
ol.phases li{display:flex;gap:.6rem;padding:.35rem 0;border-bottom:1px solid var(--rule);min-width:0}
ol.phases time{color:var(--muted);font:.75rem ui-monospace,Menlo,monospace;flex:none}
ol.phases span{min-width:0;overflow-wrap:anywhere}
.shots{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
figure{margin:0;background:var(--card);border:1px solid var(--rule);border-radius:10px;overflow:hidden}
figure img,figure video{display:block;width:100%}
figcaption{padding:.5rem .7rem;font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse}th,td{padding:.5rem .7rem;border-bottom:1px solid var(--rule);text-align:left;font-size:.9rem}
th{font:800 .68rem/1.2 ui-monospace,Menlo,monospace;text-transform:uppercase}
.wrap{background:var(--card);border:1px solid var(--rule);border-radius:10px;overflow-x:auto}
.pill{font-weight:800;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
.pill[data-tone="pass"]{color:var(--emerald)}.pill[data-tone="fail"]{color:var(--danger)}.pill[data-tone="warn"]{color:var(--amber)}
.empty{color:var(--muted);font-style:italic}
a{color:#4338ca}
@media(prefers-color-scheme:dark){:root{--ink:#ecfdf8;--paper:#07152f;--card:#0d2340;--rule:#31506a;--muted:#a9bdb8}}
</style></head><body><main>
<header><h1>🦚 peacock — live</h1><p class="label"><span class="dot" id="pulse"></span><span id="runid">waiting for a run</span></p></header>
<div id="app"></div>
</main>
<script>
const app = document.getElementById("app");
const escape = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fileUrl = (file) => "/file?path=" + encodeURIComponent(file);

function phases(events) {
  if (!events.length) return '<p class="empty">No events yet — the pipeline logs phases with peacock-run.mjs.</p>';
  return '<ol class="phases">' + events.map((event) => {
    const time = new Date(event.at).toLocaleTimeString();
    const label = event.type === "note" ? event.detail : (event.name || event.type) + (event.detail ? " — " + event.detail : "");
    const done = event.type === "phase:done" || event.type === "run:finish";
    return '<li><time>' + time + '</time><span>' + (done ? "✓ " : "") + escape(label) + '</span></li>';
  }).join("") + '</ol>';
}

function coverageCard(coverage) {
  if (!coverage) return "";
  const headline = coverage.fidelity === "line"
    ? coverage.coveredLineTotal + " / " + coverage.changedLineTotal
    : coverage.exercisedFileCount + " / " + coverage.changedFileCount;
  const unit = coverage.fidelity === "line" ? "changed lines executed" : "changed files reached the browser";
  return '<div class="card"><b>' + headline + '</b><span class="label">' + unit + '</span></div>';
}

function render(state) {
  document.getElementById("runid").textContent = state.run.runId || "no run started";
  const captures = state.captures.flatMap((run) => (run.captures || []).map((entry) => ({ ...entry, run: run.name })));
  const shots = captures.filter((entry) => entry.kind === "screenshot" || entry.kind === "video");
  const problems = state.captures.flatMap((run) => run.problems || []);
  const axe = captures.filter((entry) => entry.kind === "axe").flatMap((entry) => entry.violations || []);
  const results = (state.checks && state.checks.results) || [];

  app.innerHTML = [
    '<div class="grid">',
    '<div class="card"><b>' + shots.length + '</b><span class="label">captures</span></div>',
    '<div class="card"><b>' + problems.length + '</b><span class="label">console / network problems</span></div>',
    '<div class="card"><b>' + axe.length + '</b><span class="label">accessibility violations</span></div>',
    coverageCard(state.coverage),
    state.routes ? '<div class="card"><b>' + (state.routes.routes || []).length + '</b><span class="label">affected routes</span></div>' : "",
    '</div>',

    '<h2>Progress</h2>', phases(state.run.events),

    '<h2>Captures</h2>',
    shots.length ? '<div class="shots">' + shots.map((entry) =>
      '<figure>' + (entry.kind === "video"
        ? '<video src="' + fileUrl(entry.file) + '" controls muted></video>'
        : '<img loading="lazy" src="' + fileUrl(entry.file) + '" alt="">') +
      '<figcaption>' + escape(entry.route) + ' · ' + escape(entry.account || entry.run) + ' · ' + escape(entry.viewport) + '</figcaption></figure>'
    ).join("") + '</div>' : '<p class="empty">Nothing captured yet.</p>',

    problems.length ? '<h2>Page problems</h2><div class="wrap"><table><thead><tr><th>Route</th><th>Kind</th><th>Detail</th></tr></thead><tbody>' +
      problems.map((problem) => '<tr><td>' + escape(problem.route) + '</td><td>' + escape(problem.kind) + '</td><td>' + escape(problem.text) + '</td></tr>').join("") +
      '</tbody></table></div>' : "",

    axe.length ? '<h2>Accessibility</h2><div class="wrap"><table><thead><tr><th>Rule</th><th>Impact</th><th>Where</th></tr></thead><tbody>' +
      axe.map((violation) => '<tr><td><a href="' + escape(violation.helpUrl) + '" target="_blank" rel="noreferrer">' + escape(violation.id) + '</a></td><td>' +
      escape(violation.impact) + '</td><td>' + escape((violation.nodes || []).join(", ")) + '</td></tr>').join("") +
      '</tbody></table></div>' : "",

    results.length ? '<h2>Checks</h2><div class="wrap"><table><thead><tr><th>Check</th><th>Category</th><th>Status</th></tr></thead><tbody>' +
      results.map((result) => '<tr><td>' + escape(result.name) + '</td><td>' + escape(result.category) + '</td><td><span class="pill" data-tone="' +
      (result.status === "passed" ? "pass" : result.status === "skipped" ? "warn" : "fail") + '">' + escape(result.status) + '</span></td></tr>').join("") +
      '</tbody></table></div>' : "",

    state.reports.length ? '<h2>Report</h2><ul>' + state.reports.map((report) =>
      '<li><a href="' + fileUrl(".peacock/reports/" + report) + '" target="_blank" rel="noreferrer">' + escape(report) + '</a></li>').join("") + '</ul>' : "",
  ].join("");
}

async function refresh() {
  const response = await fetch("/api/state");
  render(await response.json());
}
refresh();
const stream = new EventSource("/events");
stream.onmessage = refresh;
stream.onerror = () => { document.getElementById("pulse").dataset.state = "stale"; };
</script></body></html>`;

const flags = parseArgs(process.argv.slice(2));
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}
const root = path.resolve(flags.root ?? process.cwd());
const port = Number(flags.port ?? DEFAULT_PORT);
const host = flags.host ?? DEFAULT_HOST;
const listeners = new Set();

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
    return;
  }
  if (url.pathname === "/api/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(await buildState(root)));
    return;
  }
  if (url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("retry: 2000\n\n");
    listeners.add(response);
    request.on("close", () => listeners.delete(response));
    return;
  }
  if (url.pathname === "/file") {
    const file = resolveServableFile(root, url.searchParams.get("path") ?? "");
    if (!file) {
      response.writeHead(404).end("not found");
      return;
    }
    const type = IMAGE_TYPES[path.extname(file)] ?? "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": type, "content-length": (await stat(file)).size });
    response.end(await readFile(file));
    return;
  }
  response.writeHead(404).end("not found");
});

watchPeacock(root, () => {
  for (const listener of listeners) listener.write("data: change\n\n");
});

server.listen(port, host, () => {
  console.log(`peacock live view: http://${host}:${port}  (watching ${path.join(root, PEACOCK_DIRECTORY)})`);
});
