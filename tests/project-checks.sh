#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/peacock-checks.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS_PROJECT="$TEST_ROOT/pass"
mkdir -p "$PASS_PROJECT/.peacock/evidence/logs"
echo "stale" > "$PASS_PROJECT/.peacock/evidence/logs/stale.log"
cat > "$PASS_PROJECT/package.json" <<'JSON'
{
  "scripts": {
    "lint": "node -e \"console.log('lint ok')\"",
    "test": "node -e \"console.log('tests ok')\"",
    "test:e2e": "node -e \"console.log('e2e ok')\"",
    "build": "node -e \"console.log('build ok')\""
  }
}
JSON
cat > "$PASS_PROJECT/peacock.config.json" <<'JSON'
{
  "checks": {
    "skip": ["build"]
  }
}
JSON

node "$REPO_ROOT/scripts/project-checks.mjs" --root "$PASS_PROJECT" >/dev/null
test ! -e "$PASS_PROJECT/.peacock/evidence/logs/stale.log"
node -e '
  const manifest = require(process.argv[1]);
  if (manifest.status !== "passed") throw new Error(`expected passed, got ${manifest.status}`);
  if (manifest.summary.total !== 3) throw new Error(`expected 3 checks, got ${manifest.summary.total}`);
  if (manifest.summary.skipped !== 1) throw new Error(`expected 1 skipped category, got ${manifest.summary.skipped}`);
  if (!manifest.results.some((result) => result.category === "e2e")) throw new Error("missing e2e evidence");
' "$PASS_PROJECT/.peacock/evidence/checks.json"

FAIL_PROJECT="$TEST_ROOT/fail"
mkdir -p "$FAIL_PROJECT"
cat > "$FAIL_PROJECT/peacock.config.json" <<'JSON'
{
  // JSON comments are supported because the documented config is JSONC.
  "checks": {
    "commands": [
      { "name": "fails", "command": "node -e \"process.exit(7)\"" },
      { "name": "still-runs", "command": "node -e \"console.log('complete evidence')\"" }
    ]
  }
}
JSON

if node "$REPO_ROOT/scripts/project-checks.mjs" --root "$FAIL_PROJECT" >/dev/null 2>&1; then
  echo "expected a failing project check run" >&2
  exit 1
fi
node -e '
  const manifest = require(process.argv[1]);
  if (manifest.status !== "failed") throw new Error(`expected failed, got ${manifest.status}`);
  if (manifest.summary.total !== 2 || manifest.summary.failed !== 1 || manifest.summary.passed !== 1) {
    throw new Error(`unexpected summary: ${JSON.stringify(manifest.summary)}`);
  }
' "$FAIL_PROJECT/.peacock/evidence/checks.json"

echo "project-checks: ALL PASS"
