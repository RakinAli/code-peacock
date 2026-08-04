# code-peacock — agent guide

This repo is both a Claude Code plugin and a Codex skill (with a backwards-compatible
`/peacock` prompt). The single source of truth for the pipeline is
`skills/peacock/SKILL.md`. The Codex skill (`~/.codex/skills/peacock/`) and the prompt
(`~/.codex/prompts/peacock.md`) are both *rendered* from it by
`scripts/install-codex.sh` — never edit the rendered copies directly, and never let them
drift from `SKILL.md`.

Rules when changing this repo:

- Keep `SKILL.md` runtime-neutral. `${CLAUDE_PLUGIN_ROOT}` is the one substitution
  token (the Codex installer string-replaces it with the checkout path); don't introduce
  other Claude-only or Codex-only syntax outside the "Runtime notes" table.
- Scripts must run with zero npm dependencies of their own. Playwright is resolved
  from the TARGET project's node_modules at runtime (`lib/peacock-login.mjs`), and GitHub
  auth goes through the `gh` CLI (`pr-threads.mjs`).
- `scripts/lib/` holds importable modules that do nothing at import time; everything
  directly under `scripts/` is an executable entry point. Keep that split — `ui-capture.mjs`
  and `peacock-auth.mjs` share the account and login modules, and a CLI that ran on import
  would break both.
- Credentials never leave `.peacock/auth/`. `describeAccount` exists so account data can be
  printed and written into manifests without the password riding along; keep it that way.
- Dogfood `skills/peacock/references/clean-code.md` in every change here.
- Verify before committing (`node --check` and `bash -n` only parse their first
  argument, hence the loops):
  `bash scripts/strut.sh && for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f"; done && for f in scripts/*.sh; do bash -n "$f"; done && bash tests/project-checks.sh && bash tests/auth.sh && bash tests/affected-routes.sh && bash tests/diff-coverage.sh && claude plugin validate .`
- Commit messages and PRs follow `skills/peacock/references/pr-style.md` — no AI
  attribution anywhere.
