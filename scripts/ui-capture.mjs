#!/usr/bin/env node
// Peacock UI capture — headless-browser screenshots, hover/focus states,
// scroll/flow videos, and an accessibility snapshot for every route.
// Emits <out>/manifest.json describing every artifact so the pipeline can consume it.
//
// Playwright is resolved from the TARGET project (cwd), not from this plugin,
// so captures always use the browser build the project already depends on.
//
// One run captures as ONE named account (see peacock-auth.mjs). Projects with
// several kinds of user run it once per account.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { readPeacockConfig, resolveConfigFile } from "./lib/peacock-config.mjs";
import { describeAccount, findAccount, resolveAccounts } from "./lib/peacock-accounts.mjs";
import { loadPlaywright, requireFromProject } from "./lib/peacock-require.mjs";
import { establishSession, looksSignedOut, resolveLoginSettings } from "./lib/peacock-login.mjs";
import { createCoverageCollector } from "./lib/peacock-coverage.mjs";

const HELP = `Usage: node ui-capture.mjs --base-url <url> --routes /a,/b [options]

Options:
  --base-url <url>            Dev server root, e.g. http://localhost:3000  (required)
  --routes </a,/b>            Comma-separated routes to capture            (required)
  --out <dir>                 Output directory        (default .peacock/captures)
  --account <name>            Sign in as this peacock account (default: the first one)
  --viewports <list>          desktop,mobile          (default desktop,mobile)
  --hover "<sel1, sel2>"      Capture hover + focus states for selectors
  --video                     Record a scroll-through video per route
  --actions <file.json>       Flow steps recorded on video: [{type,selector,value}]
                              types: click|fill|hover|press|goto|wait|scroll
  --storage-state <file>      Override the account's saved session file
  --login-url <url>           Log in first (default: login.url from peacock.config.json)
  --login-user-selector <sel> (default: input[type=email], input[name=email])
  --login-pass-selector <sel> (default: input[type=password])
  --login-submit-selector <sel> (default: button[type=submit])
  --require-login             Exit 3 instead of capturing signed-out pages
  --no-login                  Never sign in (Storybook and other unauthenticated targets)
  --config <file>             Peacock config path     (default peacock.config.json)
  --a11y                      ARIA snapshot + axe-core violations per route
  --trace                     Record a Playwright trace for each flow (implies --video)
  --coverage                  Record which source files the browser actually executed

Console errors and failed/5xx requests are always recorded per route into
manifest.json — a page that screenshots cleanly while throwing is a finding.
`;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const SETTLE_MS = 600;
const HOVER_TRANSITION_MS = 400;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;
const FLOW_STEP_PAUSE_MS = 400;
const USAGE_EXIT_CODE = 2;
const LOGIN_FAILED_EXIT_CODE = 3;
const MAX_PROBLEM_TEXT = 300;
const MAX_PROBLEMS_PER_ROUTE = 25;
const MAX_VIOLATION_NODES = 3;
const HTTP_ERROR_STATUS = 400;

const BOOLEAN_FLAGS = new Set(["help", "video", "a11y", "trace", "coverage", "require-login", "no-login"]);

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`flag --${key} requires a value`);
      process.exit(USAGE_EXIT_CODE);
    }
    flags[key] = value;
    index++;
  }
  return flags;
}

function slugify(text) {
  const slug = text.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "root";
}

