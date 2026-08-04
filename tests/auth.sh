#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTH="$REPO_ROOT/scripts/peacock-auth.mjs"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/peacock-auth.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

# --- an unconfigured project gets one account, named after the project ---------
SOLO="$TEST_ROOT/solo"
mkdir -p "$SOLO"
git -C "$SOLO" init -q .
printf '{ "name": "@acme/vetnio-web" }' > "$SOLO/package.json"

node "$AUTH" status --root "$SOLO" --json > "$SOLO/unset.json"
node -e '
  const report = require(process.argv[1]);
  const [account, ...extra] = report.accounts;
  if (extra.length) throw new Error("expected exactly one implicit account");
  if (account.name !== "vetnio-web") throw new Error(`expected vetnio-web, got ${account.name}`);
  if (account.emailVariable !== "PEACOCK_VETNIO_WEB_EMAIL") throw new Error(account.emailVariable);
  if (account.hasCredentials) throw new Error("unset credentials reported as present");
  if (report.missingAccounts.length !== 1) throw new Error("missing account not reported");
' "$SOLO/unset.json"

PEACOCK_EMAIL=legacy@example.test PEACOCK_PASSWORD=legacy-secret \
  node "$AUTH" status --root "$SOLO" --json > "$SOLO/legacy.json"
node -e '
  const [account] = require(process.argv[1]).accounts;
  if (!account.hasCredentials) throw new Error("legacy PEACOCK_EMAIL was not accepted");
  if (account.credentialSource !== "PEACOCK_EMAIL") throw new Error(account.credentialSource);
' "$SOLO/legacy.json"

PEACOCK_EMAIL=legacy@example.test PEACOCK_PASSWORD=legacy-secret \
  PEACOCK_VETNIO_WEB_EMAIL=scoped@example.test PEACOCK_VETNIO_WEB_PASSWORD=scoped-secret \
  node "$AUTH" status --root "$SOLO" --json > "$SOLO/scoped.json"
node -e '
  const [account] = require(process.argv[1]).accounts;
  if (account.credentialSource !== "PEACOCK_VETNIO_WEB_EMAIL") throw new Error(account.credentialSource);
  if (account.email !== "scoped@example.test") throw new Error("scoped variables must win over legacy ones");
' "$SOLO/scoped.json"

if grep -R -q "scoped-secret" "$SOLO"/*.json; then
  echo "password leaked into status output" >&2
  exit 1
fi

# --- declared accounts own their routes; legacy variables do not reach them ----
TEAM="$TEST_ROOT/team"
mkdir -p "$TEAM"
git -C "$TEAM" init -q .
printf '{ "name": "clinic" }' > "$TEAM/package.json"
cat > "$TEAM/peacock.config.json" <<'JSON'
{
  // two kinds of user
  "login": {
    "url": "/login",
    "accounts": [
      { "name": "clinic-admin", "label": "Clinic admin", "routes": ["/admin/**", "/organization"] },
      { "name": "clinic-vet", "label": "Veterinarian" }
    ]
  }
}
JSON

PEACOCK_EMAIL=legacy@example.test PEACOCK_PASSWORD=legacy-secret \
  node "$AUTH" status --root "$TEAM" --routes /admin,/admin/users,/organization,/dashboard --json > "$TEAM/routes.json"
node -e '
  const report = require(process.argv[1]);
  const expected = {
    "/admin": "clinic-admin",
    "/admin/users": "clinic-admin",
    "/organization": "clinic-admin",
    "/dashboard": "clinic-vet",
  };
  for (const [route, owner] of Object.entries(expected)) {
    if (report.routeAccounts[route] !== owner) {
      throw new Error(`${route} routed to ${report.routeAccounts[route]}, expected ${owner}`);
    }
  }
  if (report.accounts.some((account) => account.hasCredentials)) {
    throw new Error("legacy credentials must not stand in for a named account");
  }
' "$TEAM/routes.json"

# --- storing credentials: piped, private, gitignored, never echoed ------------
printf 'hunter2\n' | node "$AUTH" set --root "$TEAM" --account clinic-vet --email vet@example.test > "$TEAM/set.log"
if grep -q "hunter2" "$TEAM/set.log"; then
  echo "stored password was echoed back" >&2
  exit 1
fi
node -e '
  const { statSync } = require("node:fs");
  const mode = (statSync(process.argv[1]).mode & 0o777).toString(8);
  if (mode !== "600") throw new Error(`credentials file mode is ${mode}, expected 600`);
' "$TEAM/.peacock/auth/.env"
grep -q "^\.peacock/$" "$TEAM/.gitignore"

node "$AUTH" status --root "$TEAM" --json > "$TEAM/stored.json"
node -e '
  const stored = require(process.argv[1]).accounts.find((account) => account.name === "clinic-vet");
  if (!stored.hasCredentials) throw new Error("stored credentials were not read back");
  if (stored.email !== "vet@example.test") throw new Error(stored.email);
' "$TEAM/stored.json"

# --- a login with nothing to try answers without needing a browser ------------
set +e
node "$AUTH" login --root "$TEAM" --account clinic-admin --base-url http://localhost:1 > "$TEAM/login.json" 2>&1
LOGIN_STATUS=$?
set -e
test "$LOGIN_STATUS" -eq 4 || { echo "expected exit 4 for missing credentials, got $LOGIN_STATUS" >&2; exit 1; }
node -e '
  const diagnosis = require(process.argv[1]);
  if (diagnosis.outcome !== "credentials-missing") throw new Error(diagnosis.outcome);
  if (!diagnosis.remedy.includes("PEACOCK_CLINIC_ADMIN_PASSWORD")) throw new Error("remedy must name the variable to set");
' "$TEAM/login.json"

# --- usage errors stay usage errors -------------------------------------------
if node "$AUTH" status --root "$TEAM" --account nope >/dev/null 2>&1; then
  echo "unknown account was accepted" >&2
  exit 1
fi
if node "$AUTH" wat --root "$TEAM" >/dev/null 2>&1; then
  echo "unknown command was accepted" >&2
  exit 1
fi
printf '{ invalid json\n' > "$TEAM/peacock.config.json"
if node "$AUTH" status --root "$TEAM" >/dev/null 2>&1; then
  echo "malformed configuration was accepted" >&2
  exit 1
fi

echo "auth: ALL PASS"
