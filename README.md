# code-peacock 🦚

**Stop clicking through your own app to check UI changes.**

`/peacock` is a Claude Code plugin that takes your branch from "I wrote some code" to
reviewed, tested, linted, UI-audited, reported, and PR'd — autonomously. Run it, walk
away, come back to one HTML report and one PR.

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
2. **Understands intent.** Reads the branch diff, commits, and surrounding code, and
   writes down what you were actually trying to do — then judges everything against that.
3. **Reviews like a senior dev.** Adversarial pass for logic errors, edge cases,
   security, races. Blockers get fixed, not just listed.
4. **Lints ruthlessly.** 40+ clean-code rules stricter than any ESLint config: no dead
   code, no boolean traps (`render(data, true)` — banned), no weird booleans, no magic
   numbers, no speculative abstraction. Violations get fixed.
5. **Writes tests.** Generates tests that pin down the *intent* (happy path, edge cases,
   failure paths), runs them plus your existing suite until green.
6. **Sees your UI so you don't have to.** Spins up your dev server, drives a headless
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
   ship / fix-then-ship / rethink verdict — published as a Claude artifact when available.
10. **Opens a PR that reads human.** Short, concrete, with the 1–3 screenshots that
    matter. No AI attribution, no boilerplate, no robot emoji.

## Install

From GitHub:

```
/plugin marketplace add RakinAli/code-peacock
/plugin install code-peacock@code-peacock
```

Or from a local clone:

```
/plugin marketplace add ~/Documents/GitHub/code-peacock
/plugin install code-peacock@code-peacock
```

## Use

On any branch with changes:

```
/peacock
```

That's it. It runs end to end without questions. The one exception: if an affected page
needs a login and no session/credentials exist yet, it asks once — answer, or ignore it
and it will capture the public pages and list what it couldn't reach.

## Auth for protected pages

Peacock keeps everything it generates in `.peacock/` inside your repo (auto-gitignored).
To let it see logged-in pages, either export `PEACOCK_EMAIL` / `PEACOCK_PASSWORD`, or:

```
# .peacock/auth/.env   (local only, never committed)
PEACOCK_EMAIL=test@example.com
PEACOCK_PASSWORD=hunter2
```

It logs in once, saves the browser session to `.peacock/auth/storage-state.json`, and
reuses it on later runs. Use a test account, not your real one.

## Requirements

- Node 18+ and `git`
- `gh` CLI authenticated (for the PR step — everything else works without it)
- Playwright is installed into the target project automatically on first UI run

## Layout

```
.claude-plugin/       plugin + marketplace manifests
skills/peacock/       the pipeline (SKILL.md) and its rulebooks:
  references/clean-code.md      the ruthless lint rules
  references/laws-of-ux.md      UX laws as review lenses
  references/ui-conventions.md  frontend conventions checklist
  references/pr-style.md        how to write the PR like a human
scripts/strut.sh      the mascot
scripts/ui-capture.mjs      Playwright captures (screenshots, states, videos)
scripts/inline-assets.mjs   makes the HTML report self-contained
```

## License

MIT
