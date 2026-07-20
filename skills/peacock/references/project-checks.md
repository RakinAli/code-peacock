# Project check discovery

Use `scripts/project-checks.mjs` as the deterministic source of check evidence. It runs
the target repository's own commands and writes `.peacock/evidence/checks.json` plus one
complete log per check.

## Built-in discovery

- JavaScript and TypeScript: package scripts for lint, format checking, type checking,
  unit tests, browser/E2E tests, and builds. Respect the declared package manager or
  lockfile.
- Python: Ruff, mypy, and pytest only when their `[tool.*]` configuration exists in
  `pyproject.toml`; a dependency or comment alone is not treated as a runnable check.
- Go: `go vet ./...` and `go test ./...`.
- Rust: rustfmt, Clippy, and Cargo tests.
- Ruby: RuboCop and RSpec when their conventional config/directories exist.
- .NET: `dotnet test` for a root solution or project.
- Java/Kotlin, Swift, and Elixir: Maven/Gradle verification, Swift tests, and Mix
  formatting/tests when their project files exist.
- Repository shell contracts: executable root `tests/*.sh` files, in stable filename
  order. Non-executable helpers and fixtures are ignored.

The runner executes every discovered check even after one fails so the evidence package
shows the complete state. A nonzero exit means one or more checks failed. `no-checks` is
not success evidence: create an idiomatic test/check setup, then rerun.

Before logs are written, Peacock redacts exact values of secret-like environment
variables (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*`, and credentials). Do not print
encoded, transformed, or derived secrets; no generic log sanitizer can recognize them.

## Overrides

Add repository-specific commands or skip inapplicable categories in
`peacock.config.json`:

```jsonc
{
  "checks": {
    "commands": [
      { "name": "api-contract", "category": "test", "command": "make contract-test" },
      "./scripts/verify.sh"
    ],
    "skip": ["build"]
  }
}
```

Run it from the target repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/project-checks.mjs"
```

`--dry-run` writes discovery to `.peacock/evidence/discovery.json` without modifying a
completed `checks.json` or its logs.

Do not summarize a command from terminal scrollback when its evidence log exists. Read
the manifest and cite the exact status, duration, and log path in the HTML report.
