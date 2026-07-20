# Universal project verification — end-to-end evidence

These artifacts exercise `scripts/project-checks.mjs`, the one-command,
project-agnostic verification runner introduced on this branch, plus the two
review hardening fixes. All transcripts are real CLI output captured against
throwaway sample repositories.

## A — Project-agnostic multi-stack discovery
- `A-discovery-transcript.txt` — `project-checks.mjs --dry-run` on a polyglot repo
  (JS `package.json`, Python `pyproject.toml`, Rust `Cargo.toml`, `tests/*.sh`).
  Discovers 13 checks spanning **lint, format, types, unit, e2e, build**, honoring
  the declared `pnpm` package manager.
- `A-discovery-manifest.json` — the machine-readable `checks.json` produced.

## B — Complete evidence preserved even when a check fails
- `B-failing-run-transcript.txt` — a full run where the type check fails mid-suite.
  The runner keeps going, runs every check, reports `failed`, and exits non-zero.
- `B-failing-run-manifest.json` — per-check `status` / `exitCode` / `log` for all
  four checks (3 passed, 1 failed); the failing check's complete log is preserved.

## C1 — Log filename collisions no longer overwrite evidence  (commit 574badf)
- `C1-log-collision-before-after.txt` — two checks whose names collapse to the same
  safe filename. **Before:** one `unit-api.log`, first check's evidence overwritten.
  **After:** `unit-api.log` + `unit-api-2.log`, both preserved.
- `C1-collision-manifest.json` — manifest recording distinct log paths per check.

## C2 — `--dry-run` is non-destructive of prior evidence  (commit bd6d76b)
- `C2-dryrun-nondestructive-before-after.txt` — a full run writes a real log, then a
  follow-up `--dry-run`. **Before:** the prior log was destroyed. **After:** it is
  preserved intact.

## D — Self-hosting
- `D-self-hosting-transcript.txt` / `D-self-hosting-manifest.json` — the runner
  pointed at the Peacock repo itself discovers and runs its own `tests/project-checks.sh`
  contract, passing.
