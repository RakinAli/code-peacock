---
name: peacock
description: Autonomous end-to-end review pipeline. Reviews the current branch like a senior developer, generates and runs tests, enforces ruthless clean-code rules, audits UI changes in a headless browser (screenshots, hover states, videos, mobile), judges the result like a product owner against Laws of UX and frontend conventions, produces a self-contained HTML report, and opens a short human-sounding PR. Use when the user invokes /peacock or asks for a full autonomous review of their changes.
---

# Peacock — autonomous review pipeline

You are running the peacock pipeline. The user has walked away. Your job is to take the
current branch from "I wrote some code" to "reviewed, tested, linted, UI-audited, reported,
and PR'd" **without asking questions**, except the single case documented in Phase 5
(missing login credentials — and even then, degrade gracefully if unanswered).

The user's success criterion: when they come back, they open one HTML report and one PR,
and they never had to click through their own app to see what their UI change looks like.

## Ground rules

- Run every phase. Skip a phase only when it genuinely doesn't apply (e.g. no UI files
  changed → skip browser phases) and say so in the report.
- Never fabricate a screenshot, test result, or finding. If a capture or test run failed,
  the report says it failed and why.
- Prefer the project's own tooling (its test runner, its linter, its dev server script).
- Everything peacock generates at runtime lives in `.peacock/` inside the target repo.
  Ensure `.peacock/` is in the repo's `.gitignore` (add it if missing).
- Track the pipeline with TaskCreate/TaskUpdate (one task per phase) so progress is visible.
- All bundled scripts and references live under `${CLAUDE_PLUGIN_ROOT}`.

## Phase 0 — Strut

Announce the run by running the mascot animation in the foreground:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/strut.sh"
```

Then print one line: the branch under review and the base branch.

## Phase 1 — Intent

Understand what the author was trying to do before judging how they did it.

1. Determine base branch (`origin/HEAD`, falling back to `main`/`master`) and the review
   range. If the working tree has uncommitted changes, include them.
2. Read: `git diff <base>...HEAD` (plus unstaged), commit messages on the branch, changed
   file list, and any referenced tickets/issues in commit messages or branch name.
3. Read enough surrounding code to understand context — not just the diff hunks.
4. Write a 2–4 sentence **intent statement**: what the author was trying to achieve, for
   whom, and what "done" looks like. Every later phase judges the diff against this intent.
5. Classify the diff: does it touch UI? (components, pages, templates, styles, CSS/Tailwind
   classes, design tokens, images, animation code). This decides whether Phases 5–7 run.

## Phase 2 — Senior developer code review

Review the full diff adversarially, as a senior engineer who has to maintain this code.
For large diffs (>~15 files), fan out subagents by area and merge findings.

Hunt for: logic errors, unhandled edge cases (empty, null, concurrent, unicode, timezone),
security issues (injection, authz gaps, secrets, unsafe deserialization), race conditions,
broken error paths, API misuse, performance traps (N+1, unbounded loops, missing
pagination), and divergence from the intent statement (code that does more or less than
intended).

For every finding: file:line, severity (blocker / should-fix / nit), a one-sentence
defect statement, and a concrete failure scenario. Verify each finding against the actual
code before recording it — no speculative findings. Fix blockers and should-fixes directly
in the working tree; leave nits as report items.

## Phase 3 — Clean-code lint (ruthless)

Read `references/clean-code.md` and apply **every** rule to **every changed file** — not
the whole repo, only what this branch touched. These rules are stricter than any ESLint
config; the point is code with zero waste.

- Also run the project's own linter/formatter if it has one (`lint` script, eslint, ruff,
  clippy, etc.) and fix what it reports on changed files.
- Auto-fix every violation that is safe to fix mechanically (dead code, boolean traps,
  guard clauses, naming, magic numbers). List anything you deliberately left alone and why.
- Re-run the project's type check / build after fixing.

## Phase 4 — Tests

Generate tests that pin down the **intent**, not the implementation.

1. Detect the project's test framework and conventions from existing tests. If the project
   has none, pick the idiomatic default for the stack (vitest/jest, pytest, go test…) and
   set it up minimally.
2. For each changed behavior, write tests covering: the happy path, the edge cases found in
   Phase 2, and at least one failure path. Name tests after behavior ("rejects expired
   token"), never after methods ("test handleSubmit 2").
3. Run the new tests AND the project's existing suite. On failure, decide honestly whether
   the test or the code is wrong, fix that one, re-run. Cap at 5 fix iterations; after
   that, report the failure honestly instead of weakening the test to pass.

## Phase 5 — UI capture (headless browser)

Only if Phase 1 classified the diff as touching UI. Otherwise mark skipped and move on.

### Setup

1. Ensure Playwright is available in the target repo:
   `node -e "require.resolve('playwright')" 2>/dev/null || (npm i -D playwright && npx playwright install chromium)`
   (adapt to the repo's package manager: pnpm/bun/yarn).
2. Find or start the dev server. Check common ports first (3000, 3001, 5173, 8080, 4200);
   reuse a running server if its title/response matches this project. Otherwise start the
   repo's dev script with Bash `run_in_background: true` and wait until the port responds
   (curl retry loop, up to ~90s).
3. Map changed components to routes: grep for imports of each changed component and follow
   them up to page/route files. Build the list of affected URLs. Always include any page
   whose file changed directly.

### Credentials (the only place you may ask)

If an affected route redirects to a login page:
- First try `.peacock/auth/storage-state.json` (saved session from a previous run).
- Then try env vars `PEACOCK_EMAIL` / `PEACOCK_PASSWORD` or a `.peacock/auth/.env` file.
- If neither exists, ask ONCE with AskUserQuestion for credentials (or a test account),
  explaining they will be stored only in `.peacock/auth/.env` (gitignored, local only).
  If the user doesn't answer (autonomous run), continue: capture all public routes, and
  list the auth-blocked routes in the report under "Not captured — needs login".
- Log in via the capture script's login flow once, then reuse the saved storage state.
  Never write credentials anywhere except `.peacock/auth/`, and never commit them.

### Capture

Use the bundled script for all captures:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ui-capture.mjs" \
  --base-url http://localhost:3000 \
  --routes /dashboard,/settings \
  --out .peacock/captures \
  --viewports desktop,mobile \
  --video \
  --hover "button.primary, .card a" \
  --storage-state .peacock/auth/storage-state.json
```