async function settle(page) {
  await page
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

function contextOptions({ viewportName, sessionFile, extra = {} }) {
  return {
    viewport: VIEWPORTS[viewportName],
    ...(sessionFile && existsSync(sessionFile) ? { storageState: sessionFile } : {}),
    ...extra,
  };
}

// A page that screenshots cleanly while throwing errors and 404-ing its own API
// passes a visual review and fails a user. Record both, always.
function watchPageProblems(page, route, problems) {
  const record = (kind, text) => {
    if (problems.length >= MAX_PROBLEMS_PER_ROUTE) return;
    const entry = { route, kind, text: text.slice(0, MAX_PROBLEM_TEXT) };
    if (problems.some((seen) => seen.kind === entry.kind && seen.text === entry.text)) return;
    problems.push(entry);
  };
  page.on("console", (message) => {
    if (message.type() === "error") record("console", message.text());
  });
  page.on("pageerror", (error) => record("exception", String(error.message ?? error)));
  page.on("requestfailed", (request) => {
    record("request", `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("response", (response) => {
    if (response.status() >= HTTP_ERROR_STATUS) {
      record("response", `${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
}

function loadAxeBuilder(root) {
  const axe = requireFromProject(root, ["@axe-core/playwright"]);
  return axe?.default ?? axe?.AxeBuilder ?? axe ?? null;
}

// axe finds what a screenshot cannot prove: contrast ratios, missing names,
// broken roles. The model then spends its tokens on what axe cannot see.
async function findAccessibilityViolations(page, AxeBuilder) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.slice(0, MAX_VIOLATION_NODES).map((node) => node.target.join(" ")),
  }));
}

async function captureInteractionStates({ page, selectors, route, base, out, entries }) {
  for (const selector of selectors.split(",").map((value) => value.trim()).filter(Boolean)) {
    const target = page.locator(selector).first();
    if (!(await target.isVisible().catch(() => false))) {
      console.warn(`  hover target not visible, skipped: ${selector}`);
      continue;
    }
    for (const state of ["hover", "focus"]) {
      if (state === "hover") await target.hover();
      else await target.focus();
      await page.waitForTimeout(HOVER_TRANSITION_MS);
      const file = path.join(out, `${base}-${state}-${slugify(selector)}.png`);
      await page.screenshot({ path: file });
      entries.push({ route, viewport: "desktop", kind: state, selector, file });
      console.log(`  ${state} state (${selector}) -> ${file}`);
    }
    await page.mouse.move(0, 0);
  }
}

async function captureStills({ browser, flags, run, route, url, entries, problems }) {
  const viewportNames = (flags.viewports ?? "desktop,mobile").split(",").map((value) => value.trim());
  let isSignedOut = false;
  for (const viewportName of viewportNames) {
    if (!VIEWPORTS[viewportName]) throw new Error(`unknown viewport: ${viewportName}`);
    const context = await browser.newContext(
      contextOptions({ viewportName, sessionFile: run.account.sessionFile })
    );
    const page = await context.newPage();
    watchPageProblems(page, route, problems);
    const isCoverageViewport = viewportName === viewportNames[0] && Boolean(run.coverage);
    if (isCoverageViewport) {
      await page.coverage.startJSCoverage({ resetOnNavigation: false }).catch(() => {});
    }
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);
    if (isCoverageViewport) {
      const scripts = await page.coverage.stopJSCoverage().catch(() => []);
      await run.coverage.add(page, route, scripts);
    }
    if (viewportName === viewportNames[0] && run.expectsSession) {
      isSignedOut = await looksSignedOut(page, run.login);
    }

    const base = `${slugify(route)}-${run.account.name}-${viewportName}`;
    const file = path.join(run.out, `${base}.png`);
    await page.screenshot({ path: file, fullPage: true });
    entries.push({ route, account: run.account.name, viewport: viewportName, kind: "screenshot", file });
    console.log(`  ${viewportName} screenshot -> ${file}`);

    if (viewportName === "desktop" && flags.hover) {
      await captureInteractionStates({ page, selectors: flags.hover, route, base, out: run.out, entries });
    }
    if (viewportName === "desktop" && flags.a11y) {
      const snapshot = await page.locator("body").ariaSnapshot();
      const a11yFile = path.join(run.out, `${base}-aria.yml`);
      await writeFile(a11yFile, snapshot);
      entries.push({ route, account: run.account.name, viewport: viewportName, kind: "a11y", file: a11yFile });
      await auditAccessibility({ page, route, run, entries });
    }
    await context.close();
  }
  return isSignedOut;
}

async function auditAccessibility({ page, route, run, entries }) {
  if (!run.axeBuilder) return;
  try {
    const violations = await findAccessibilityViolations(page, run.axeBuilder);
    entries.push({ route, account: run.account.name, viewport: "desktop", kind: "axe", violations });
    console.log(`  axe -> ${violations.length} violations`);
  } catch (error) {
    entries.push({
      route,
      account: run.account.name,
      viewport: "desktop",
      kind: "axe",
      error: String(error.message ?? error),
    });
    console.error(`  axe FAILED on ${route}: ${error}`);
  }
}

