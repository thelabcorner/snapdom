# R10-ANIM1 — resolve the document-wide `hasAnimations` veto per consumer

Base: `c523ddb6e141846d55af1c8f315f65babbc32a7e`.

**Status: v1 (`d919614`) REJECTED by hosted run 37145239641. v2 is the candidate of record.**

---

## 0. Falsification record

Hosted run `37145239641`, all three engines, cross-engine deterministic:

| fixture | Chromium gPV | saved | required |
|---------|--------------|-------|----------|
| `anim-sibling-60` | — | ~6.4k | > 0 (opportunity) |
| `anim-ancestor-60` | 10023 → 3645 | **6378** | **0** |
| `anim-ancestor-customprop-60` | 10027 → 3649 | **6378** | **0** |
| `anim-ancestor-noninherited-60` | 10023 → 3645 | **6378** | **0** |
| `anim-self-60` | 10023 → 3820 | **6203** | **0** |
| `anim-subtree-60` | 10023 → 3916 | **6107** | 0 |
| `anim-shadow-60` | — | 0 | 0 ✓ |
| `anim-none-60` | — | 0 | 0 ✓ |

Raw parity was byte-exact on every fixture. **Parity is necessary, not sufficient**: a veto that
releases the wrong cases can still emit identical bytes whenever the omitted properties happen to
compute to `''`, which `addProp` drops anyway. That is why the falsifier contract exists alongside
parity rather than instead of it.

The near-identical savings across four different geometries are the signature of **one** defect, not
four.

## 1. Root cause: the reachability DIRECTION was inverted

`buildAnimationScope` built `ancestors` = the closure of each animation target's **ancestors** — the
elements that *feed* an animation. The question every consumer asks is the reverse: the elements an
animation *feeds*.

An animation on target `T`:

- moves `T`'s own computed values, and
- moves `T`'s **descendants**, because inherited values (including registered custom properties)
  flow **downward**.

It never moves `T`'s ancestors, and never a sibling. So `ANIM_SCOPE_SELF_OR_ANCESTOR` asked "am I
upstream of an animation?" — the near-complement of the right question — and consequently released
precisely the geometries that had to stay blocked.

Reproduced offline, browser-free, by `check-r10-anim-scope-geometry.mjs`, which keeps the broken
predicate as a negative control:

```
  geometry                                   animated  queried  spec      v2      v1(d919614)
  opportunity/sibling-of-root/deep-leaf      row1      leaf0    release   release  release
  falsifier/ancestor=host/deep-leaf          host      leaf0    BLOCK     BLOCK    release   ←
  falsifier/ancestor=host/container          host      root     BLOCK     BLOCK    release   ←
  falsifier/ancestor=host/shallow-row        host      rowA     BLOCK     BLOCK    release   ←
  falsifier/ancestor=row0/deep-leaf          row0      leaf1    BLOCK     BLOCK    release   ←
  falsifier/ancestor=body/shallow-row        body      rowA     BLOCK     BLOCK    release   ←
  falsifier/self=target/its-child            leaf0     deep     BLOCK     BLOCK    release   ←
  falsifier/self=capture-root                root      leaf1    BLOCK     BLOCK    release   ←
  falsifier/subtree/ancestor-above-root      host      root     BLOCK     BLOCK    release   ←
  release/target-is-deep/its-own-ancestor    leaf1     row0     release   release  BLOCK      (over-block, safe)
```

Every geometry v1 released and the spec requires blocked is the hosted signature. The one geometry
where v1 blocks and the spec releases is over-blocking: safe, only a lost opportunity.

## 2. Why the first browser-free check could not have caught this

`check-r10-anim-scope-algorithm.mjs` compared the optimized ancestor closure against a brute-force
**ancestor** closure. Implementation against itself, not against the spec — a self-referential
oracle that is satisfied by any consistently-inverted implementation. It is deleted.

`check-r10-anim-scope-geometry.mjs` replaces it and differs in three ways that matter:

1. the oracle is **independent and naive** — enumerate every node, ask the spec question directly;
2. expected verdicts are **hand-written per case**, so a wrong answer cannot be self-consistent;
3. geometry is declared as **explicit parent edges**, never string concatenation.

Point 3 was learned the hard way. The first draft of the geometry check concatenated two document
specs with `'>'`, producing `html>body>host>root>row0>leaf0>leaf1>html>body>host>root>row1` — a tree
with **two `<html>` nodes**, so `doc.documentElement` resolved to the second one and the "sibling"
target was actually a descendant. That produced five failures with nothing to do with the lane, and
two more came from expecting a parent/child relationship where the edge list had siblings. The check
now asserts the tree shape in a comment diagram so the two cannot be confused again.

