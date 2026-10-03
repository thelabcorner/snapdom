# R10-ANIM1 — resolve the document-wide `hasAnimations` veto per consumer

Re-audit of the prior R9 custom-property lane finding: `scanAuthorStyles` collapses the whole
document's live animations into one boolean, and every style gate inherits it. Line numbers below are
from this worktree's exact base and are stated with the symbol, not as authority.

Base: `c523ddb6e141846d55af1c8f315f65babbc32a7e`.

---

## 1. The finding, re-verified

Producer: `scanAuthorStyles` (styleScan.js).

```js
const animations = doc.getAnimations()
state.hasAnimations = animations.length > 0
```

`Document.getAnimations()` is document-wide. One running animation anywhere in the document sets one
boolean that every consumer reads as "be conservative everywhere". The finding is confirmed, and it is
worse than "one gate": six separate gates inherit it.

The codebase already knows the scoped form. `capture.js` and `burst.js` both call
`getAnimations({ subtree: true })` on a specific root. Only `scanAuthorStyles` asks document-wide,
because it needs a *document*-level answer for a *document*-level artifact — and then hands that
artifact to consumers whose questions are all local.

## 2. Consumer enumeration

Seven animation-sensitive sites exist in `src/`. Two were already scoped and are untouched:

| # | Site | Question it asks | Already scoped? |
|---|------|------------------|-----------------|
| — | `capture.js` `__styleShare` | "any animation under the capture root?" | yes — `getAnimations({subtree:true})` |
| — | `burst.js` `animationsInScopes` | "did the render state move under my scopes?" | yes — per tracked scope |
| A | `styleScan.js` `scanAuthorStyles` | producer | n/a |
| B | `backgroundFontSensitiveFor` | can a font epoch invalidate a stored background snapshot? | no |
| C | `needsTextTruncationPrepass` | can any truncation appear in this subtree? | no |
| D | `elementUniverseFor` | is R3's narrowed property universe exact here? | no |
| E | `canSkipBackgroundInlineStateProbe` | is this element's inline background state empty? | no |
| F | `maskLayoutInitialValues` | is this element's mask layout at initial values? | no |
| G | auto-margin Typed-OM probe | can this element's margin be `auto`? | no |

## 3. The two facts the whole lane rests on

**F1 — an animation acts at exactly one element.** A CSS animation, transition or WAAPI animation has
one `KeyframeEffect` with one `target`, and participates in the cascade at that target only. It cannot
move another element's computed style. `pseudoElement` needs no special case: a pseudo animation's
`effect.target` is its originating element, so `::before`/`::first-letter` targets land on the host,
which is the conservative direction for every consumer here.

**F2 — inheritance is the only cross-element channel.** An animation on an ancestor changes that
ancestor's computed value of an *inherited* property, and descendants inherit the result. Registered
custom properties (`@property`) are inherited, so the same arm covers them — which is why the prior
lane's finding surfaced under custom properties in the first place.

F1 + F2 give every consumer a *local* scope: **the element, plus its ancestors for consumers that read
inherited values.** A sibling, a cousin, or an element in another subtree is unreachable.

## 4. Consumer-specific scope, and why each one differs

The scope is not one number. It is set by *which properties the consumer reads*:

| # | Consumer | Reads | Scope | Why not wider |
|---|----------|-------|-------|---------------|
| D | `elementUniverseFor` | every computed property | element **+ ancestors** | F2: inherited values (incl. registered custom properties) arrive from ancestors. A sibling cannot change this element's computed style at all. |
| C | `needsTextTruncationPrepass` | a whole subtree | **subtree(root) + ancestors(root)** | the pass is subtree-wide; `text-overflow` is inherited and `display` can be stepped discretely, so an ancestor of a node in the subtree counts. A sibling outside the subtree cannot truncate anything in it. |
| E | `canSkipBackgroundInlineStateProbe` | own background/mask/border-image | **element** | none of those inherit; an ancestor's animated background cannot appear here. |
| F | `maskLayoutInitialValues` | own mask longhands | **element** | every mask longhand is non-inherited. |
| G | auto-margin probe | own margin longhands | **element** | margin does not inherit. |
| B | `backgroundFontSensitiveFor` | own background layout | **deferred — document-wide** | see §5. |

