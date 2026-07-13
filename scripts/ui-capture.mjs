#!/usr/bin/env node
// Peacock UI capture — headless-browser screenshots, hover/focus states,
// scroll/flow videos, and an accessibility snapshot for every route.
// Emits <out>/manifest.json describing every artifact so the pipeline can consume it.
//
// Playwright is resolved from the TARGET project (cwd), not from this plugin,
// so captures always use the browser build the project already depends on.

import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HELP = `Usage: node ui-capture.mjs --base-url <url> --routes /a,/b [options]

Options:
  --base-url <url>            Dev server root, e.g. http://localhost:3000  (required)
  --routes </a,/b>            Comma-separated routes to capture            (required)
  --out <dir>                 Output directory        (default .peacock/captures)
  --viewports <list>          desktop,mobile          (default desktop,mobile)
  --hover "<sel1, sel2>"      Capture hover + focus states for selectors
  --video                     Record a scroll-through video per route
  --actions <file.json>       Flow steps recorded on video: [{type,selector,value}]
                              types: click|fill|hover|press|goto|wait|scroll
  --storage-state <file>      Playwright storage state (reused if it exists)
  --login-url <url>           Log in first and save storage state. Credentials from
                              PEACOCK_EMAIL / PEACOCK_PASSWORD or .peacock/auth/.env
  --login-user-selector <sel> (default: input[type=email], input[name=email])
  --login-pass-selector <sel> (default: input[type=password])
  --login-submit-selector <sel> (default: button[type=submit])
  --a11y                      Save an ARIA snapshot per route
`;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const SETTLE_MS = 600;
const HOVER_TRANSITION_MS = 400;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function loadPlaywright() {
  const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
  for (const pkg of ["playwright", "playwright-core", "@playwright/test"]) {
    try {
      return requireFromProject(pkg);
    } catch {
      // try the next package name
    }
  }
  console.error(
    "Playwright not found in this project. Install it first:\n" +
      "  npm i -D playwright && npx playwright install chromium"
  );
  process.exit(2);
}

async function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const text = await readFile(file, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
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

async function login(browser, flags, out) {
  const email = process.env.PEACOCK_EMAIL;
  const password = process.env.PEACOCK_PASSWORD;
  if (!email || !password) {
    console.warn("login-url given but PEACOCK_EMAIL/PEACOCK_PASSWORD missing — skipping login");
    return;
  }
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  await page.goto(flags["login-url"], { waitUntil: "domcontentloaded" });
  await settle(page);
  const userSelector =
    flags["login-user-selector"] ?? "input[type=email], input[name=email], input[name=username]";
  const passSelector = flags["login-pass-selector"] ?? "input[type=password]";
  const submitSelector = flags["login-submit-selector"] ?? "button[type=submit]";
  await page.locator(userSelector).first().fill(email);
  await page.locator(passSelector).first().fill(password);
  await page.locator(submitSelector).first().click();
  await settle(page);
  const statePath = flags["storage-state"] ?? path.join(out, "storage-state.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await context.storageState({ path: statePath });
  await context.close();
  flags["storage-state"] = statePath;
  console.log(`logged in, session saved to ${statePath}`);
}

function contextOptions(flags, viewportName, extra = {}) {
  const statePath = flags["storage-state"];
  return {
    viewport: VIEWPORTS[viewportName],
    ...(statePath && existsSync(statePath) ? { storageState: statePath } : {}),
    ...extra,
  };
}

async function captureStills(browser, flags, route, url, out, manifest) {
  const viewportNames = (flags.viewports ?? "desktop,mobile").split(",").map((v) => v.trim());
  for (const viewportName of viewportNames) {
    if (!VIEWPORTS[viewportName]) throw new Error(`unknown viewport: ${viewportName}`);
    const context = await browser.newContext(contextOptions(flags, viewportName));
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);

    const base = `${slugify(route)}-${viewportName}`;
    const file = path.join(out, `${base}.png`);
    await page.screenshot({ path: file, fullPage: true });
    manifest.push({ route, viewport: viewportName, kind: "screenshot", file });
    console.log(`  ${viewportName} screenshot -> ${file}`);

    if (viewportName === "desktop" && flags.hover) {
      await captureInteractionStates(page, flags.hover, route, base, out, manifest);
    }
    if (viewportName === "desktop" && flags.a11y) {
      const snapshot = await page.locator("body").ariaSnapshot();
      const a11yFile = path.join(out, `${base}-aria.yml`);
      await writeFile(a11yFile, snapshot);
      manifest.push({ route, viewport: viewportName, kind: "a11y", file: a11yFile });
    }
    await context.close();
  }
}

async function captureInteractionStates(page, selectors, route, base, out, manifest) {
  for (const selector of selectors.split(",").map((s) => s.trim()).filter(Boolean)) {
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
      manifest.push({ route, viewport: "desktop", kind: state, selector, file });
      console.log(`  ${state} state (${selector}) -> ${file}`);
    }
    await page.mouse.move(0, 0);
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
    await page.waitForTimeout(400);
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

async function captureVideo(browser, flags, route, url, out, manifest, flowSteps) {
  const context = await browser.newContext(
    contextOptions(flags, "desktop", {
      recordVideo: { dir: out, size: VIEWPORTS.desktop },
    })
  );
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (flowSteps) {
    await runFlowSteps(page, flowSteps, flags["base-url"]);
  } else {
    await smoothScrollThrough(page);
  }
  const recordedPath = await page.video().path();
  await context.close(); // flushes the recording
  const file = path.join(out, `${slugify(route)}-flow.webm`);
  await rename(recordedPath, file);
  manifest.push({ route, viewport: "desktop", kind: "video", file });
  console.log(`  video -> ${file}`);
}

const flags = parseArgs(process.argv.slice(2));
if (flags.help || !flags["base-url"] || !flags.routes) {
  console.log(HELP);
  process.exit(flags.help ? 0 : 2);
}

const authEnv = await loadDotEnv(path.join(".peacock", "auth", ".env"));
process.env.PEACOCK_EMAIL ??= authEnv.PEACOCK_EMAIL;
process.env.PEACOCK_PASSWORD ??= authEnv.PEACOCK_PASSWORD;

const out = flags.out ?? path.join(".peacock", "captures");
await mkdir(out, { recursive: true });

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const manifest = [];
const failures = [];

const flowSteps = flags.actions ? JSON.parse(await readFile(flags.actions, "utf8")) : null;
if (flags["login-url"]) await login(browser, flags, out);

for (const route of flags.routes.split(",").map((r) => r.trim()).filter(Boolean)) {
  const url = new URL(route, flags["base-url"]).href;
  console.log(`capturing ${url}`);
  try {
    await captureStills(browser, flags, route, url, out, manifest);
    if (flags.video) await captureVideo(browser, flags, route, url, out, manifest, flowSteps);
  } catch (error) {
    failures.push({ route, error: String(error) });
    console.error(`  FAILED ${route}: ${error}`);
  }
}

await browser.close();
const manifestFile = path.join(out, "manifest.json");
await writeFile(manifestFile, JSON.stringify({ captures: manifest, failures }, null, 2));
console.log(`\n${manifest.length} artifacts, ${failures.length} failed routes -> ${manifestFile}`);
process.exit(failures.length > 0 ? 1 : 0);
