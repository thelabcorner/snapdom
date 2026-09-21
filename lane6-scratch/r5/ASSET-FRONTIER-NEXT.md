# Asset frontier — fresh post-389 attribution + R7-MASKDEF1 mechanism (deliverable/asset-frontier-next)

Owner: asset-frontier. Worktree: `worktrees/snapdom-v3-r7-asset-frontier` (isolated, detached at
`389907c1d5ba80a6ad60fc2e58b9ea403e53efef`, fresh `npm run compile`).
No wall-time claims anywhere: these are deterministic browser-bound CSSOM call counters.

## 1. Fresh attribution (asset-heavy, 369 elements, deterministic font-epoch move)

Fixture: standing `asset-heavy` (60 cards; img + object-fit + SVG defs/`<use>` + inline bg + @font-face).
Method: `probe-r7-asset-frontier-attribution.mjs` — fresh context per arm, same build, per-arm
`afterClone` plugin dispatches `loadingdone` so the relaxed font-epoch overlay path is exercised
on purpose (natural font delivery is racy; see §5). Per-engine fresh results:

| engine | gPV | gCS | matches | geometry | setProperty | img getters | raw bytes |
|---|---|---|---|---|---|---|---|
| chromium | 24,697 | 696 | 382 | 186 | 9,179 | 180 | 80,688 |
| firefox | 24,456 | 696 | 382 | 246 | 9,179 | 180 | 79,773 |
| webkit | 24,369 | 696 | 382 | 6 | 9,179 | 180 | 352,833 |

Same-build false-arm deltas (raw bytes EQ in every arm/engine — all mechanisms below are
representation-preserving):

| false arm | ΔgPV chromium | firefox | webkit | ΔgCS |
|---|---|---|---|---|
| `__maskLayoutInitialDefaults:false` (NEW R7-MASKDEF1) | +5,355 | +5,355 | +5,355 | 0 |
| `__backgroundFontEpochReuse:false` (BGSNAP1) | +6,689 | +6,840 | +6,689 | 0 |
| `__backgroundUrlSentinel:false` (BGS1) | +7,475 | +7,475 | +7,225 | 0 |
| `__backgroundSourceBasis:false` (BGS2) | +1,000 | +1,000 | +750 | 0 |
| `__backgroundStateProbeGate:false` (BGSTATE1) | 0 | 0 | 0 | 0 |
| `__svgDefsStyleReuse:false` | 0 | 0 | 0 | +242 |
| `__imageStyleReuse:false` | 0 | 0 | 0 | +120 |
| `__svgPaintStyleReuse:false` | 0 | 0 | 0 | +121 |

Chromium gPV by caller (current): `addProp` (universe snapshot materialization) 9,708;
`deepClone` (SVG paint extraction) 2,420; `getDefaultStyleForTag` 2,150; `getSnapshot` 1,416;
`computeBackgroundInlineState` 1,240; late background pass `inlineBackgroundForNode` family
(direct + `read` closure + readValue) ~3,594; `snapshotComputedStyleFull` 402;
`emulateBackdropFilters` 370; measure* (default-style) ~564.

Family verdicts on this workload:
- **SVG defs/style extraction**: `__svgDefsStyleReuse` saves 242 gCS (scan), `__svgPaintStyleReuse`
  121 gCS; gPV SVG paint extraction is 2,420 and unchanged by them.
- **Image source/used-size/object-fit**: 180 img-getter reads, `__imageStyleReuse` 120 gCS; small.
- **Default-style work**: `getDefaultStyleForTag` 2,150 + measurement helpers ~564 gPV = largest
  non-snapshot singleton; no sound fold proposed this round.
