# code-peacock 🦚

**Stop clicking through your own app to check UI changes. Stop babysitting your own PRs.**

Peacock is an install-once, run-anywhere verification skill for **Claude Code** and
**Codex**. It uses each repository's own toolchain instead of assuming a framework.
Point it at a branch (or an existing PR) and walk away: it reviews the code like a
senior dev, writes tests, enforces ruthless clean-code rules, drives a headless browser
through your UI, judges it like a product owner, ships a human-sounding PR — and then
**stays on the PR until it's green**: fixing CI, answering review comments, resolving
threads, rebasing when the base moves, and re-requesting review.

**Peacock never merges.** It reviews and prepares — then stops one click short. Merging
is always a human decision, and no vector (interactive, per-PR CI, or the hosted
autopilot) can make peacock merge on its own. See [Never merges](#peacock-never-merges).

```
    @ . @
  @ \ | / @
   \ \|/ /
    ,(o)>
    // \\
   ^^   ^^
  P E A C O C K — strutting your code. Go touch grass.
```

## What one run does

1. **Struts.** A peacock bounces across your terminal. Non-negotiable.
2. **Understands intent.** Reads the diff, commits, and surrounding code, and writes
   down what you were actually trying to do — then judges everything against that.
3. **Reviews like a senior dev.** Adversarial pass for logic errors, edge cases,
   security, races. Blockers get fixed, not just listed.
4. **Lints ruthlessly.** 40+ clean-code rules stricter than any ESLint config: no dead
   code, no boolean traps (`render(data, true)` — banned), no weird booleans, no magic
   numbers, no speculative abstraction. Violations get fixed.
5. **Proves the code path.** Generates tests that pin down the *intent* (happy path,
   edge cases, failure paths), including behavior-level Playwright/Cypress tests for
   changed UI flows. Then a deterministic runner discovers and executes the project's
   lint, formatting, type, unit, E2E, and build commands across JavaScript/TypeScript,
   Python, Go, Rust, Ruby, and .NET. Every command gets a complete evidence log.
6. **Sees your UI so you don't have to.** Spins up your dev server, drives headless
   Chromium via Playwright, and captures every affected route: desktop + mobile
   full-page screenshots, hover/focus states, scroll-through and flow **videos**,
   before/after against the base branch when feasible.
7. **Audits UX like it means it.** Every capture is reviewed against the
   [Laws of UX](https://lawsofux.com) and a frontend-conventions checklist: does your
   new button match the other 12 buttons in the app? Missing loading/empty/error
   states? Janky motion? 43px touch targets? It shows you, with screenshots.
8. **Judges like a product owner.** Fresh-eyes pass over the captured flows: value,
   copy, friction, what to cut.
9. **Reports evidence, not vibes.** One self-contained HTML file (screenshots and videos
   embedded) with a ship / fix-then-ship / rethink verdict, backed by a machine-readable
   check manifest and per-command logs.
10. **Opens a PR that reads human** — short, concrete, with the screenshots that
    matter. No AI attribution, no boilerplate — **then babysits it to green**: watches
    CI and fixes failures (up to a configurable cap), implements review feedback,
    replies in-thread (`Done in abc1234.` — never "Great catch!"), resolves threads
    only after the fix is pushed, re-requests review, and rebases when the base moves.
    Then it **stops** — green and mergeable, waiting for a human to press Merge.

## Peacock never merges

This is the core guarantee, enforced on every path:

- **It refuses every merge vector** — `gh pr merge`, the REST `pulls/<n>/merge`
  endpoint, the `mergePullRequest` GraphQL mutation, enabling auto-merge, and any
  `git push` to a default/protected branch. Even on green CI, even if told mid-run to
  "just merge it," it declines and explains it's review-only.
- **It only pushes to a PR's own head branch** — never to the base.
- **The hosted autopilot adds a mechanical kill-switch** (`scripts/merge-killswitch.sh`):
  `gh` and `git` PATH shims that block those vectors at the process level, so a bug or a
  prompt-injection can't cause a merge even if the model tried.
- **Branch protection is the mandatory backstop** for the paths the shim doesn't cover
  (per-PR CI and interactive runs) — see [Run it autonomously](#run-it-autonomously-laptop-off).

A human always makes the final merge decision.

## Install — Claude Code

```
/plugin marketplace add RakinAli/code-peacock
/plugin install code-peacock@code-peacock
```

Then, on any branch: `/peacock` — or `/peacock 42` to run everything inside existing
PR #42.

## Install — Codex CLI

```bash
git clone https://github.com/RakinAli/code-peacock ~/code-peacock
bash ~/code-peacock/scripts/install-codex.sh
```

The installer adds a first-class `$peacock` skill and keeps `/peacock` as a compatible
custom prompt. Re-run it after pulling updates. Then use `$peacock` in any repository,
or `/peacock 42` for an existing PR. Headless:

```bash
codex exec --full-auto "$(cat ~/.codex/prompts/peacock.md) -- PR mode on PR #42"
```

## Run it in CI (per PR)

Copy `templates/peacock.yml` to `.github/workflows/peacock.yml` in your project and add
an `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) secret. Every same-repo PR update triggers a
full peacock pass in PR mode; commenting `peacock` on a PR (from an owner/member/
collaborator) re-runs it. Fork PRs are skipped on purpose — they'd otherwise run
untrusted code with your secrets. Reports, captures, videos, accessibility snapshots,
the normalized check manifest, and complete command logs are uploaded as workflow
artifacts. Auth storage is always excluded.

## Run it autonomously (laptop off)

Peacock can review your open PRs hands-free while your machine is off — two ways:

- **On GitHub, on a schedule.** Copy `templates/peacock-scheduled.yml` to
  `.github/workflows/peacock-scheduled.yml`. On a cron (default: every 6h on weekdays)
  it enumerates every open PR against your default branch and runs peacock on each one
  that changed since its last pass — fixing CI, answering comments, keeping it
  mergeable — then stops. Trigger a pass manually from the Actions tab any time.
- **On a VM or cron, anywhere.** `scripts/peacock-autopilot.sh --repo owner/name` clones
  the repo and does the same scan. `--interval <seconds>` polls forever; `--once` runs a
  single pass. It resets to a pristine default-branch checkout each pass, reviews
  same-repo PRs only (never a fork's untrusted head with your credentials), and tracks
  each PR's reviewed head SHA so it doesn't re-review unchanged PRs.

**Required setup for hosted runs:**

- `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` for the Codex variant).
- **A non-admin token.** Give peacock a fine-grained PAT with contents + pull-requests
  write and **no admin** (`PEACOCK_GH_TOKEN` for the workflow, `GH_TOKEN`/`GITHUB_TOKEN`
  for the script). Pushes made with the default `GITHUB_TOKEN` don't re-trigger CI, so a
  PAT is needed for the babysit loop to see green. Non-admin is what keeps the token from
  bypassing branch protection.
- **Branch protection — mandatory backstop.** Protect your default *and* release branches
  (Settings → Branches) to require human approval before any merge. The merge kill-switch
  only guards the autopilot process; a write-scoped token could technically merge on its
  own, so branch protection is what actually guarantees nothing automated ever merges.
  This is required, not optional.

## Configuration (optional)

Commit a `peacock.config.json` at your repo root:

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "devCommand": "npm run dev",
  "checks": {
    "commands": [
      { "name": "contracts", "category": "test", "command": "make contracts" }
    ],
    "skip": []                                                // e.g. ["build"]
  },
  "routes": { "include": ["/pricing"], "exclude": ["/admin"] },
  "login": { "url": "/login" },
  "pr": {
    "maxCiFixAttempts": 5,
    "reviewers": [],                                             // requested on PR creation
    "protectedBranches": ["main", "master", "prod", "production", "release"]
    // peacock never pushes to these and never merges into them — review only.
    // There is deliberately no auto-merge / merge-method option: peacock cannot merge.
  }
}
```

Everything is optional; Peacock detects sensible values when the file is absent. Custom
check commands are additive. Skipped categories remain visible as a coverage choice in
the report.

## Deterministic check evidence

The agent handles judgment-heavy work; `scripts/project-checks.mjs` handles repeatable
execution. From any target repository it discovers the project's configured commands,
runs all of them even when an earlier command fails, and writes:

```text
.peacock/evidence/checks.json
.peacock/evidence/logs/<check>.log
```

The HTML report and CI artifact use those files as the source of truth. Run discovery
without executing commands with:

```bash
node ~/code-peacock/scripts/project-checks.mjs --dry-run
```

Repository-specific commands belong in `peacock.config.json`; Peacock never silently
turns a missing test framework into a passing result.

## Auth for protected pages

Peacock keeps everything it generates in `.peacock/` inside your repo (auto-gitignored).
To let it see logged-in pages, either export `PEACOCK_EMAIL` / `PEACOCK_PASSWORD`, or:

```
# .peacock/auth/.env   (local only, never committed)
PEACOCK_EMAIL=test@example.com
PEACOCK_PASSWORD=hunter2
```

It logs in once, saves the browser session to `.peacock/auth/storage-state.json`, and
reuses it on later runs. Use a test account, not your real one. In interactive runs it
asks once if credentials are missing; headless runs never block — they capture public
pages and report what needs login.

## Requirements

- Node 18+ and `git`
- `gh` CLI authenticated (for the PR phases — everything else works without it)
- Playwright is installed into the target project automatically on first UI run

## Layout

```
.claude-plugin/        plugin + marketplace manifests (Claude Code)
skills/peacock/        THE pipeline (SKILL.md, single source of truth) + rulebooks:
  references/clean-code.md      the ruthless lint rules
  references/laws-of-ux.md      UX laws as review lenses
  references/ui-conventions.md  frontend conventions checklist
  references/pr-style.md        PR bodies, commits, and review replies — human voice
scripts/strut.sh                the mascot
scripts/ui-capture.mjs          Playwright captures (screenshots, states, videos, a11y)
scripts/project-checks.mjs      cross-stack check discovery + durable evidence logs
scripts/inline-assets.mjs       makes the HTML report self-contained
scripts/pr-threads.mjs          list/reply/resolve PR review threads (GraphQL via gh)
scripts/merge-killswitch.sh     gh/git PATH shims that block every merge vector
scripts/peacock-autopilot.sh    hosted, unattended runner — reviews open PRs, never merges
scripts/install-codex.sh        renders the pipeline as a Codex CLI prompt
templates/peacock.yml           GitHub Actions workflow — per-PR headless runs
templates/peacock-scheduled.yml GitHub Actions workflow — scheduled autopilot
tests/project-checks.sh         contract tests for discovery, failures, and evidence
```

## License

MIT
