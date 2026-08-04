#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVER="$REPO_ROOT/scripts/affected-routes.mjs"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/peacock-routes.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

# The project lives in a subdirectory so this also covers the monorepo case,
# where git reports paths from the repository root and not the project root.
REPO="$TEST_ROOT/repo"
APP="$REPO/web"
mkdir -p "$APP/src/app/(sidebar)/workspaces/[workspaceId]" "$APP/src/app/(marketing)/pricing" "$APP/src/components"
git -C "$TEST_ROOT" init -q repo
git -C "$REPO" config user.email test@example.test
git -C "$REPO" config user.name Test

cat > "$APP/package.json" <<'JSON'
{ "name": "web" }
JSON
cat > "$APP/tsconfig.json" <<'JSON'
{ "compilerOptions": { "baseUrl": ".", "paths": { "@components/*": ["src/components/*"] } } }
JSON
cat > "$APP/src/components/button.tsx" <<'TSX'
export function Button() { return null; }
TSX
cat > "$APP/src/components/patientCard.tsx" <<'TSX'
import { Button } from "@components/button";
export function PatientCard() { return Button(); }
TSX
cat > "$APP/src/app/(sidebar)/workspaces/[workspaceId]/page.tsx" <<'TSX'
import { PatientCard } from "@components/patientCard";
export default function Page() { return PatientCard(); }
TSX
cat > "$APP/src/app/(marketing)/pricing/page.tsx" <<'TSX'
export default function Page() { return null; }
TSX

git -C "$REPO" add -A
git -C "$REPO" commit -qm "baseline"
BASE_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
git -C "$REPO" checkout -qb feature
printf 'export function Button() { return "changed"; }\n' > "$APP/src/components/button.tsx"
git -C "$REPO" add -A
git -C "$REPO" commit -qm "restyle the button"

node "$RESOLVER" --root "$APP" --base "$BASE_BRANCH" --out "$APP/routes.json" >/dev/null

# A base ref that does not exist must fail loudly, not report an empty diff.
if node "$RESOLVER" --root "$APP" --base no-such-branch >/dev/null 2>&1; then
  echo "missing base ref was accepted" >&2
  exit 1
fi

node -e '
  const report = require(process.argv[1]);
  const routes = report.routes.map((entry) => entry.route);
  // The button is two imports below the workspace page: a transitive walk finds it,
  // a one-level grep does not.
  if (!routes.includes("/workspaces/:workspaceId")) {
    throw new Error(`expected the workspace route, got ${JSON.stringify(routes)}`);
  }
  // Route groups are directories, not URL segments.
  if (routes.some((route) => route.includes("(sidebar)"))) throw new Error("route group leaked into the URL");
  // Nothing reaches the pricing page, so it must not be captured.
  if (routes.includes("/pricing")) throw new Error("unaffected route reported as affected");
  if (!report.routesNeedingParams.includes("/workspaces/:workspaceId")) {
    throw new Error("dynamic route not flagged as needing a real id");
  }
  if (report.changedFiles.length === 0) throw new Error("no changed files detected from the repository root");
' "$APP/routes.json"

if node "$RESOLVER" --root "$APP" --nope >/dev/null 2>&1; then
  echo "unknown flag was accepted" >&2
  exit 1
fi

echo "affected-routes: ALL PASS"
