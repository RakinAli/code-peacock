# Frontend & UX conventions checklist

The Laws of UX say *why*; this file says *what to look for*, capture by capture.
Every finding must point at a screenshot/video and name the convention it breaks.

## Consistency (the #1 job: does new UI match the existing app?)

- **Buttons**: same height, padding, radius, font weight, and color tokens as existing
  variants. A new button style is only acceptable as a deliberate new variant — flag it
  either way and show it next to an existing button.
- **Spacing**: repo's scale (usually 4/8px steps). Odd one-off gaps (13px, 22px) = finding.
- **Typography**: sizes/weights from the existing scale; one h1 per view; consistent line
  height; no faux-bold or new font sizes.
- **Color**: only design tokens. New hardcoded hexes = finding. Semantic colors used
  semantically (red = destructive/error only).
- **Icons**: one icon set, one stroke width, one size grid. Mixed icon families = finding.
- **Radii & shadows**: match the app's established elevation language.
- **Voice**: copy matches the app's tone; consistent capitalization (pick sentence case
  or title case — whichever the app already uses — and stick to it).

## Interactive states (every interactive element needs all that apply)

- **hover** — visible change, cursor: pointer on clickables.
- **focus-visible** — a real focus ring; never `outline: none` without replacement.
- **active/pressed** — momentary feedback on click/tap.
- **disabled** — visually distinct AND explains itself (tooltip/help text nearby).
- **loading** — button shows in-progress and blocks double-submit.
- **selected/current** — nav shows where you are.

## Feedback

- Every user action produces a visible response ≤100ms (even if just a pressed state).
- Async: optimistic UI where safe → skeleton for content loads → spinner only as last
  resort. Never a dead frozen screen.
- Success: confirm it happened (toast/inline/state change) and where the result went.
- Errors: human words, what happened + how to fix, next to where it happened. Never raw
  error codes, never a toast for a field-level problem.
- Destructive actions: undo > confirm dialog. If a dialog, the button says the verb
  ("Delete project", not "OK"/"Are you sure?").

## Forms

- Every input has a visible label (placeholder ≠ label).
- Validation on blur or submit — never on first keystroke; errors clear as fixed.
- Correct input modes/types (email, numeric, autocomplete attributes).
- Primary action enabled state is honest; if disabled, the reason is visible.
- Enter submits single-field forms; focus lands on the first field (or first error).

## Motion & animation

- UI transitions 150–300ms; enter ease-out, exit ease-in. Anything >500ms feels broken.
- Animate transform/opacity, not layout properties (watch the video for jank/repaints).
- Motion has meaning (orientation, causality) — no decoration-only motion on every render.
- `prefers-reduced-motion` respected for anything larger than a fade.
- Nothing that moves under a cursor about to click it (layout shift = finding).

## Scrolling

- No scroll-jacking, no surprise horizontal scroll (check mobile capture edges).
- Sticky headers ≤ ~64px, never covering anchored content.
- Long lists: virtualization or pagination; scroll position restored on back-nav.
- Scrollable regions are visually discoverable (content peeking, not hidden cut).

## Responsive & touch

- Mobile capture: no overflow, no text truncation that hides meaning, no side-by-side
  desktop layouts crushed into columns.
- Touch targets ≥44×44px with ≥8px between adjacent targets.
- Hover-only affordances have a touch equivalent.

## Accessibility floor (visible in captures/DOM snapshot)

- Text contrast ≥4.5:1 (≥3:1 for large text and UI components).
- Interactive elements are real `<button>`/`<a>` (check DOM snapshot), not styled divs.
- Images with meaning have alt text; icon-only buttons have accessible names.
- Focus order follows visual order; keyboard can reach and operate everything captured.
- Color is never the only signal (error = icon/text + color).

## Layout craft

- Alignment: everything lines up with something; check edges in screenshots at 100%.
- One primary action per view; secondary actions visually secondary.
- Empty states: explain + illustrate + one clear CTA. A bare "No data" = finding.
- Loading states reserve space (no cumulative layout shift when content arrives).
- Truncation with intention: ellipsis + tooltip/expansion, never mid-word clipping.