### 4.1 Why D's contract is exactly "element + ancestors"

`snapshotComputedStyleFull` reads the returned set and drops any property whose value is `''`
(`addProp` returns early on falsy). So narrowing is exact iff **every property outside the returned set
computes to `''` on this element.** R3's construction (MUST set, declared∩inherited, always-props,
measured UA defaults, inline props, matched rules via live `el.matches`, universe peers) is built to
establish that from static sources.

The only thing that can break it is a source that moves a property off its default *without appearing
in the static rule set*. Animations are exactly that, and by F1+F2 they can only do so from the
element itself or from an ancestor. Hence the scope, and hence the narrowing is exact by construction
rather than by measurement.

Two details worth recording:

- **Rule selection is already live.** `applyRule` calls `el.matches(rule.sel)` at snapshot time, so a
  container query or a state pseudo-class that an ancestor's animation changes is re-evaluated, not
  baked in. The narrowing selects *which properties to read*; it never decides which rules match.
- **UA-default measurement is animation-isolated.** `measureElementTagDefaults` /
  `measureAncestorTagDefaults` build a fresh `all:initial` probe inside an off-screen box, so the
  veto does not need to be ordered against them.

### 4.2 Why G is a strict no-op when scoped

The probe rewrites `snap[prop]` **and** sets `restoredAutoMargin`, which is what pushes to `dyn`. It
only does either when Typed OM actually returns `'auto'`. If no animation targets the element, the
remaining sources (`marginMayBeAuto` from the rule walk, `UA_AUTO_MARGIN_TAGS`,
`hasPresentationalAutoMargin`, inline `auto`/`all`) are exactly the historical enumeration, so Typed OM
cannot return `'auto'` and `break` is unobservable. G's proof is therefore no weaker than the
`marginMayBeAuto` contract the lane already relies on — and it is marked conditional on that contract
rather than claimed independent of it.

## 5. Consumer B, deliberately not scoped

`backgroundFontSensitiveFor` is left reading the document-wide boolean, with the reason recorded in
the code at the call site so the omission cannot read as an oversight:

- It answers "can a **font epoch** invalidate a stored background snapshot", which is only consulted on
  the rare font-completion path (`backgroundSnapshotIsCurrent`).
- **No options object exists anywhere in its call chain.** Reaching one means threading options
  through `background.js` → `backgroundSnapshotFor` → `backgroundSnapshotIsCurrent`, for a gate whose
  own document-wide `scan.backgroundFontSensitive` term already vetoes every page that authors a
  font-metric-dependent background.

So scoping its animation term could only help pages that animate something **and** author no
font-sensitive background **and** cross a font epoch. Deferred rather than paid for.

## 6. Mechanism

At scan time, from the **same** `doc.getAnimations()` call whose keyframes already become the
document universe, build an index:

```
targets   Set<Element>   the animation's own target element (host, for pseudo targets)
ancestors Set<Element>   closure of every target's ancestors (exclusive)
unresolvable boolean     an animation could not be attributed
```

`ancestors` is built with a monotone walk that stops at the first node already present — the first
target contributes the whole chain to the root, so every later walk stops where the closure already
covers it. Cost is O(animations × depth) **once per scan**, not per element.

Per-element questions are then two `Set.has` calls. Three scope constants select the arm
(`ANIM_SCOPE_SELF`, `ANIM_SCOPE_SELF_OR_ANCESTOR`, `ANIM_SCOPE_SUBTREE`).

`unresolvable` fails closed: a null effect, a non-element target, or a target rooted outside the
document (shadow content, foreign document) cannot be placed in either set, so it blocks exactly as
`hasAnimations` does today. An **unreliable scan** carries `UNRESOLVED_ANIMATION_SCOPE` rather than
`null` for the same reason — `null` would read as "no animation in scope" and silently *release* the
gates the unreliable record exists to close.

Cost when the document has **no** animation: unchanged. `animationBlocks` returns on
`!scan.hasAnimations`, which is the same property read the historical condition already performed.

Counterfactual: `__animationScope: false` restores the document-wide veto mechanism for mechanism.
That is what both the parity fixtures and the hosted A/B arm against.

## 7. Amdahl ceiling