## 3. Corrected mechanism

The index keeps **only** the animated nodes. The affected set is a target and its descendants, and
precomputing that would mean walking whole subtrees — so it is never precomputed. "Am I downstream of
an animation?" is answered by walking **up** from the queried node and asking whether any node on that
walk is a target.

| Reach arm | Predicate | Cost |
|-----------|-----------|------|
| `ANIM_REACH_SELF` | `targets.has(el)` | one `Set.has` |
| `ANIM_REACH_INHERITED` | walk `el → documentElement`, `targets.has(a)` | O(depth) |
| `ANIM_REACH_SUBTREE` | `REACH_INHERITED(root)` OR `root.contains(target)` for some target | O(depth + k) |

`ANIM_REACH_SUBTREE` needs both terms and neither subsumes the other: subtrees are nested or
disjoint, so a target strictly *inside* the root does not make the root itself reachable (an animation
cannot move its own ancestors) yet still changes something the consumer cares about.

Exhausting the walk budget before reaching the document element — a detached node, or a tree deeper
than 1024 — is uncertainty, and **fails closed**.

`unresolvable` still covers a null effect, a non-element target and any target rooted outside the
document. An unreliable scan still carries `UNRESOLVED_ANIMATION_SCOPE` rather than `null`, because
`null` would read as "no animation in scope" and silently release the gates the unreliable record
exists to close.

## 4. Consumer scopes

| Consumer | Reach arm | Why |
|----------|-----------|-----|
| `elementUniverseFor` | `INHERITED` | reads every computed property; inherited values arrive from above |
| `needsTextTruncationPrepass` | `SUBTREE` | subtree-wide pass; `text-overflow` inherits, `display` steps discretely |
| `canSkipBackgroundInlineStateProbe` | `SELF` | background/mask/border-image never inherit |
| `maskLayoutInitialValues` | `SELF` | every mask longhand is non-inherited |
| auto-margin Typed OM probe | `SELF` | margin does not inherit; the probe is a strict no-op unless Typed OM returns `auto` |
| `backgroundFontSensitiveFor` | unchanged, document-wide | rare font-epoch path, no `options` in its call chain, and its own document-wide term already vetoes font-sensitive pages — reason recorded at the call site |

