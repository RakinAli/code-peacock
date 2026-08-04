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
import {
  establishSession,
  loadPlaywright,
  looksSignedOut,
  resolveLoginSettings,
} from "./lib/peacock-login.mjs";

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
  --config <file>             Peacock config path     (default peacock.config.json)
  --a11y                      Save an ARIA snapshot per route
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

const BOOLEAN_FLAGS = new Set(["help", "video", "a11y", "require-login"]);

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

async function captureStills({ browser, flags, run, route, url, entries }) {
  const viewportNames = (flags.viewports ?? "desktop,mobile").split(",").map((value) => value.trim());
  let isSignedOut = false;
  for (const viewportName of viewportNames) {
    if (!VIEWPORTS[viewportName]) throw new Error(`unknown viewport: ${viewportName}`);
    const context = await browser.newContext(
      contextOptions({ viewportName, sessionFile: run.account.sessionFile })
    );
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);
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
    }
    await context.close();
  }
  return isSignedOut;
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

async function captureVideo({ browser, flags, run, route, url, entries, flowSteps }) {
  const context = await browser.newContext(
    contextOptions({
      viewportName: "desktop",
      sessionFile: run.account.sessionFile,
      extra: { recordVideo: { dir: run.out, size: VIEWPORTS.desktop } },
    })
  );
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (flowSteps) await runFlowSteps(page, flowSteps, flags["base-url"]);
  else await smoothScrollThrough(page);
  const recordedPath = await page.video().path();
  await context.close(); // flushes the recording
  const file = path.join(run.out, `${slugify(route)}-${run.account.name}-flow.webm`);
  await rename(recordedPath, file);
  entries.push({ route, account: run.account.name, viewport: "desktop", kind: "video", file });
  console.log(`  video -> ${file}`);
}

// A session that expired mid-run turns every later capture into a login page.
// Refresh it once, then redo the route that caught it.
async function captureRoute({ browser, flags, run, route, url, flowSteps }) {
  const entries = [];
  const isSignedOut = await captureStills({ browser, flags, run, route, url, entries });
  if (flags.video) await captureVideo({ browser, flags, run, route, url, entries, flowSteps });
  if (!isSignedOut || !run.canRecoverSession) return { entries, isSignedOut };

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
    return { entries, isSignedOut: true };
  }
  const retryEntries = [];
  const stillSignedOut = await captureStills({ browser, flags, run, route, url, entries: retryEntries });
  if (flags.video) {
    await captureVideo({ browser, flags, run, route, url, entries: retryEntries, flowSteps });
  }
  return { entries: retryEntries, isSignedOut: stillSignedOut };
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
const flowSteps = flags.actions ? JSON.parse(await readFile(flags.actions, "utf8")) : null;

const run = {
  account,
  login,
  out,
  loginDiagnosis: null,
  expectsSession: Boolean(login.url) || existsSync(account.sessionFile),
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
    if (result.isSignedOut) {
      failures.push({ route, account: account.name, error: "rendered signed out" });
    }
  } catch (error) {
    failures.push({ route, account: account.name, error: String(error) });
    console.error(`  FAILED ${route}: ${error}`);
  }
}

await browser.close();
const manifestFile = path.join(out, "manifest.json");
await writeFile(
  manifestFile,
  JSON.stringify(
    { account: describeAccount(account), login: run.loginDiagnosis, captures, failures },
    null,
    2
  )
);
console.log(`\n${captures.length} artifacts, ${failures.length} failed routes -> ${manifestFile}`);
process.exit(failures.length > 0 ? 1 : 0);
