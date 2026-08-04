// Logging a peacock account in, verifying the session actually took, and
// diagnosing what to do when it did not.
//
// The failure this module exists to catch: filling a form and clicking submit
// always "succeeds". A wrong password, an MFA gate, or a renamed field all end
// with a saved session file and a run that quietly screenshots login pages.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_USER_SELECTOR =
  "input[type=email], input[name=email], input[name=username], input[name=login]";
const DEFAULT_PASSWORD_SELECTOR = "input[type=password]";
const DEFAULT_SUBMIT_SELECTOR = "button[type=submit], input[type=submit]";

const ERROR_SELECTOR =
  "[role=alert], [aria-live=assertive], [aria-invalid=true], .error, .form-error, [data-error]";
const CREDENTIAL_ERROR_TEXT =
  /(invalid|incorrect|wrong|do(es)? not match|failed|unable to (sign|log)|unauthori[sz]ed|denied|no account|check your)/i;
const BLOCKED_TEXT =
  /(verification code|two[- ]factor|2fa|one[- ]time code|authenticator|captcha|account (is )?locked|too many attempts|rate limit|suspended)/i;
const SETTLE_MS = 600;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 8_000;
const MAX_ERROR_CANDIDATES = 5;
const MAX_REASON_LENGTH = 240;
const MAX_BODY_SAMPLE = 4_000;
const LOGIN_VIEWPORT = { width: 1440, height: 900 };

function remedyFor(outcome, account, login) {
  switch (outcome) {
    case "ok":
      return "";
    case "credentials-missing":
      return `Ask for the ${account.label} credentials, then set ${account.emailVariable} and ${account.passwordVariable} (peacock-auth.mjs set --account ${account.name}).`;
    case "invalid-credentials":
      return `The app rejected the ${account.label} credentials. Ask for the correct password and rerun; do not retry the same value.`;
    case "blocked":
      return `The ${account.label} account is gated (MFA, captcha, or lockout). Use a test account without a second factor, or hand peacock an exported session at ${account.sessionFile}.`;
    case "form-not-found":
      return `The login form at ${login.url} did not match the selectors. Set login.userSelector / login.passSelector / login.submitSelector in peacock.config.json.`;
    case "unreachable":
      return "The login page did not load. Check baseUrl and that the dev server is up.";
    default:
      return `Submitted the form but the app still looks signed out. Set login.successSelector in peacock.config.json, or confirm ${account.label} may sign in at all.`;
  }
}

function diagnose({ outcome, account, login, url, reason, evidence, reused }) {
  return {
    account: account.name,
    label: account.label,
    outcome,
    reused: reused === true,
    url,
    reason,
    remedy: remedyFor(outcome, account, login),
    evidence,
  };
}

export function resolveLoginSettings(config, overrides = {}) {
  const login = config.login ?? {};
  return {
    url: overrides.url ?? login.url ?? "",
    userSelector: overrides.userSelector ?? login.userSelector ?? DEFAULT_USER_SELECTOR,
    passSelector: overrides.passSelector ?? login.passSelector ?? DEFAULT_PASSWORD_SELECTOR,
    submitSelector: overrides.submitSelector ?? login.submitSelector ?? DEFAULT_SUBMIT_SELECTOR,
    successSelector: overrides.successSelector ?? login.successSelector ?? "",
    signedOutSelector: overrides.signedOutSelector ?? login.signedOutSelector ?? "",
    probeRoute: overrides.probeRoute ?? login.probeRoute ?? "",
  };
}

async function settle(page) {
  await page
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

export async function looksSignedOut(page, login) {
  if (login.signedOutSelector) {
    return page
      .locator(login.signedOutSelector)
      .first()
      .isVisible()
      .catch(() => false);
  }
  const passwordVisible = await page
    .locator(DEFAULT_PASSWORD_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false);
  if (passwordVisible) return true;
  if (!login.url) return false;
  return new URL(page.url()).pathname === new URL(login.url, page.url()).pathname;
}

async function readFirstError(page) {
  const candidates = page.locator(ERROR_SELECTOR);
  const total = Math.min(await candidates.count(), MAX_ERROR_CANDIDATES);
  for (let index = 0; index < total; index++) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = (await candidate.innerText().catch(() => "")).trim();
    if (text) return text.slice(0, MAX_REASON_LENGTH);
  }
  return "";
}