The lane's claim is about **work**, not wall-clock, so the ceiling is computed from counters, hosted,
and is an upper bound on any time ceiling:

```
f          = (CSSOM crossings forced by the veto) / (CSSOM crossings actually performed)
ceiling    = 1 / (1 - f)          speedup if the veto cost were removed entirely
```

`f` is read directly off the two arms: `f = (gpv_historical - gpv_candidate) / gpv_historical` on a
sibling-animation fixture. This is deliberately *not* claimed as a speedup. The timing claim, if one
is ever wanted, needs the R9 timing protocol on a candidate that actually places an animation — the
standing suite cannot see this lane's opportunity at all (§9).

## 8. Counters

Two independent sources that must agree:

1. **Out-of-band** — a `CSSStyleDeclaration.prototype.getPropertyValue` patch in the probe. It sits
   outside snapdom and cannot be influenced by the lane's own bookkeeping, so it is the check on the
   internal number.
2. **Internal** — `options.__animationScopeCounters`, a caller-supplied sink absent in production:

| Key | Meaning |
|-----|---------|
| `elementUniverse` | `{blocked, released}` — D's veto decisions per element |
| `backgroundStateProbe` | `{blocked, released}` — E |
| `maskLayoutInitials` | `{blocked, released}` — F |
| `autoMarginProbe` | `{blocked, released}` — G |
| `textTruncationPrepass` | `{blocked, released}` — C, once per capture |
| `reads` | CSSOM crossings inside `snapshotComputedStyleFull`, counted **at the crossing** |
| `index` | `{animations, targets, ancestors, unresolvable}` — the scan-time index, once |

`reads` is counted immediately before `style.getPropertyValue(prop)`, not per iteration, so it is the
work the ceiling is computed from rather than a proxy for it.

## 9. Falsifiers

A falsifier is a fixture that must show **zero** read reduction. If it saves reads, the scope released
a veto it was required to keep, and that is a red build — not a win.

| Falsifier | Kills |
|-----------|-------|
| `anim-ancestor-60` (ancestor animates inherited `color`) | a scope of "element only" — the classic over-narrowing bug. This is the fixture the lane exists to survive. |
| `anim-ancestor-customprop-60` (ancestor animates an inherited `@property` custom property) | the same bug reached through the registered-custom-property channel the prior lane found |
| `anim-ancestor-noninherited-60` (ancestor animates `padding-left`) | over-eager ancestor veto inflation (must still be exact; may still save nothing) |
| `anim-self-60` (the captured root is animated) | forgetting the element's own target |
| `anim-subtree-60` (a descendant is animated) | subtree confusion in C |
| `anim-shadow-60` (animation inside a shadow root) | `unresolvable` not failing closed |
| `anim-none-60` (no animation) | any cost added to the animation-free hot path |

Supporting exactness fixtures in `__tests__/module.styles.animationScope.test.js` cover pseudo-element
targets, slotted nodes, cancelled animations, backgrounds/masks/borders, auto margins, a UA-centered
`<dialog>`, pseudo-element emission, and the identity-share path.

**Fixture determinism.** Every fixture freezes its animation (`pause()` + `currentTime = 0`). Paused
animations are still returned by `getAnimations()`, so the veto is exercised identically — and because
an animated computed value changes with the clock, freezing is what makes exact-raw-parity a real
assertion. Comparing two arms microseconds apart would race the animation, and any difference would say
nothing about this lane.

## 10. Hosted matrix

`.github/workflows/r10-animation-scope.yml`, GitHub-hosted only. The probe calls
`assertHostedBrowser()` and exits non-zero off a runner, and the workflow re-checks
`GITHUB_ACTIONS` before doing anything. No local timing, and no timing at all: counts are exact, so
there is no ambient-CPU gate, warmup schedule or bootstrap adjudication.

| Job | Engines | Gate |
|-----|---------|------|
| `logic` | none (Node only) | the copied algorithm still matches the shipped source; 1200 randomized closure cases equal brute force; scope-arm and fail-closed invariants hold |
| `probe` | chromium, firefox, webkit | exact raw parity per fixture; falsifiers/controls save exactly 0; opportunities save > 0; hosted provenance present; engine identity matches; compiled bundle hash matches across engines |
| `parity` | all three | same bundle hash; same role classification per fixture on every engine; parity holds on every engine; falsifier-zero invariant holds on every engine |

