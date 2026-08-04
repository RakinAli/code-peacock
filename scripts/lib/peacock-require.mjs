// Resolving packages from the TARGET project rather than from this plugin, so
// captures use the browser and audit builds the project already depends on.
// Peacock ships no npm dependencies of its own; everything optional degrades
// into a reported gap instead of a crash.

import { createRequire } from "node:module";
import path from "node:path";

const PLAYWRIGHT_PACKAGES = ["playwright", "playwright-core", "@playwright/test"];

export function requireFromProject(root, packageNames) {
  const requireFromRoot = createRequire(path.join(path.resolve(root), "package.json"));
  for (const packageName of packageNames) {
    try {
      return requireFromRoot(packageName);
    } catch {
      // try the next package name
    }
  }
  return null;
}

export function loadPlaywright(root) {
  const playwright = requireFromProject(root, PLAYWRIGHT_PACKAGES);
  if (playwright) return playwright;
  throw new Error(
    "Playwright not found in this project. Install it first:\n" +
      "  npm i -D playwright && npx playwright install chromium"
  );
}