async function saveFailureShot(page, account) {
  const file = path.join(path.dirname(account.sessionFile), `${account.name}-login-failure.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

async function fillLoginForm(page, login, account) {
  const user = page.locator(login.userSelector).first();
  const password = page.locator(login.passSelector).first();
  if ((await user.count()) === 0) return { filled: false, missing: "userSelector" };
  if ((await password.count()) === 0) return { filled: false, missing: "passSelector" };
  await user.fill(account.email);
  await password.fill(account.password);
  const submit = page.locator(login.submitSelector).first();
  // Plenty of real forms submit on Enter and have no button[type=submit];
  // that is a selector gap worth surviving, not a login failure.
  if ((await submit.count()) === 0) await password.press("Enter");
  else await submit.click();
  return { filled: true, missing: "" };
}

async function classifyResult(page, context, login) {
  if (login.successSelector) {
    const succeeded = await page
      .locator(login.successSelector)
      .first()
      .isVisible()
      .catch(() => false);
    if (succeeded) return { outcome: "ok", reason: "" };
  }
  const signedOut = await looksSignedOut(page, login);
  const state = await context.storageState();
  const hasSessionMaterial =
    state.cookies.length > 0 ||
    state.origins.some((origin) => (origin.localStorage ?? []).length > 0);
  if (!signedOut && hasSessionMaterial && !login.successSelector) {
    return { outcome: "ok", reason: "" };
  }
  const errorText = await readFirstError(page);
  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, MAX_BODY_SAMPLE);
  if (BLOCKED_TEXT.test(bodyText)) {
    return { outcome: "blocked", reason: errorText || "the page asks for a second factor" };
  }
  if (errorText && CREDENTIAL_ERROR_TEXT.test(errorText)) {
    return { outcome: "invalid-credentials", reason: errorText };
  }
  return { outcome: "unknown", reason: errorText || "still signed out after submitting" };
}

export function credentialsMissingDiagnosis({ account, login }) {
  return diagnose({
    outcome: "credentials-missing",
    account,
    login,
    url: "",
    reason: `no ${account.missing.join(" or ")} for account "${account.name}"`,
    evidence: {},
  });
}

export async function signIn({ browser, account, login, baseUrl }) {
  const context = await browser.newContext({ viewport: LOGIN_VIEWPORT });
  const page = await context.newPage();
  const loginUrl = new URL(login.url, baseUrl).href;
  try {
    try {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    } catch (error) {
      return diagnose({
        outcome: "unreachable",
        account,
        login,
        url: loginUrl,
        reason: String(error.message ?? error).slice(0, MAX_REASON_LENGTH),
        evidence: {},
      });
    }
    await settle(page);
    const form = await fillLoginForm(page, login, account);
    if (!form.filled) {
      return diagnose({
        outcome: "form-not-found",
        account,
        login,
        url: page.url(),
        reason: `login.${form.missing} matched no element`,
        evidence: { screenshot: await saveFailureShot(page, account) },
      });
    }
    await page.waitForURL((url) => url.href !== loginUrl, { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
    await settle(page);

    const result = await classifyResult(page, context, login);
    if (result.outcome !== "ok") {
      return diagnose({
        outcome: result.outcome,
        account,
        login,
        url: page.url(),
        reason: result.reason,
        evidence: { screenshot: await saveFailureShot(page, account) },
      });
    }
    await mkdir(path.dirname(account.sessionFile), { recursive: true });
    await context.storageState({ path: account.sessionFile });
    return diagnose({
      outcome: "ok",
      account,
      login,
      url: page.url(),
      reason: "",
      evidence: { sessionFile: account.sessionFile },
    });
  } finally {
    await context.close();
  }
}

export async function isSessionValid({ browser, account, login, baseUrl, probeRoute }) {
  const context = await browser.newContext({
    viewport: LOGIN_VIEWPORT,
    storageState: account.sessionFile,
  });
  const page = await context.newPage();
  try {
    await page.goto(new URL(probeRoute || "/", baseUrl).href, { waitUntil: "domcontentloaded" });
    await settle(page);
    return !(await looksSignedOut(page, login));
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

export async function establishSession(options) {
  const { browser, account, login, baseUrl, probeRoute, force } = options;
  if (!force && existsSync(account.sessionFile)) {
    const valid = await isSessionValid({ browser, account, login, baseUrl, probeRoute });
    if (valid) {
      return diagnose({
        outcome: "ok",
        account,
        login,
        url: new URL(probeRoute || "/", baseUrl).href,
        reason: "",
        evidence: { sessionFile: account.sessionFile },
        reused: true,
      });
    }
  }
  if (account.missing.length > 0) return credentialsMissingDiagnosis({ account, login });
  if (!login.url) {
    return diagnose({
      outcome: "form-not-found",
      account,
      login,
      url: "",
      reason: "no login.url configured",
      evidence: {},
    });
  }
  return signIn(options);
}
