#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COVERAGE="$REPO_ROOT/scripts/diff-coverage.mjs"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/peacock-coverage.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PROJECT="$TEST_ROOT/project"
mkdir -p "$PROJECT/src"
git -C "$TEST_ROOT" init -q project
git -C "$PROJECT" config user.email test@example.test
git -C "$PROJECT" config user.name Test

printf 'export const ran = 1;\n' > "$PROJECT/src/ran.ts"
printf 'export const skipped = 1;\n' > "$PROJECT/src/skipped.ts"
git -C "$PROJECT" add -A
git -C "$PROJECT" commit -qm baseline
BASE_BRANCH="$(git -C "$PROJECT" rev-parse --abbrev-ref HEAD)"
git -C "$PROJECT" checkout -qb feature
printf 'export const ran = 1;\nexport const alsoRan = 2;\n' > "$PROJECT/src/ran.ts"
printf 'export const skipped = 1;\nexport const neverRan = 2;\n' > "$PROJECT/src/skipped.ts"
git -C "$PROJECT" add -A
git -C "$PROJECT" commit -qm "touch both files"

mkdir -p "$PROJECT/.peacock/captures/main"
cat > "$PROJECT/.peacock/captures/main/coverage.json" <<'JSON'
{
  "fidelity": "line",
  "routes": ["/"],
  "loadedFiles": ["src/ran.ts"],
  "coveredLines": { "src/ran.ts": [1, 2] }
}
JSON

node "$COVERAGE" --root "$PROJECT" --base "$BASE_BRANCH" --out "$PROJECT/coverage-report.json" >/dev/null
node -e '
  const report = require(process.argv[1]);
  if (report.fidelity !== "line") throw new Error(`expected line fidelity, got ${report.fidelity}`);
  const ran = report.files.find((entry) => entry.file === "src/ran.ts");
  const skipped = report.files.find((entry) => entry.file === "src/skipped.ts");
  if (!ran?.exercised) throw new Error("a changed line that ran was reported as unexercised");
  if (skipped?.exercised) throw new Error("a changed file that never ran was reported as exercised");
  // Line 2 is the only added line in each file, so exactly one of the two ran.
  if (report.changedLineTotal !== 2) throw new Error(`expected 2 changed lines, got ${report.changedLineTotal}`);
  if (report.coveredLineTotal !== 1) throw new Error(`expected 1 covered line, got ${report.coveredLineTotal}`);
  if (!report.notExercised.includes("src/skipped.ts")) throw new Error("notExercised must name the missed file");
' "$PROJECT/coverage-report.json"

# Nothing exercised at all is a verdict blocker, so it must exit non-zero.
cat > "$PROJECT/.peacock/captures/main/coverage.json" <<'JSON'
{ "fidelity": "line", "routes": ["/"], "loadedFiles": [], "coveredLines": {} }
JSON
set +e
node "$COVERAGE" --root "$PROJECT" --base "$BASE_BRANCH" --out "$PROJECT/empty.json" >/dev/null
EMPTY_STATUS=$?
set -e
test "$EMPTY_STATUS" -eq 1 || { echo "expected exit 1 when no changed code ran, got $EMPTY_STATUS" >&2; exit 1; }

# No coverage at all is a usage problem, not a silent pass.
rm -rf "$PROJECT/.peacock/captures"
set +e
node "$COVERAGE" --root "$PROJECT" --base "$BASE_BRANCH" >/dev/null 2>&1
MISSING_STATUS=$?
set -e
test "$MISSING_STATUS" -eq 2 || { echo "expected exit 2 without coverage, got $MISSING_STATUS" >&2; exit 1; }

echo "diff-coverage: ALL PASS"
