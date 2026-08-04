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

## 13. Modules & files

- **PCK-MOD1** One file, one responsibility, named after it. Soft cap ~400 lines; past
  that, split by responsibility (not by line count) — sub-components to sibling files,
  hooks/helpers to their own module. Applies to files this branch creates or substantially
  rewrites; a long file you merely opened is not this branch's problem. (report-only on
  pre-existing files)
- **PCK-MOD2** A module's exports are its API. Export what callers actually import today;
  everything else stays private. An export with no consumer is dead code (PCK-D1).
- **PCK-MOD3** Imports point one way. Lower layers never import higher ones — a data
  module never imports a service, a service never imports a controller/route/component.
  An import cycle is a design error, not a bundler warning.
- **PCK-MOD4** No reaching around a layer: route handlers don't run queries inline, data
  modules don't decide permissions, UI components don't hand-roll transport. Each layer
  talks to the one below it.
- **PCK-MOD5** No barrel file whose only job is shortening an import path. It hides the
  dependency graph and drags unrelated modules into every bundle. (report-only)

## 14. Boundaries & I/O

- **PCK-IO1** Validate at the boundary, once — then everything inside is typed and
  trusted. Re-validating the same value three layers deep means the boundary isn't
  trusted; fix the boundary (schema rules live in PCK-T4).
- **PCK-IO2** Never call your own service over HTTP from inside itself. `fetch("/api/x")`
  server-side is a function call with extra latency, extra auth, and extra failure modes.
- **PCK-IO3** Every outbound call has a timeout and a defined failure path. "It normally
  responds fast" is not a timeout.
- **PCK-IO4** Every query is parameterized — SQL, shell, HTML, template. String-concatenated
  input is a defect, never a style preference.
- **PCK-IO5** Reads don't write and writes aren't disguised as reads. A `get*` that mutates,
  or a mutation exposed as a query, is a correctness bug waiting for a retry (see PCK-F5).
- **PCK-IO6** Retries are bounded, backed off, and only on idempotent operations. An
  unbounded retry loop is an outage amplifier.

## 15. Async & concurrency

- **PCK-AS1** No floating promises. Every async call is awaited, returned, or handed to
  something that reports its failure. Fire-and-forget is a decision that needs a comment.
- **PCK-AS2** Independent work that runs sequentially in a loop should run together — with
  a bound. An unbounded `Promise.all` over user-sized input is a load test aimed at your
  own dependencies.
- **PCK-AS3** Cleanup is part of the happy path: listeners removed, timers cleared, object
  URLs revoked, streams closed, aborts propagated. Every subscription has a matching
  teardown in the same file.
- **PCK-AS4** Nothing runs on a timer the code can't stop, and nothing schedules work that
  outlives the thing that asked for it.
- **PCK-AS5** No sleep-based synchronization. Waiting 500ms and hoping is not waiting for a
  condition — wait for the condition.
- **PCK-AS6** Shared mutable state crossing an `await` needs a stated invariant. If two
  concurrent calls can interleave there, say why that's safe.

## 16. Secrets & sensitive data

- **PCK-SEC1** No secret in source, in a committed config, in a log line, in an error
  message, or in a test fixture. Not even a "temporary" one — git remembers.
- **PCK-SEC2** Never echo back a credential a human just typed, and never write one outside
  the one place the project keeps them. Prompt, store, use — don't reprint.
- **PCK-SEC3** Least privilege by default. Never widen an authorization check, broaden a
  token scope, or relax a permission as a side effect of an unrelated change.
- **PCK-SEC4** Log identifiers, not payloads: a user id, not the user record; a request id,
  not the request body. Anything that could carry personal data stays out of logs.
- **PCK-SEC5** A file that holds credentials is created private (0600) and ignored by
  version control in the same change that creates it — never in a follow-up.

## 17. Observability

- **PCK-OB1** One logger, structured, with context (`logger.error(message, { runId, userId })`).
  Bare prints are for debugging and don't survive review (PCK-D4).
- **PCK-OB2** Log where you have the context, once. The same failure logged at four layers
  is four times the noise and none of the signal.
- **PCK-OB3** An error you handle must still be *visible* — a returned error, a metric, a
  user-facing message. Handling is not hiding (PCK-E1).
- **PCK-OB4** Messages a human reads say what happened and what to do next; codes a machine
  reads stay stable across releases. Don't swap one for the other.

## 18. User-facing text

- **PCK-X1** No user-facing string hard-coded in a component when the project has a
  translation layer. Add the key to the source-of-truth locale first, then the rest.
- **PCK-X2** Never assemble a sentence by concatenating fragments — word order isn't
  universal. Interpolate into one whole message.
- **PCK-X3** Dates, numbers, currency, and pluralization go through the locale-aware helper
  the project already uses. Hand-rolled formatting is a bug in someone else's locale.
- **PCK-X4** Copy is written for the person reading it: no internal jargon, no raw error
  codes, no "Are you sure?" where the verb would do (see ui-conventions.md).

## 19. Tests

- **PCK-TS1** A bug fix ships with a test that fails without the fix. If the test passes
  before your change, it doesn't test your change.
- **PCK-TS2** Tests are named after behavior ("rejects an expired token"), never after the
  method under test ("test handleSubmit 2").
- **PCK-TS3** Every test asserts something that would break if the feature were deleted.
  A test that only proves "nothing threw" is a smoke test — label it as one.
- **PCK-TS4** Tests wait for conditions, never for durations (PCK-AS5). Sleeps are how a
  suite becomes flaky.
- **PCK-TS5** Never weaken an assertion, add a retry, or skip a test to make a suite green.
  Fix the code or report the failure honestly.
- **PCK-TS6** Fixtures say what matters: name the one field the test is about, default the
  rest. A 40-line literal hides which value drives the assertion.