- **Background live/fallback/source probes**: BGS1 7,475 + BGS2 1,000 + BGSNAP1 6,689 all stack.
- **Font-epoch residue (the new target)**: `maskInSnap = 0/362` — the R3 element universe only
  keeps author-observable props (`elementUniverseFor`'s `push` requires `universe.has(prop)`),
  so all 15 mask longhands are absent from the snapshot; in the relaxed overlay path 370 flagged
  element declarations each live-read all 15 (5,550 gPV). This is the residue R7-MASKDEF1 folds.
- **Late whole-pass admission**: BGSTATE1 is exactly neutral here because the page authors
  background declarations (by design, fail-closed); admission on this scene is already pinned.

## 2. R7-MASKDEF1 mechanism (implemented, default on)

Design: in the BGSNAP1 relaxed overlay path only (`snap && !strictSnap && !maskLayoutRepresented
&& !hasLiveMaskSource`), replace per-node live reads of the 15 mask layout longhands with a lazy
per-(document, tag) memo of the captured values. Fold only when the complete scan proves the page
has no mask channel: no author mask/-webkit-mask declaration, no `all` rule, no animations,
readable/unblocked sheets, node not in shadow tree and not a slot; no inline mask declaration;
no SVG `mask` presentation attribute. The first node of a tag pays 15 reads; every later node of
that tag reuses the exact strings, so emitted bytes are unchanged. `__maskLayoutInitialDefaults:
false` is the explicit historical arm.

Files:
- `src/modules/styles.js` (+61): `maskLayoutInitialValues(el)`.
- `src/modules/background.js` (+16/-2): relaxed-overlay-only use of the memo.
- `src/core/context.js` (+5): forward `__maskLayoutInitialDefaults` (internal flags are whitelisted).
- `__tests__/module.styles.maskLayoutInitialDefaults.test.js` (7 tests).
- `lane6-scratch/r5/probe-r7-asset-frontier-attribution.mjs` + per-engine results JSON;
  `lane6-scratch/r5/tmp-maskdef-debug.mjs` (engagement diagnostics).

Measured: −5,355 gPV (−17.8% of chromium's 30,052 pre-fold total) with bytes identical
in every arm on chromium/firefox/webkit; identical saving on all three engines.

## 3. BGSNAP1 independent audit

- Semantics verified: relaxed snapshots 362/369 with `maskInSnap=0` (overlay is genuinely sparse);
  strict 0 under a forced font move; absent props still live-read.
- Savings reproduced same-build: 6,689 / 6,840 / 6,689 gPV (chromium/firefox/webkit), raw EQ.
- Late observation preserved: 6/6 dedicated tests pass standalone per engine (afterClone
  source-style + stylesheet mutation under a simultaneous font epoch included).
- **Caveat (pre-existing, flagged for owners)**: WebKit with two test files in parallel,
  1 of 2 runs failed 3 BGSNAP1 font-metric-closure tests (`backgroundSnapshotFor(probe,true)`
  non-null where null is expected); standalone always passes. The R7-MASKDEF1 diff cannot affect
  `backgroundFontSensitive` (mask-only), so this is a scan-freshness/test-timing flake, not a
  mask-fold regression. Ask pwh1-owner to confirm whether the scan's mutation-observer freshness
  is guaranteed before a capture starts.

## 4. Verification

- Cross-engine mechanism tests: chromium 13/13, firefox 13/13, webkit 13/13 (combined files;
  webkit flaked once as in §3, then passed). Standalone: maskdef 7/7 all engines, bgsnap 6/6.
- `npm run lint` clean; `npx tsc --noEmit -p tsconfig.json` clean; `npm run test:bundle` passes.
- Bundle delta: `dist/snapdom.mjs` 285,217 → 286,268 (+1,051 B, +0.37%);
  `dist/snapdom.js` 284,894 → 285,945 (+1,051 B).

## 5. Methodology note (fixture nondeterminism)

With natural font delivery, arms flip between two regimes run-to-run (raw 80,688 vs 78,887;
gPV ~30.0k vs ~24.5k; mask declarations 370 vs 122) because the font epoch may land before or
after snapshot creation. All acceptance numbers above therefore use the deterministic
afterClone epoch bump. Confirms the ledger's exclusion of this fixture as a natural oracle.

## 6. Residual frontier after this

`addProp` 9,708 (39%) universe materialization; default-style work 2,714; SVG paint 2,420;
`getSnapshot` 1,416; `computeBackgroundInlineState` 1,240; gCS residue ~696 (of which 483 already
removed by defs/image/paint reuse); geometry/matches are already small (186–246 / 382).

Proposed ledger row (do not merge before peer challenge): R7-MASKDEF1 — parent R7-BGSNAP1;
counter-only claim −5,355 gPV identical on 3 engines, raw EQ, lint/types/bundle pass;
verdict KEEP as deterministic font-epoch candidate, no timing claim yet.
