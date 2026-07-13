# code-peacock — agent guide

This repo is both a Claude Code plugin and a Codex CLI prompt. The single source of
truth for the pipeline is `skills/peacock/SKILL.md`. The Codex prompt is *rendered*
from it by `scripts/install-codex.sh` — never edit `~/.codex/prompts/peacock.md`
directly, and never let the two drift.

Rules when changing this repo:

- Keep `SKILL.md` runtime-neutral. `${CLAUDE_PLUGIN_ROOT}` is the one substitution
  token (the Codex installer sed-replaces it with the checkout path); don't introduce
  other Claude-only or Codex-only syntax outside the "Runtime notes" table.
- Scripts must run with zero npm dependencies of their own. Playwright is resolved
  from the TARGET project's node_modules at runtime (`ui-capture.mjs`), and GitHub
  auth goes through the `gh` CLI (`pr-threads.mjs`).
- Dogfood `skills/peacock/references/clean-code.md` in every change here.
- Verify before committing (`node --check` and `bash -n` only parse their first
  argument, hence the loops):
  `bash scripts/strut.sh && for f in scripts/*.mjs; do node --check "$f"; done && for f in scripts/*.sh; do bash -n "$f"; done && claude plugin validate .`
- Commit messages and PRs follow `skills/peacock/references/pr-style.md` — no AI
  attribution anywhere.
