#!/usr/bin/env node
// Peacock account auth — inspect which named test accounts a project needs,
// store their credentials locally, sign them in, and say precisely what to fix
// when a login fails.
//
// Exit codes: 0 ok · 2 usage · 3 login failed · 4 credentials missing.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { readPeacockConfig, resolveConfigFile } from "./lib/peacock-config.mjs";
import { loadPlaywright } from "./lib/peacock-require.mjs";
import {
  AUTH_DIRECTORY,
  describeAccount,
  findAccount,
  groupRoutesByAccount,
  resolveAccounts,
  saveCredentials,
} from "./lib/peacock-accounts.mjs";
import {
  credentialsMissingDiagnosis,
  establishSession,
  isSessionValid,
  resolveLoginSettings,
  signIn,
} from "./lib/peacock-login.mjs";

const HELP = `Usage: node peacock-auth.mjs <command> [options]

Commands:
  status     Which accounts exist, which credentials are missing, which routes each covers
  set        Store one account's credentials in .peacock/auth/.env (chmod 600, gitignored)
  login      Sign an account in through the browser and save its session
  verify     Check whether an account's saved session still works

Options:
  --account <name>     Account to act on               (default: the first configured account)
  --routes </a,/b>     status: show which account covers each route
  --base-url <url>     Dev server root                 (login, verify)
  --login-url <path>   Login page                      (default: login.url from peacock.config.json)
  --probe-route <path> Protected route used to test a session (default: login.probeRoute, else /)
  --email <address>    set: the account's email or username
  --force              login: ignore any saved session
  --json               status, verify: machine-readable output
  --root <dir>         Target repository               (default: current directory)
  --config <file>      Peacock config path             (default: peacock.config.json)
  --help

Credentials come from PEACOCK_<ACCOUNT>_EMAIL / PEACOCK_<ACCOUNT>_PASSWORD in the
environment, then from .peacock/auth/.env. Projects with one account also accept the
unscoped PEACOCK_EMAIL / PEACOCK_PASSWORD.
`;

const COMMANDS = new Set(["status", "set", "login", "verify"]);
const BOOLEAN_FLAGS = new Set(["force", "json", "help"]);
const VALUE_FLAGS = new Set([
  "account",
  "routes",
  "base-url",
  "login-url",
  "probe-route",
  "email",
  "root",
  "config",
]);
const USAGE_EXIT_CODE = 2;
const LOGIN_FAILED_EXIT_CODE = 3;
const CREDENTIALS_MISSING_EXIT_CODE = 4;
const STATUS_FILE = path.join(AUTH_DIRECTORY, "status.json");

class UsageError extends Error {}

function parseArgs(argumentsList) {
  const flags = {};
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (!argument.startsWith("--")) throw new UsageError(`unknown argument: ${argument}`);
    const key = argument.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`unknown flag: --${key}`);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`--${key} requires a value`);
    flags[key] = value;
    index++;
  }
  return flags;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let isMuted = false;
  rl._writeToOutput = (chunk) => {
    if (!isMuted) rl.output.write(chunk);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    isMuted = true;
  });
}

function readPipedSecret() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer.trim()));
    process.stdin.on("error", reject);
  });
}

async function loadContext(flags) {
  const root = path.resolve(flags.root ?? process.cwd());
  const config = await readPeacockConfig(resolveConfigFile(root, flags.config));
  const accounts = await resolveAccounts({ root, config, environment: process.env });
  const login = resolveLoginSettings(config, {
    url: flags["login-url"],
    probeRoute: flags["probe-route"],
  });
  return { root, config, accounts, login };
}

function selectAccount(accounts, name) {
  return name ? findAccount(accounts, name) : accounts[0];
}

function printStatus(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const account of report.accounts) {
    const credentials = account.hasCredentials
      ? `credentials from ${account.credentialSource}`
      : `MISSING ${account.missing.join(" + ")}`;
    console.log(`${account.name} — ${account.label}: ${credentials}`);
    console.log(`  variables: ${account.emailVariable} / ${account.passwordVariable}`);
    console.log(`  session:   ${account.hasSession ? account.sessionFile : "none saved yet"}`);
    if (account.routes.length > 0) console.log(`  routes:    ${account.routes.join(", ")}`);
  }
  for (const [route, accountName] of Object.entries(report.routeAccounts)) {
    console.log(`route ${route} -> ${accountName}`);
  }
}

async function commandStatus(flags) {
  const { accounts: allAccounts, login } = await loadContext(flags);
  const accounts = flags.account ? [findAccount(allAccounts, flags.account)] : allAccounts;
  const routes = (flags.routes ?? "").split(",").map((route) => route.trim()).filter(Boolean);
  const grouped = groupRoutesByAccount(routes, accounts);
  const routeAccounts = {};
  for (const [accountName, coveredRoutes] of grouped) {
    for (const route of coveredRoutes) routeAccounts[route] = accountName;
  }
  const described = accounts.map(describeAccount);
  printStatus(
    {
      loginUrl: login.url,
      accounts: described,
      missingAccounts: described.filter((account) => !account.hasCredentials).map((account) => account.name),
      routeAccounts,
    },
    flags.json
  );
  return 0;
}