async function runFlowSteps(page, steps, baseUrl) {
  for (const step of steps) {
    const target = step.selector ? page.locator(step.selector).first() : null;
    switch (step.type) {
      case "click":
        await target.click();
        break;
      case "fill":
        await target.fill(step.value ?? "");
        break;
      case "hover":
        await target.hover();
        break;
      case "press":
        await page.keyboard.press(step.value ?? "Enter");
        break;
      case "goto":
        await page.goto(new URL(step.value, baseUrl).href, { waitUntil: "domcontentloaded" });
        break;
      case "wait":
        await page.waitForTimeout(Number(step.value ?? 1000));
        break;
      case "scroll":
        await smoothScrollThrough(page);
        break;
      default:
        throw new Error(`unknown action type: ${step.type}`);
    }
    await page.waitForTimeout(FLOW_STEP_PAUSE_MS);
  }
}

async function smoothScrollThrough(page) {
  await page.evaluate(async () => {
    const step = 120;
    const bottom = () => document.body.scrollHeight - innerHeight;
    for (let y = 0; y <= bottom(); y += step) {
      scrollTo({ top: y });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    scrollTo({ top: 0, behavior: "smooth" });
    await new Promise((resolve) => setTimeout(resolve, 800));
  });
}

async function captureVideo({ browser, flags, run, route, url, entries, problems, flowSteps }) {
  const context = await browser.newContext(
    contextOptions({
      viewportName: "desktop",
      sessionFile: run.account.sessionFile,
      extra: { recordVideo: { dir: run.out, size: VIEWPORTS.desktop } },
    })
  );
  const base = `${slugify(route)}-${run.account.name}`;
  // A trace carries DOM snapshots, network and console in one replayable file —
  // strictly more than the video for anyone debugging the flow.
  const traceFile = flags.trace ? path.join(run.out, `${base}-flow.trace.zip`) : "";
  if (traceFile) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  watchPageProblems(page, route, problems);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (flowSteps) await runFlowSteps(page, flowSteps, flags["base-url"]);
  else await smoothScrollThrough(page);
  const recordedPath = await page.video().path();
  if (traceFile) await context.tracing.stop({ path: traceFile });
  await context.close(); // flushes the recording
  const file = path.join(run.out, `${base}-flow.webm`);
  await rename(recordedPath, file);
  entries.push({ route, account: run.account.name, viewport: "desktop", kind: "video", file });
  console.log(`  video -> ${file}`);
  if (traceFile) {
    entries.push({ route, account: run.account.name, viewport: "desktop", kind: "trace", file: traceFile });
    console.log(`  trace -> ${traceFile}`);
  }
}

// A session that expired mid-run turns every later capture into a login page.
// Refresh it once, then redo the route that caught it.
async function captureRoute({ browser, flags, run, route, url, flowSteps }) {
  const entries = [];
  const problems = [];
  const isSignedOut = await captureStills({ browser, flags, run, route, url, entries, problems });
  if (flags.video) await captureVideo({ browser, flags, run, route, url, entries, problems, flowSteps });
  if (!isSignedOut || !run.canRecoverSession) return { entries, problems, isSignedOut };

  console.warn(`  ${route} rendered signed out — refreshing the ${run.account.name} session`);
  run.canRecoverSession = false;
  const recovery = await establishSession({
    browser,
    account: run.account,
    login: run.login,
    baseUrl: flags["base-url"],
    probeRoute: route,
    force: true,
  });
  run.loginDiagnosis = recovery;
  if (recovery.outcome !== "ok") {
    console.error(`  session refresh failed (${recovery.outcome}): ${recovery.remedy}`);
    return { entries, problems, isSignedOut: true };
  }
  const retryEntries = [];
  const retryProblems = [];
  const stillSignedOut = await captureStills({
    browser, flags, run, route, url, entries: retryEntries, problems: retryProblems,
  });
  if (flags.video) {
    await captureVideo({
      browser, flags, run, route, url, entries: retryEntries, problems: retryProblems, flowSteps,
    });
  }
  return { entries: retryEntries, problems: retryProblems, isSignedOut: stillSignedOut };
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help || !flags["base-url"] || !flags.routes) {
  console.log(HELP);
  process.exit(flags.help ? 0 : USAGE_EXIT_CODE);
}

const root = process.cwd();
const config = await readPeacockConfig(resolveConfigFile(root, flags.config));
const accounts = await resolveAccounts({ root, config, environment: process.env });

let account;
try {
  account = flags.account ? findAccount(accounts, flags.account) : accounts[0];
} catch (error) {
  console.error(error.message);
  process.exit(USAGE_EXIT_CODE);
}
if (flags["storage-state"]) account.sessionFile = path.resolve(root, flags["storage-state"]);

const login = resolveLoginSettings(config, {
  url: flags["login-url"],
  userSelector: flags["login-user-selector"],
  passSelector: flags["login-pass-selector"],
  submitSelector: flags["login-submit-selector"],
});

const routes = flags.routes.split(",").map((route) => route.trim()).filter(Boolean);
const out = flags.out ?? path.join(".peacock", "captures");
await mkdir(out, { recursive: true });

let playwright;
try {
  playwright = loadPlaywright(root);
} catch (error) {
  console.error(error.message);
  process.exit(USAGE_EXIT_CODE);
}

const browser = await playwright.chromium.launch();
const captures = [];
const failures = [];
const problems = [];
const flowSteps = flags.actions ? JSON.parse(await readFile(flags.actions, "utf8")) : null;
const axeBuilder = flags.a11y ? loadAxeBuilder(root) : null;
const v8toIstanbul = flags.coverage ? requireFromProject(root, ["v8-to-istanbul"]) : null;
if (flags.coverage && !v8toIstanbul) {
  console.warn("v8-to-istanbul not installed — recording which files loaded, not which lines ran");
}
if (flags.a11y && !axeBuilder) {
  console.warn("@axe-core/playwright not installed — capturing ARIA snapshots without violations");
}

const run = {
  account,
  login,
  out,
  axeBuilder,
  coverage: flags.coverage ? createCoverageCollector(root, v8toIstanbul) : null,
  loginDiagnosis: null,
  expectsSession: !flags["no-login"] && (Boolean(login.url) || existsSync(account.sessionFile)),
  canRecoverSession: false,
};

if (run.expectsSession) {
  run.loginDiagnosis = await establishSession({
    browser,
    account,
    login,
    baseUrl: flags["base-url"],
    probeRoute: routes[0],
  });
  const { outcome, reused, remedy } = run.loginDiagnosis;
  if (outcome === "ok") {
    console.log(`signed in as ${account.name}${reused ? " (reused session)" : ""}`);
    run.canRecoverSession = account.missing.length === 0 && Boolean(login.url);
  } else {
    console.error(`login failed for ${account.name} (${outcome}): ${run.loginDiagnosis.reason}`);
    console.error(`  ${remedy}`);
    failures.push({ route: "(login)", account: account.name, error: outcome });
    if (flags["require-login"]) {
      await browser.close();
      process.exit(LOGIN_FAILED_EXIT_CODE);
    }
  }
}

for (const route of routes) {
  const url = new URL(route, flags["base-url"]).href;
  console.log(`capturing ${url}`);
  try {
    const result = await captureRoute({ browser, flags, run, route, url, flowSteps });
    captures.push(...result.entries);
    problems.push(...result.problems);
    if (result.problems.length > 0) {
      console.warn(`  ${result.problems.length} console/network problems on ${route}`);
    }
    if (result.isSignedOut) {
      failures.push({ route, account: account.name, error: "rendered signed out" });
    }
  } catch (error) {
    failures.push({ route, account: account.name, error: String(error) });
    console.error(`  FAILED ${route}: ${error}`);
  }
}

await browser.close();
if (run.coverage) {
  const coverageFile = path.join(out, "coverage.json");
  await writeFile(coverageFile, `${JSON.stringify(run.coverage.toJSON(), null, 2)}\n`);
  console.log(`coverage (${run.coverage.fidelity}) -> ${coverageFile}`);
}
const manifestFile = path.join(out, "manifest.json");
await writeFile(
  manifestFile,
  JSON.stringify(
    { account: describeAccount(account), login: run.loginDiagnosis, captures, problems, failures },
    null,
    2
  )
);
console.log(
  `\n${captures.length} artifacts, ${problems.length} page problems, ` +
    `${failures.length} failed routes -> ${manifestFile}`
);
process.exit(failures.length > 0 ? 1 : 0);