`logic` exists because the load-bearing piece of the lane is small and sharp: the ancestor closure
uses a `break` as soon as it meets a node already in the set, and that shortcut is sound only because
the closure is monotone. If it ever stopped being monotone, a deep tree would produce a short
`ancestors` set and every `ANIM_SCOPE_SELF_OR_ANCESTOR` answer would be wrong **in the unsafe
direction**. That is a data-structure claim about a few Set operations, so
`check-r10-anim-scope-algorithm.mjs` verifies it in milliseconds with no browser, against a mock DOM,
with the algorithm copied verbatim — and it asserts the copy still matches `styleScan.js`, so the two
cannot silently drift. The three-engine probe then confirms the same invariant in real engines.

Absolute saved counts may differ per engine — their CSSOM enumerates different property sets. The
**sign** is the invariant, and that is what the aggregate job checks.

Fixtures (10): `anim-sibling-60`, `anim-sibling-entropy-120`, `anim-sibling-inherited-60` ·
`anim-ancestor-60`, `anim-ancestor-customprop-60`, `anim-ancestor-noninherited-60`, `anim-self-60` ·
`anim-subtree-60`, `anim-shadow-60` · `anim-none-60`.

`lane6-scratch/r9/candidates/animation-scope-equivalence.json` is a second, independent arm on the
admitted R9 timing protocol: option-pair, same bundle, standing suite, `expect: equivalence`. The
standing suite has no live animation, so it cannot demonstrate the opportunity — its only job is to
prove the lane is a true no-op on the animation-free hot path.

**Activation order.** `ACTIVE_CANDIDATE.json` still points at `protocol-self-null`. Do **not** flip it
to the new manifest until the self-null calibration has been re-run green at this head; the
self-null run is what proves the measurement protocol itself before any optimization claim is
admitted. Order: (1) run `r9-calibration.yml` at this head, (2) require it green, (3) flip
`ACTIVE_CANDIDATE.json`, (4) run `r9-hosted-bench.yml`.

## 11. Premises and limits

Stated rather than papered over:

1. **Scan-time sampling is unchanged, and slightly widened.** `scanFor` is memoized on `__epoch`, and
   starting or stopping an animation emits no `MutationRecord`, so the epoch does not bump. Both the
   historical boolean and the new index are sampled at the same instant as the keyframe→universe
   union, so the pre-existing exposure is identical — with one honest exception: previously, a
   document that already had an unrelated animation at scan time stayed on the conservative path for
   the whole capture, which accidentally covered an animation that *started* mid-capture. The scoped
   path does not. This widens an existing window; it does not create a new class of bug. Closing it
   properly means mutation-free animation-set tracking, which is a separate lane.
2. **G's proof is conditional** on `marginMayBeAuto` remaining a complete enumeration of authored
   `auto` margins (§4.2).
3. **B is unscoped** by decision, not oversight (§5).
4. **The R9 standing suite cannot see this lane's opportunity.** It is the no-regression arm only.

## 12. What was verified, and what was not

Verified, with no browser anywhere:

| Check | Result |
|-------|--------|
| `tsc --noEmit` | clean |
| `eslint src __tests__` | clean |
| `check-r10-anim-scope-algorithm.mjs` | 1200 randomized closure cases + full invariant set — **all pass** |
| source/copy drift guard | the verbatim markers are present in both `styleScan.js` and the checker |
| probe parses (`node --check`) | ok |
| probe hosted-only guard | fires and exits non-zero off a runner |
| workflow YAML parses; job graph | `logic -> probe(3 engines) -> parity` |
| R9 candidate manifest | parses; phase numbers copied from the standing self-null calibration for comparability |

**Not** verified, by instruction: everything that needs a browser. The vitest parity suite
(`__tests__/module.styles.animationScope.test.js`), the hosted causal probe and all three hosted
jobs are **unrun**. No local timing was taken and no local benchmark was executed. No number in this
document is a measurement — §7 defines how the ceiling will be computed once hosted evidence exists,
and §9's verdicts are the criteria that evidence will be judged against, not results.