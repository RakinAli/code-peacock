# Peacock clean-code rules

Apply every rule to every changed file. These are stricter than any linter config on
purpose: the target is code with **zero waste** — nothing unused, nothing unclear, nothing
that exists "just in case". When a rule conflicts with the repo's established idiom,
the repo's idiom wins consistency-wise, but flag it once in the report.

Severity: every violation is fix-now unless marked (report-only).

## 1. Dead weight — delete it

- **PCK-D1** No unused variables, imports, parameters, exports, functions, or CSS classes.
- **PCK-D2** No commented-out code. Git remembers; the file doesn't have to.
- **PCK-D3** No unreachable branches, conditions that are always true/false, or
  `if (x) return true; else return false;` (that's `return x`).
- **PCK-D4** No leftover debug output: `console.log`, `print`, `dbg!`, `debugger`.
- **PCK-D5** No speculative code: unused options, "future-proof" parameters, abstractions
  with one implementation. YAGNI. Build it when it's needed.

## 2. Booleans — the weird-boolean rules

- **PCK-B1** No boolean traps: a bare `true`/`false` argument at a call site is banned.
  `render(data, true)` tells the reader nothing. Split the function, use an options
  object, or use a two-value union (`mode: "compact" | "full"`).
- **PCK-B2** No negated names: `isNotReady`, `disableX = false`, `hideY`. Name the
  positive (`isReady`, `enabled`, `visible`) and negate at the use site.
- **PCK-B3** Booleans read as assertions: `is`/`has`/`can`/`should` + noun.
  `open` (boolean or function?) → `isOpen`.
- **PCK-B4** Never compare to boolean literals: `if (x === true)` → `if (x)`.
- **PCK-B5** Two booleans encoding one state (`isLoading` + `isError` both true = ???) →
  one union/enum: `status: "idle" | "loading" | "error" | "success"`. Make impossible
  states unrepresentable.

## 3. Control flow

- **PCK-C1** Guard clauses over nesting. Handle the failure/edge case, return early,
  keep the happy path at indentation level 1. Max nesting depth: 2.
- **PCK-C2** No `else` after a branch that returns/throws/continues.
- **PCK-C3** Exhaustive switches over unions/enums, with a checked `never` default in TS.
- **PCK-C4** One loop, one job. A loop that filters AND transforms AND accumulates three
  things gets split (or expressed as a pipeline).

## 4. Naming

- **PCK-N1** Full words. No `usrCfg`, `tmpArr`, `res2`. Idiomatic exceptions only:
  `i`, `id`, `url`, `db`, `req`/`res` in middleware.
- **PCK-N2** Functions are verbs (`sendInvoice`), values are nouns (`invoice`),
  booleans are assertions (PCK-B3).
- **PCK-N3** No junk-drawer names: `data`, `info`, `item`, `temp`, `misc`, `utils2`,
  `helper`, `manager`, `handleThing2`. If you can't name it, you don't understand it yet.
- **PCK-N4** Same concept, same word, everywhere. Don't alternate `user`/`account`/
  `member` for one thing. (Check the rest of the repo for the established word.)
- **PCK-N5** Names sized to scope: short-lived locals may be short; anything exported
  must be self-explanatory without opening the file.

## 5. Functions

- **PCK-F1** One reason to exist per function. "And" in an honest description of what it
  does means split it.
- **PCK-F2** Soft cap ~30 lines. Over that, justify it (a flat switch/table is fine; a
  40-line braid of concerns is not).
- **PCK-F3** Max 3 positional parameters; beyond that, a named/options object.
- **PCK-F4** No output parameters / mutation of arguments. Return the result.
- **PCK-F5** Query or command, not both: a function either answers a question or changes
  state. `getUserAndMarkSeen()` is two functions.

## 6. Values & constants

- **PCK-V1** No magic numbers or strings. `86400`, `3`, `"pending"` inline → named
  constant at the top of the module (or the repo's constants/tokens module).
- **PCK-V2** Derive, don't sync: never store two representations of the same fact
  (`items` and `itemCount`) that can drift. Compute one from the other.
- **PCK-V3** Prefer `const`/immutability; mutation is opt-in and local.

## 7. Comments

- **PCK-M1** Comments state what the code *cannot*: constraints, invariants, the reason a
  non-obvious approach was chosen, links to specs/tickets. Never narrate the next line.
- **PCK-M2** A comment explaining *what* confusing code does → rewrite the code instead.
- **PCK-M3** No `TODO` without an issue reference. (report-only)

## 8. Duplication & abstraction

- **PCK-A1** Rule of three: extract on the third occurrence, not the second — and never
  merge two things that merely look alike today but change for different reasons.
- **PCK-A2** No wrapper that adds nothing: `function getUser(id) { return repo.getUser(id) }`.
- **PCK-A3** No premature generics/config. A function with 5 flags to serve 2 callers is
  worse than 2 functions.

## 9. Errors

- **PCK-E1** Never swallow: empty `catch`, `catch (e) { console.log(e) }` and carrying on,
  or `.catch(() => {})` are banned. Handle it, translate it, or let it propagate.
- **PCK-E2** Fail loud and early on programmer errors; fail helpfully on user errors
  (message says what happened and what to do).
- **PCK-E3** Error messages carry context: which entity, which id, what was expected.

## 10. TypeScript / typed languages

- **PCK-T1** No `any` (and no `as unknown as X` laundering). Type it or use `unknown` +
  narrowing.
- **PCK-T2** No non-null assertions (`!`) without an adjacent comment proving why it's
  safe — and prefer restructuring so it isn't needed.
- **PCK-T3** Types model the domain (PCK-B5): unions over boolean-flag combinations,
  branded ids where the repo already does that.
- **PCK-T4** `zod`/schema validation at every boundary the repo already validates
  (API input, env, external data). Don't trust the network.

## 11. UI code specifics

- **PCK-U1** Use the repo's design tokens/scale. A one-off `#3b82f6`, `margin: 13px`, or
  `text-[15px]` when a token/scale exists is a violation.
- **PCK-U2** No copy-pasted component variants — extend the existing component's variants.
- **PCK-U3** Every async UI action has loading + error + disabled states (checked again
  visually in Phase 6).
- **PCK-U4** No inline style objects where the repo uses classes/tokens, and vice versa.

## 12. Symmetry

- **PCK-S1** Similar things look similar: parallel branches structured the same way,
  sibling files organized the same way, matching function pairs named as pairs
  (`open`/`close`, not `open`/`shutDown`).
