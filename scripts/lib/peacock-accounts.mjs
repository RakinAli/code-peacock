// Named peacock test accounts: what each one is called, where its credentials
// come from, where its browser session is cached, and which routes it covers.
//
// One project rarely has one kind of user. An admin sees pages a member never
// loads, so peacock resolves credentials per named account instead of assuming
// a single global login.

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const AUTH_DIRECTORY = path.join(".peacock", "auth");
const CREDENTIALS_FILE = path.join(AUTH_DIRECTORY, ".env");

const LEGACY_EMAIL_VARIABLE = "PEACOCK_EMAIL";
const LEGACY_PASSWORD_VARIABLE = "PEACOCK_PASSWORD";
const CREDENTIALS_FILE_MODE = 0o600;
const CREDENTIALS_LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;
const QUOTE_REQUIRED = /[\s#"']/;
const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/g;
const IGNORED_DIRECTORY = ".peacock/";
const SECTION_SUFFIX = "/**";

function toAccountName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toVariableSegment(accountName) {
  return accountName.replace(/-/g, "_").toUpperCase();
}

function emailVariableFor(accountName) {
  return `PEACOCK_${toVariableSegment(accountName)}_EMAIL`;
}

function passwordVariableFor(accountName) {
  return `PEACOCK_${toVariableSegment(accountName)}_PASSWORD`;
}

async function readCredentialsFile(file) {
  if (!existsSync(file)) return {};
  const text = await readFile(file, "utf8");
  const values = {};
  for (const line of text.split("\n")) {
    const match = line.match(CREDENTIALS_LINE);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

async function detectProjectName(root, config) {
  if (typeof config.name === "string" && config.name.trim()) return toAccountName(config.name);
  const packageFile = path.join(root, "package.json");
  if (existsSync(packageFile)) {
    const source = await readFile(packageFile, "utf8");
    let packageName = "";
    try {
      packageName = JSON.parse(source).name ?? "";
    } catch (error) {
      throw new Error(`package.json is not valid JSON (${packageFile}): ${error.message}`);
    }
    if (packageName) return toAccountName(packageName.replace(/^@[^/]+\//, ""));
  }
  return toAccountName(path.basename(path.resolve(root))) || "app";
}

function readCredentials(values, accountName, legacyAllowed) {
  const emailVariable = emailVariableFor(accountName);
  const passwordVariable = passwordVariableFor(accountName);
  const email = values[emailVariable] ?? "";
  const password = values[passwordVariable] ?? "";
  if (email && password) return { email, password, source: emailVariable, missing: [] };
  if (legacyAllowed && values[LEGACY_EMAIL_VARIABLE] && values[LEGACY_PASSWORD_VARIABLE]) {
    return {
      email: values[LEGACY_EMAIL_VARIABLE],
      password: values[LEGACY_PASSWORD_VARIABLE],
      source: LEGACY_EMAIL_VARIABLE,
      missing: [],
    };
  }
  const missing = [];
  if (!email) missing.push("email");
  if (!password) missing.push("password");
  return { email, password: "", source: "", missing };
}

function validateDeclaredAccount(declared, index) {
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw new Error(`login.accounts[${index}] must be an object`);
  }
  if (typeof declared.name !== "string" || !toAccountName(declared.name)) {
    throw new Error(`login.accounts[${index}].name must be a non-empty name`);
  }
  if (declared.label !== undefined && typeof declared.label !== "string") {
    throw new Error(`login.accounts[${index}].label must be a string`);
  }
  const routes = declared.routes;
  if (routes === undefined) return;
  if (!Array.isArray(routes) || routes.some((route) => typeof route !== "string")) {
    throw new Error(`login.accounts[${index}].routes must be an array of route patterns`);
  }
}

function buildAccount({ name, label, routes, root, values, legacyAllowed }) {
  const credentials = readCredentials(values, name, legacyAllowed);
  return {
    name,
    label: label || name,
    routes,
    emailVariable: emailVariableFor(name),
    passwordVariable: passwordVariableFor(name),
    email: credentials.email,
    password: credentials.password,
    credentialSource: credentials.source,
    missing: credentials.missing,
    sessionFile: path.join(root, AUTH_DIRECTORY, `${name}.storage-state.json`),
  };
}

export async function resolveAccounts({ root, config, environment }) {
  const fileValues = await readCredentialsFile(path.join(root, CREDENTIALS_FILE));
  const environmentValues = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => typeof value === "string" && value !== "")
  );
  const values = { ...fileValues, ...environmentValues };
  const declaredAccounts = config.login?.accounts;
  if (declaredAccounts === undefined) {
    const name = await detectProjectName(root, config);
    return [buildAccount({ name, label: name, routes: [], root, values, legacyAllowed: true })];
  }
  if (!Array.isArray(declaredAccounts) || declaredAccounts.length === 0) {
    throw new Error("login.accounts must be a non-empty array of accounts");
  }
  return declaredAccounts.map((declared, index) => {
    validateDeclaredAccount(declared, index);
    return buildAccount({
      name: toAccountName(declared.name),
      label: declared.label ?? declared.name,
      routes: declared.routes ?? [],
      root,
      values,
      legacyAllowed: false,
    });
  });
}

export function findAccount(accounts, name) {
  const wanted = toAccountName(name);
  const account = accounts.find((candidate) => candidate.name === wanted);
  if (account) return account;
  const known = accounts.map((candidate) => candidate.name).join(", ");
  throw new Error(`unknown account "${name}" — configured accounts: ${known}`);
}

// The password is deliberately absent: this shape is what gets printed, logged,
// and written into the run manifest.
export function describeAccount(account) {
  return {
    name: account.name,
    label: account.label,
    routes: account.routes,
    emailVariable: account.emailVariable,
    passwordVariable: account.passwordVariable,
    email: account.email,
    credentialSource: account.credentialSource,
    missing: account.missing,
    hasCredentials: account.missing.length === 0,
    sessionFile: account.sessionFile,
    hasSession: existsSync(account.sessionFile),
  };
}

function toRouteExpression(pattern) {
  return pattern
    .split("**")
    .map((segment) => segment.replace(REGEXP_SPECIAL, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
}

function matchesRoutePattern(route, pattern) {
  if (new RegExp(`^${toRouteExpression(pattern)}$`).test(route)) return true;
  // "/admin/**" reads as "the admin section", which includes /admin itself.
  if (pattern.endsWith(SECTION_SUFFIX)) return route === pattern.slice(0, -SECTION_SUFFIX.length);
  if (pattern.includes("*")) return false;
  return route.startsWith(`${pattern.replace(/\/$/, "")}/`);
}

function accountForRoute(route, accounts) {
  const fallback = accounts.find((account) => account.routes.length === 0) ?? accounts[0];
  let best = null;
  for (const account of accounts) {
    for (const pattern of account.routes) {
      if (!matchesRoutePattern(route, pattern)) continue;
      if (!best || pattern.length > best.pattern.length) best = { account, pattern };
    }
  }
  return best?.account ?? fallback;
}

export function groupRoutesByAccount(routes, accounts) {
  const groups = new Map();
  for (const route of routes) {
    const account = accountForRoute(route, accounts);
    const covered = groups.get(account.name) ?? [];
    covered.push(route);
    groups.set(account.name, covered);
  }
  return groups;
}

async function ensurePeacockIgnored(root) {
  if (!existsSync(path.join(root, ".git"))) return;
  const gitignore = path.join(root, ".gitignore");
  const current = existsSync(gitignore) ? await readFile(gitignore, "utf8") : "";
  const isIgnored = current
    .split("\n")
    .some((line) => line.trim() === IGNORED_DIRECTORY || line.trim() === ".peacock");
  if (isIgnored) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(gitignore, `${current}${separator}${IGNORED_DIRECTORY}\n`);
}

function formatCredentialLine(variable, value) {
  return QUOTE_REQUIRED.test(value) ? `${variable}="${value}"` : `${variable}=${value}`;
}

export async function saveCredentials(root, entries) {
  const file = path.join(root, CREDENTIALS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const merged = { ...(await readCredentialsFile(file)), ...entries };
  const body = Object.entries(merged)
    .map(([variable, value]) => formatCredentialLine(variable, value))
    .join("\n");
  await writeFile(file, `${body}\n`, { mode: CREDENTIALS_FILE_MODE });
  // writeFile only applies mode when it creates the file; an existing
  // world-readable credentials file would otherwise keep its permissions.
  await chmod(file, CREDENTIALS_FILE_MODE);
  await ensurePeacockIgnored(root);
  return file;
}
