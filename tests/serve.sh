#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE="$REPO_ROOT/scripts/peacock-serve.mjs"
RUN="$REPO_ROOT/scripts/peacock-run.mjs"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/peacock-serve.XXXXXX")"
PORT=4299
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

PROJECT="$TEST_ROOT/project"
mkdir -p "$PROJECT/.peacock/captures/main" "$PROJECT/.peacock/auth" "$PROJECT/.peacock/evidence"
printf 'PEACOCK_APP_PASSWORD=hunter2\n' > "$PROJECT/.peacock/auth/.env"
printf 'fake png bytes' > "$PROJECT/.peacock/captures/main/home-app-desktop.png"
cat > "$PROJECT/.peacock/captures/main/manifest.json" <<'JSON'
{
  "captures": [{ "route": "/", "account": "app", "viewport": "desktop", "kind": "screenshot",
                 "file": ".peacock/captures/main/home-app-desktop.png" }],
  "problems": [{ "route": "/", "kind": "console", "text": "boom" }],
  "failures": []
}
JSON

node "$RUN" start --root "$PROJECT" --branch feature >/dev/null
node "$RUN" phase "Phase 5 — capture" --root "$PROJECT" --state done >/dev/null

node "$SERVE" --root "$PROJECT" --port "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true   # keep the teardown kill out of the test output

node -e '
const [port] = process.argv.slice(1);
const base = `http://127.0.0.1:${port}`;
const get = async (path) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await fetch(base + path);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server never came up for ${path}`);
};

const page = await get("/");
if (page.status !== 200) throw new Error(`GET / -> ${page.status}`);

const state = await (await get("/api/state")).json();
if (!state.run.runId) throw new Error("no run id in state");
if (state.run.events.length !== 2) throw new Error(`expected 2 events, got ${state.run.events.length}`);
if (state.captures.length !== 1) throw new Error("capture manifest not picked up");
if ((state.captures[0].problems ?? []).length !== 1) throw new Error("page problems not surfaced");

// Credentials must never be servable, however the path is spelled.
for (const path of [
  "/file?path=.peacock/auth/.env",
  "/file?path=.peacock/captures/../auth/.env",
  "/file?path=../../../etc/hosts",
  "/file?path=/etc/hosts",
  "/file?path=package.json",
]) {
  const response = await get(path);
  if (response.status !== 404) throw new Error(`${path} was served with ${response.status}`);
}

const capture = await get("/file?path=.peacock/captures/main/home-app-desktop.png");
if (capture.status !== 200) throw new Error(`capture was not served: ${capture.status}`);
' "$PORT"

echo "serve: ALL PASS"
