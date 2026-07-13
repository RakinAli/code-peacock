# code-peacock 🦚

**Stop clicking through your own app to check UI changes. Stop babysitting your own PRs.**

Peacock is an autonomous review pipeline that runs on **Claude Code** or **Codex CLI**.
Point it at a branch (or an existing PR) and walk away: it reviews the code like a
senior dev, writes tests, enforces ruthless clean-code rules, drives a headless browser
through your UI, judges it like a product owner, ships a human-sounding PR — and then
**stays on the PR until it's green**: fixing CI, answering review comments, resolving
threads, and (if you let it) merging.

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
5. **Writes tests.** Generates tests that pin down the *intent* (happy path, edge
   cases, failure paths), runs them plus your existing suite until green.
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
9. **Reports.** One self-contained HTML file (screenshots and videos embedded) with a
   ship / fix-then-ship / rethink verdict.
10. **Opens a PR that reads human** — short, concrete, with the screenshots that
    matter. No AI attribution, no boilerplate — **then babysits it to green**: watches
    CI and fixes failures (up to a configurable cap), implements review feedback,
    replies in-thread (`Done in abc1234.` — never "Great catch!"), resolves threads
    only after the fix is pushed, re-requests review, rebases when the base moves, and
    enables auto-merge if configured.

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

Then inside `codex`: `/peacock` (same modes). Re-run the installer after pulling
updates. Headless:

```bash
codex exec --full-auto "$(cat ~/.codex/prompts/peacock.md) -- PR mode on PR #42"
```

## Run it in CI (fully human-free)

Copy `templates/peacock.yml` to `.github/workflows/peacock.yml` in your project and add
an `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) secret. Every PR update triggers a full
peacock pass in PR mode; commenting `peacock` on a PR re-runs it. Reports and captures
are uploaded as workflow artifacts.

## Configuration (optional)

Commit a `peacock.config.json` at your repo root:

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "devCommand": "npm run dev",
  "routes": { "include": ["/pricing"], "exclude": ["/admin"] },
  "login": { "url": "/login" },
  "pr": {
    "autoMerge": false,          // true = merge on green with all threads resolved
    "mergeMethod": "squash",
    "maxCiFixAttempts": 5,
    "reviewers": []
  }
}
```

Everything is optional; peacock detects sensible values when the file is absent.

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
scripts/strut.sh            the mascot
scripts/ui-capture.mjs      Playwright captures (screenshots, states, videos, a11y)
scripts/inline-assets.mjs   makes the HTML report self-contained
scripts/pr-threads.mjs      list/reply/resolve PR review threads (GraphQL via gh)
scripts/install-codex.sh    renders the pipeline as a Codex CLI prompt
templates/peacock.yml       GitHub Actions workflow for headless runs
```

## License

MIT
