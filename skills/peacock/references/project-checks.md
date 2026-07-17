# Project check discovery

Use `scripts/project-checks.mjs` as the deterministic source of check evidence. It runs
the target repository's own commands and writes `.peacock/evidence/checks.json` plus one
complete log per check.

## Built-in discovery

- JavaScript and TypeScript: package scripts for lint, format checking, type checking,
  unit tests, browser/E2E tests, and builds. Respect the declared package manager or
  lockfile.
- Python: configured Ruff, mypy, and pytest tools from `pyproject.toml`.
- Go: `go vet ./...` and `go test ./...`.
- Rust: rustfmt, Clippy, and Cargo tests.
- Ruby: RuboCop and RSpec when their conventional config/directories exist.
- .NET: `dotnet test` for a root solution or project.
- Java/Kotlin, Swift, and Elixir: Maven/Gradle verification, Swift tests, and Mix
  formatting/tests when their project files exist.
- Repository shell contracts: root `tests/*.sh` files, in stable filename order.

The runner executes every discovered check even after one fails so the evidence package
shows the complete state. A nonzero exit means one or more checks failed. `no-checks` is
not success evidence: create an idiomatic test/check setup, then rerun.

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

Do not summarize a command from terminal scrollback when its evidence log exists. Read
the manifest and cite the exact status, duration, and log path in the HTML report.
