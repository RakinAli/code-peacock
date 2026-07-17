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
    "commands": [
      { "name": "secret-redaction", "command": "node -e \"const value=process.env.PEACOCK_SIGNING_KEY; process.stdout.write(value.slice(0,5)); setTimeout(() => process.stdout.write(value.slice(5)), 25)\"" }
    ],
    "skip": ["build"]
  }
}
JSON

PEACOCK_SIGNING_KEY="super-secret-value" node "$REPO_ROOT/scripts/project-checks.mjs" --root "$PASS_PROJECT" >/dev/null
test ! -e "$PASS_PROJECT/.peacock/evidence/logs/stale.log"
if grep -R -q "super-secret-value" "$PASS_PROJECT/.peacock/evidence"; then
  echo "secret value leaked into evidence logs" >&2
  exit 1
fi
node -e '
  const manifest = require(process.argv[1]);
  if (manifest.status !== "passed") throw new Error(`expected passed, got ${manifest.status}`);
  if (manifest.summary.total !== 4) throw new Error(`expected 4 checks, got ${manifest.summary.total}`);
  if (manifest.summary.skipped !== 1) throw new Error(`expected 1 skipped category, got ${manifest.summary.skipped}`);
  if (!manifest.results.some((result) => result.category === "e2e")) throw new Error("missing e2e evidence");
' "$PASS_PROJECT/.peacock/evidence/checks.json"

cp "$PASS_PROJECT/.peacock/evidence/checks.json" "$PASS_PROJECT/completed-checks.json"
node "$REPO_ROOT/scripts/project-checks.mjs" --root "$PASS_PROJECT" --dry-run >/dev/null
cmp "$PASS_PROJECT/completed-checks.json" "$PASS_PROJECT/.peacock/evidence/checks.json"
test -f "$PASS_PROJECT/.peacock/evidence/discovery.json"
if node "$REPO_ROOT/scripts/project-checks.mjs" --root "$PASS_PROJECT" --out .. >/dev/null 2>&1; then
  echo "ancestor output directory was accepted" >&2
  exit 1
fi

FAIL_PROJECT="$TEST_ROOT/fail"
mkdir -p "$FAIL_PROJECT"
cat > "$FAIL_PROJECT/peacock.config.json" <<'JSON'
{
  // JSON comments are supported because the documented config is JSONC.
  "checks": {
    "commands": [
      { "name": "unit:fast", "command": "node -e \"process.exit(7)\"" },
      { "name": "unit fast", "command": "node -e \"console.log('complete evidence')\"" }
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
  const logs = new Set(manifest.results.map((result) => result.log));
  if (logs.size !== 2) throw new Error("colliding check ids must keep distinct logs");
' "$FAIL_PROJECT/.peacock/evidence/checks.json"

SHELL_PROJECT="$TEST_ROOT/shell"
mkdir -p "$SHELL_PROJECT/tests"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SHELL_PROJECT/tests/runnable.sh"
printf '#!/usr/bin/env bash\nexit 99\n' > "$SHELL_PROJECT/tests/helper.sh"
chmod +x "$SHELL_PROJECT/tests/runnable.sh"
node "$REPO_ROOT/scripts/project-checks.mjs" --root "$SHELL_PROJECT" --dry-run >/dev/null
node -e '
  const discovery = require(process.argv[1]);
  if (discovery.discovered.length !== 1 || discovery.discovered[0].source !== "tests/runnable.sh") {
    throw new Error(`expected only executable shell test: ${JSON.stringify(discovery.discovered)}`);
  }
' "$SHELL_PROJECT/.peacock/evidence/discovery.json"

PYTHON_PROJECT="$TEST_ROOT/python"
mkdir -p "$PYTHON_PROJECT"
cat > "$PYTHON_PROJECT/pyproject.toml" <<'TOML'
[project]
dependencies = ["pytest"]
TOML
node "$REPO_ROOT/scripts/project-checks.mjs" --root "$PYTHON_PROJECT" --dry-run >/dev/null
node -e '
  const discovery = require(process.argv[1]);
  if (discovery.discovered.length !== 0) throw new Error("dependency-only Python tools are not configured checks");
' "$PYTHON_PROJECT/.peacock/evidence/discovery.json"

echo "project-checks: ALL PASS"
