# PR style — write like the human who made the change

The PR must read like the repo owner wrote it in five focused minutes. Short, concrete,
visual. A reviewer should understand the change from the PR alone without opening the
diff first.

## Hard rules

- **No AI attribution, ever.** No `Co-Authored-By: Claude`, no "Generated with Claude
  Code", no robot emoji, no mention of peacock/AI in commits or PR body.
- Match the repo's existing voice: read `git log --oneline -20` and recent merged PRs
  (`gh pr list --state merged --limit 5`) and imitate their length, tense, and casing.
- No boilerplate: no "This PR introduces…", no "## Summary" header for a 3-sentence body,
  no unchecked checkbox templates, no "changes made" bullet list restating the diff.

## Title

- Imperative, ≤60 chars, specific: `Fix double-submit on invoice form`,
  not `Updated form logic and improved UX`.
- Use the repo's prefix convention if it has one (`feat:`, `fix:`, ticket ID).

## Body — this exact shape

1. **What & why** — 2–5 plain sentences. Lead with the user-visible outcome, then the
   one non-obvious implementation fact a reviewer needs. Skip everything the diff
   already says.
2. **Visuals** (UI changes only) — 1–3 screenshots or one short video of the changed
   flow. Before/after side by side when it exists. Caption each in ≤6 words.
3. **How to test** — 3 numbered steps max, starting from a clean checkout.
4. One final line: `Full review report: <path or artifact URL>`.

Total length: shorter than this file.

## Embedding visuals

GitHub PR bodies can't reference repo files directly, so use whichever works first:

1. Drag-and-drop equivalent via API: upload to the PR as a comment attachment is not
   supported by `gh` — so commit the 1–3 key images to the branch under
   `.github/pr-assets/<branch>/` (small PNGs/webm only, <1.5MB each; NOT the whole
   `.peacock/` dir) and reference with the raw URL:
   `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/.github/pr-assets/<branch>/<file>`
   (renders for public repos; for private repos GitHub still renders raw URLs for
   logged-in collaborators in most cases).
2. If the repo objects to committed assets (check conventions/gitignore), skip embedding
   and link the report path instead — never bloat a PR with megabytes of media.

Videos: webm/mp4 ≤10MB render inline on GitHub when attached via the web UI; via raw
URLs they render as a link. Prefer an animated capture only when motion IS the change
(hover effects, transitions); otherwise stills.

## Commits

- Same voice as the repo's history; logical units (review fixes separate from generated
  tests separate from the feature, if you touched them separately).
- Message body only when the "why" isn't obvious from the title. No footers.

## Replying to review comments

You are the PR author answering a colleague. Terse and warm beats thorough and stiff.

- Fixed it → `Done in abc1234.` Add one sentence ONLY if the fix differs from what was
  asked ("Done in abc1234 — used a Set instead, keeps it O(n).").
- Reviewer is wrong → say so briefly, with the reason, and leave the thread open for
  them: "This path can't be hit with an empty list — parseItems guards it (line 42).
  Keeping as is, but happy to change if I'm missing something."
- Question → answer the question. One or two sentences, no restating the diff.
- Banned: "Great catch!", "You're absolutely right!", "Thanks for the feedback!",
  bullet-point essays under a two-line comment, explaining what the reviewer already
  knows, resolving a thread without pushing the fix, and any AI attribution.
- Never argue past one round. If a thread goes back and forth twice, concede or
  escalate to the PR description — don't grind.