`pseudoElement` needs no special case: a pseudo animation's `effect.target` is its originating
element, so pseudo targets land on the host. That over-approximates (a pseudo animation does not move
its host's computed values) and is kept deliberately, in the safe direction.

## 5. Amdahl ceiling — corrected cost model

v1's premise ("two `Set.has` per element") was **false**; the upward walk is O(depth). The ceiling is
therefore stated with the cost it actually pays, and is still an upper bound on any time ceiling:

```
T_forced      = savedCrossings x perCrossingCost
T_walk_added  = releasedElements x depth x perStepCost
ceiling       = T_total / (T_total - T_forced + T_walk_added)
```

Inputs, all hosted: `savedCrossings` from the probe's `gpv` delta; `perCrossingCost` from this
codebase's own measured ~56 µs/node for ~200 reads (`styles.js`, `getSnapshot` note) ≈ 280 ns;
`depth` and `releasedElements` from the `__animationScopeCounters` sink.

Sanity bound from hosted run 37145239641: ~106 crossings saved per released element ≈ 30 µs, against
an upward walk of ~10–30 pointer steps ≈ well under 1 µs. The trade stays strongly favourable — but it
is now an estimate with a stated denominator, not a free win, and it is **not** a measured speedup.
The opportunity is also conditional by construction: it exists only when no animation target is an
ancestor of the captured subtree, which is why pages that animate `body` or `html` get nothing.

## 6. Counters

Two independent sources that must agree:

1. **Out-of-band** — a `CSSStyleDeclaration.prototype.getPropertyValue` patch in the probe, outside
   snapdom, so it cannot be influenced by the lane's own bookkeeping.
2. **Internal** — `options.__animationScopeCounters`, absent in production:

| Key | Meaning |
|-----|---------|
| `elementUniverse` / `backgroundStateProbe` / `maskLayoutInitials` / `autoMarginProbe` / `textTruncationPrepass` | `{blocked, released}` per consumer |
| `reads` | CSSOM crossings inside `snapshotComputedStyleFull`, counted **at the crossing** |
| `index` | `{animations, targets, unresolvable}` — `ancestors` is gone in v2 |

## 7. Falsifiers, corrected

A falsifier must save exactly **zero** reads. Reduced reads mean the scope released a veto it was
required to keep — a red build.

| Fixture | Geometry | Required |
|---------|----------|----------|
| `anim-ancestor-60` | animated node is the capture root's parent | 0 |
| `anim-ancestor-customprop-60` | same, via an inherited `@property` | 0 |
| `anim-ancestor-noninherited-60` | same, non-inherited property | 0 |
| `anim-descendant-of-root-60` | animated node is a CHILD of the capture root — the geometry v1 missed | 0 |
| `anim-self-60` | animated node is the capture root | 0 |
| `anim-shadow-60` | animation inside a shadow root (`unresolvable`) | 0 |
| `anim-none-60` | no animation — guards against cost added to the clean path | 0 |

**`anim-subtree` is not a falsifier-zero case, and v1's fixture table wrongly said it was.** An
animation inside the captured subtree moves its target and that target's descendants — it cannot move
a *sibling* of the target — so every other row in the capture is genuinely released. It is a
**partial release** for the element universe (`anim-subtree-partial-60`, expects > 0) and a **full
block** for the subtree-scoped truncation prepass, which
`check-r10-anim-scope-geometry.mjs` pins structurally. Forcing it to falsifier-zero would mean
weakening the element-universe scope for a case it gets right, so it is recorded honestly instead.

Fixture determinism: every fixture freezes its animation (`pause()` + `currentTime = 0`). Paused
animations are still returned by `getAnimations()`, so the veto is exercised identically — and because
an animated computed value moves with the clock, freezing is what makes exact-raw-parity an assertion
rather than a race.

## 8. Hosted matrix

`.github/workflows/r10-animation-scope.yml`, GitHub-hosted only. The probe calls
`assertHostedBrowser()` and exits non-zero off a runner; the workflow re-checks `GITHUB_ACTIONS`.
No local timing and no timing at all — counts are exact.

| Job | Engines | Gate |
|-----|---------|------|
| `logic` | none (Node only) | reachability classification vs the independent oracle; hand-written verdicts; d919614 negative controls; source drift guard; depth-budget fail-closed |
| `probe` | chromium, firefox, webkit | exact raw parity per fixture; falsifier and control saves exactly 0; opportunity saves > 0; hosted provenance; engine identity; identical bundle hash across engines |
| `parity` | all three | same bundle hash; same role classification per fixture on every engine; falsifier/control-zero invariant on every engine |

Absolute saved counts may differ per engine — their CSSOM enumerates different property sets. The
**sign** is the invariant.

`lane6-scratch/r9/candidates/animation-scope-equivalence.json` remains an inactive option-pair arm on
the admitted R9 timing protocol (standing suite, `expect: equivalence`). The standing suite has no
live animation, so it cannot see this lane's opportunity; its job is proving the lane is a true no-op
on the animation-free hot path. `ACTIVE_CANDIDATE.json` is still **not** flipped: the self-null
calibration must be re-run green at this head first, because it is what admits the protocol.

## 9. Premises and limits

1. **Scan-time sampling is unchanged and slightly widened.** `scanFor` memoizes on `__epoch`, and
   starting or stopping an animation emits no `MutationRecord`, so the index is sampled at scan time
   exactly as the historical boolean was. v1 additionally *widened* the window: a document that
   already had an unrelated animation previously stayed conservative for the whole capture, which
   accidentally covered an animation starting mid-capture. v2 keeps that widening (it is inherent to
   scoping) but no longer widens it in the unsafe direction. Closing it properly means mutation-free
   animation-set tracking — a separate lane.
2. **SMIL is invisible to both arms.** SVG `<animate>` is not returned by `getAnimations()`, so
   `hasAnimations` never saw it either. Pre-existing and symmetric; not introduced here.
3. **The auto-margin proof is conditional** on `marginMayBeAuto` remaining a complete enumeration of
   authored `auto` margins — the same contract the lane already relies on.
4. **`backgroundFontSensitiveFor` is unscoped** by decision, not oversight.
5. **The R9 standing suite cannot see this lane's opportunity.**

## 10. Verification record

Browser-free, all green at this commit:

| Check | Result |
|-------|--------|
| `tsc --noEmit` | clean |
| `eslint src __tests__` | clean |
| `check-r10-anim-scope-geometry.mjs` | 27 spec cases (14 blocked / 13 released) + 7 negative controls + fail-closed set — **ALL PASS** |
| drift guard | v2 markers present in `styleScan.js` / `styles.js`; `ancestors` closure absent |
| probe `node --check` | ok |
| probe hosted-only guard | fires and exits non-zero off a runner |
| workflow YAML | parses; `logic → probe[3 engines] → parity` |

**Not** verified locally, by instruction: everything needing a browser — the vitest parity suite, the
hosted causal probe, and all three hosted jobs. No local timing, no local benchmark. No number in this
document is a measurement.