async function commandSet(flags) {
  const { root, accounts } = await loadContext(flags);
  const account = selectAccount(accounts, flags.account);
  if (!process.stdin.isTTY) {
    if (!flags.email) {
      throw new UsageError("--email is required when the password is piped in");
    }
    const password = await readPipedSecret();
    if (!password) throw new UsageError("no password on stdin");
    const file = await saveCredentials(root, {
      [account.emailVariable]: flags.email,
      [account.passwordVariable]: password,
    });
    console.log(`saved ${account.emailVariable} and ${account.passwordVariable} to ${file}`);
    return 0;
  }
  console.log(`Credentials for "${account.label}" — stored only in ${path.join(root, ".peacock/auth/.env")}.`);
  console.log("Use a test account, never a real one.");
  const email = flags.email || (await ask(`  ${account.emailVariable} (email or username): `));
  if (!email) throw new UsageError("an email or username is required");
  const password = await askSecret(`  ${account.passwordVariable}: `);
  if (!password) throw new UsageError("a password is required");
  const file = await saveCredentials(root, {
    [account.emailVariable]: email,
    [account.passwordVariable]: password,
  });
  console.log(`saved to ${file}`);
  return 0;
}

async function recordDiagnosis(root, diagnosis) {
  const file = path.join(root, STATUS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const existing = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : { accounts: {} };
  existing.accounts[diagnosis.account] = { ...diagnosis, checkedAt: new Date().toISOString() };
  await writeFile(file, `${JSON.stringify(existing, null, 2)}\n`);
  return file;
}

function exitCodeFor(outcome) {
  if (outcome === "ok") return 0;
  return outcome === "credentials-missing" ? CREDENTIALS_MISSING_EXIT_CODE : LOGIN_FAILED_EXIT_CODE;
}

async function withBrowser(root, action) {
  const playwright = loadPlaywright(root);
  const browser = await playwright.chromium.launch();
  try {
    return await action(browser);
  } finally {
    await browser.close();
  }
}

async function commandLogin(flags) {
  const { root, accounts, login } = await loadContext(flags);
  const account = selectAccount(accounts, flags.account);
  if (!flags["base-url"]) throw new UsageError("--base-url is required for login");
  const isUnusable = account.missing.length > 0 && !existsSync(account.sessionFile);
  if (!isUnusable && !login.url) {
    throw new UsageError("no login page — pass --login-url or set login.url in peacock.config.json");
  }

  // Missing credentials are answered without a browser: needing Playwright
  // installed to be told a password is unset helps nobody.
  const diagnosis = isUnusable
    ? credentialsMissingDiagnosis({ account, login })
    : await withBrowser(root, (browser) =>
        flags.force
          ? signIn({ browser, account, login, baseUrl: flags["base-url"] })
          : establishSession({
              browser,
              account,
              login,
              baseUrl: flags["base-url"],
              probeRoute: flags["probe-route"],
            })
      );
  await recordDiagnosis(root, diagnosis);
  console.log(JSON.stringify(diagnosis, null, 2));
  return exitCodeFor(diagnosis.outcome);
}

async function commandVerify(flags) {
  const { root, accounts, login } = await loadContext(flags);
  const account = selectAccount(accounts, flags.account);
  if (!flags["base-url"]) throw new UsageError("--base-url is required for verify");
  if (!existsSync(account.sessionFile)) {
    console.log(JSON.stringify({ account: account.name, session: "none" }, null, 2));
    return LOGIN_FAILED_EXIT_CODE;
  }
  const isValid = await withBrowser(root, (browser) =>
    isSessionValid({ browser, account, login, baseUrl: flags["base-url"], probeRoute: flags["probe-route"] })
  );
  console.log(
    JSON.stringify({ account: account.name, session: isValid ? "valid" : "expired" }, null, 2)
  );
  return isValid ? 0 : LOGIN_FAILED_EXIT_CODE;
}

const COMMAND_HANDLERS = {
  status: commandStatus,
  set: commandSet,
  login: commandLogin,
  verify: commandVerify,
};

async function main(argumentsList) {
  const [command, ...rest] = argumentsList;
  if (!command || command === "--help" || command === "help") {
    console.log(HELP);
    return command ? 0 : USAGE_EXIT_CODE;
  }
  if (!COMMANDS.has(command)) throw new UsageError(`unknown command: ${command}`);
  const flags = parseArgs(rest);
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  return COMMAND_HANDLERS[command](flags);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof UsageError ? `${error.message}\n` : String(error.stack ?? error));
  if (error instanceof UsageError) console.error(HELP);
  process.exitCode = USAGE_EXIT_CODE;
}