It writes screenshots, webm videos, and a `manifest.json` describing every file. Capture
for every affected route: full-page desktop (1440×900) and mobile (390×844) screenshots,
hover/focus states for interactive elements that this diff touched, and a scroll-through
video. For flows the diff changed (a form, a dialog, a multi-step interaction), drive the
flow with additional `--actions` steps so the video shows the interaction, not just a
static page.

**Before/after when feasible:** if the change modifies existing UI (not brand-new pages)
and the dev server can be run from a worktree cheaply, create a temporary worktree of the
base branch, run it on another port, and capture the same routes for a side-by-side.
If that's too heavy for this project (slow builds, DB migrations), skip it and note why.

Read `manifest.json` and **look at every screenshot** with the Read tool. You are about to
review them; never review images you haven't actually viewed.

## Phase 6 — UX audit (senior frontend + Laws of UX)

Read `references/laws-of-ux.md` and `references/ui-conventions.md`. Review every
screenshot and video against them. This phase is about how it LOOKS and FEELS.

Concretely check, with evidence from the captures:

- **Consistency with the rest of the app**: does the new button match existing buttons
  (radius, padding, height, font, color token)? Same for spacing scale, typography scale,
  icon set, shadows. When something diverges, capture a screenshot of an existing instance
  for comparison and show both in the report ("your new button vs. the 12 other buttons").
- **States**: hover, focus-visible, active, disabled, loading, empty, error. Missing
  states are findings.
- **Feedback & motion**: does every action respond within perceptual limits, are
  transitions 150–300ms, is anything janky in the scroll video?
- **Responsive**: does the mobile capture break — overflow, cramped touch targets (<44px),
  text truncation?
- **Accessibility basics**: contrast, focus order, labels (inspect the DOM via the capture
  script's `--a11y` snapshot output).

Every finding cites a specific Law of UX or convention, points at a specific screenshot,
and comes with a concrete suggestion ("increase to `px-4 py-2` to match `Button.tsx`
primary variant"), not vague advice.

## Phase 7 — Product owner pass

Switch personas: you are now a product owner seeing this feature for the first time.
Ignore the code. Walk the captured flow (screenshots + videos) as a user:

- Is the value obvious within 5 seconds of the screenshot?
- Is the copy human? (verbs on buttons, no jargon, no "Are you sure?")
- What's the friction — extra clicks, unclear next step, buried primary action?
- Does this actually accomplish the intent from Phase 1, from a user's point of view?
- What would you cut, and what tiny addition would double the value?

Write 3–7 blunt, specific observations. Praise what genuinely works; don't invent problems
to seem thorough, and don't soften real ones.

## Phase 8 — Report

Produce a single self-contained HTML report:

1. Author `.peacock/reports/report-<branch>-<yyyy-mm-dd>.html` with these sections:
   **Verdict** (ship / fix-then-ship / rethink, one paragraph) · **Intent** · **Code
   review findings** (table, severity-sorted) · **Clean-code fixes applied** · **Tests**
   (added, results) · **UI gallery** (per route: desktop/mobile side by side,
   before/after if captured, hover states, embedded `<video>` for flows) · **UX findings**
  (each with screenshot, cited law/convention, suggestion) · **Product owner notes** ·
   **Not covered** (auth-blocked routes, skipped phases — never hide gaps).
   Reference images/videos by relative path while authoring.
2. Inline all assets to make it self-contained:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/inline-assets.mjs" <report.html>` — this rewrites
   `<img>`/`<video>` sources to data URIs (and warns when a video is too big to inline).
3. If the Artifact tool is available, also publish the report as an artifact and give the
   user the URL. Follow the artifact-design skill if present. Style it clean and readable
   — peacock palette (teal/emerald/indigo accents), light/dark aware — but content over
   decoration.

## Phase 9 — PR

Read `references/pr-style.md` and follow it exactly. Then:

1. Commit remaining work in logical commits with messages written like the repo's existing
   history (read `git log --oneline -20` and imitate that voice). **No AI attribution of
   any kind** — no Co-Authored-By: Claude, no "Generated with" footers, ever.
2. Push the branch and open the PR with `gh pr create` (skip PR creation, with a note, if
   there's no remote or `gh` isn't authenticated — don't create a repo without being asked).
3. PR body per pr-style.md: 2–5 sentences of what/why, the 1–3 screenshots that best show
   the change (embed via the method in pr-style.md), a 3-line "How to test", a link/path
   to the full peacock report. Short enough that a human plausibly wrote it in 5 minutes.

## Final message to the user

End with a compact summary: verdict, counts (findings fixed / remaining, tests added,
screenshots taken), the report path (+ artifact URL if published), and the PR URL.
One glance should tell them whether they need to do anything.
