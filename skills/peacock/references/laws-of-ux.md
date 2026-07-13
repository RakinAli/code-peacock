# Laws of UX — review lenses

Apply each law to the captured screenshots/videos. Cite the law by name in findings.
Each law has a **Check:** — the concrete question to ask of the capture.

## Perception & layout

- **Jakob's Law** — users expect your site to work like every other site they use.
  Check: does anything reinvent a standard pattern (nav placement, cart icon, form flow)
  without a strong reason? Is the new UI consistent with the *rest of this app* (the most
  local form of Jakob's Law)?
- **Law of Proximity** — items near each other are perceived as related.
  Check: is spacing *between* groups larger than spacing *within* them? Do labels sit
  closer to their own field than to the next one?
- **Law of Common Region** — elements inside a shared boundary are perceived as a group.
  Check: do cards/borders/backgrounds group the right things? Anything visually trapped in
  the wrong region?
- **Law of Similarity** — elements that look alike are perceived as functionally alike.
  Check: do all clickable things share a visual language? Does anything non-interactive
  look clickable (or vice versa)?
- **Law of Uniform Connectedness** — connected elements (lines, arrows) read as related.
  Check: steppers, wizards, timelines — do the connections match the actual flow?
- **Law of Prägnanz** — people interpret ambiguous images in the simplest form possible.
  Check: can the layout be simplified without losing meaning? Is anything visually busy
  for no reason?
- **Serial Position Effect** — first and last items are remembered best.
  Check: are the most important nav items / actions first or last, not buried mid-list?
- **Von Restorff Effect** — the one different item is the one remembered.
  Check: does exactly ONE element per view stand out (the primary action)? If two things
  compete for attention, neither wins.

## Decision & effort

- **Hick's Law** — decision time grows with number and complexity of choices.
  Check: how many choices does the new view present at once? Can options be grouped,
  defaulted, or progressive-disclosed?
- **Fitts's Law** — time to acquire a target = distance / size.
  Check: are primary actions big and near where the user's pointer/thumb already is?
  Touch targets ≥44×44px? Tiny close buttons, thin sliders, edge-hugging links = findings.
- **Miller's Law** — working memory holds 7±2 chunks.
  Check: long unchunked lists, forms, or nav? Chunk into groups.
- **Tesler's Law** — complexity is conserved; someone pays for it.
  Check: does the UI push complexity onto the user (manual steps, codes to copy, decisions
  the system could make) that the code could absorb?
- **Occam's Razor** — the simplest design that works.
  Check: any element that can be removed with no loss? Remove it.
- **Paradox of the Active User** — nobody reads manuals or onboarding text.
  Check: does the feature work for someone who ignores every explainer? Are empty states
  self-explanatory with a clear next action?

## Time & feedback

- **Doherty Threshold** — keep response under ~400ms to hold attention.
  Check: in the videos, does anything block silently? Every action >400ms needs immediate
  feedback (optimistic update, skeleton, spinner — in that order of preference).
- **Zeigarnik Effect** — people remember incomplete tasks.
  Check: do multi-step flows show progress and remain resumable?
- **Goal-Gradient Effect** — motivation increases near completion.
  Check: progress indicators start non-zero and show remaining effort shrinking?
- **Peak-End Rule** — experiences are judged by peak moment and ending.
  Check: what's the emotional peak and the ending of this flow? A success state that just
  ends with silence, or an error at the end, poisons the whole flow. Endings deserve
  polish (confirmation, next step, small delight).
- **Aesthetic-Usability Effect** — beautiful things are perceived as more usable.
  Check: rough visual craft (misalignment, inconsistent spacing, default-looking
  elements) will make users *believe* the product works worse. Polish is functional.

## Overall

- **Pareto Principle** — 80% of use hits 20% of features.
  Check: is the common path the fastest, most polished one? Are rare options demoted?
