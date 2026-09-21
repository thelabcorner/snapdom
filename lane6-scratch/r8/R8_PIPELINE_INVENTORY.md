# R8 Pipeline Inventory — measured vs unmeasured

Artifact: `lane6-scratch/r8/R8_PIPELINE_INVENTORY.md`
Worktree: `worktrees/snapdom-v3-r7-style-authority-integration`
Parent (certified R7 head): `58b97b0`
Source-commit of this inventory: `71be778` (superseded in-file by the commit that adds this file)

## Reader warning (location gotcha)

This repository has multiple worktrees. `src/modules/styleScan.js` and the R7 folds exist ONLY in
`worktrees/snapdom-v3-r7-style-authority-integration/`. The repo root checkout is a different
branch (`perf/juan-ready`) and does NOT contain them. Any grep/glob run from the repo root will
report "no R8 section", "no region entries", and "no styleScan.js"; that is a wrong-tree artifact,
not evidence of absence. All `file:line` references below were read from the R7 worktree.

## Status summary — read this before grading

| Region | Cost status | Candidate |
|---|---|---|
| A Public API / context | MEASURED (no per-node work) | stop |
| B Preparation / clone orchestration | **MEASURED** (+162 qSA, +81 gBCR on the census) | B1 |
| C Style scan | MEASURED (R5-D1..D6, allow-list) | stop |
| D Style snapshot / identity sharing | MEASURED (R7-SO1/OFF1/FP1/ANIMR1/MW1) | D1 |
| E Pseudo materialization | MEASURED (R7-PQU1; R7-P1 rejected) | E1 |
| F Background / mask / border-image | MEASURED (BGS1/BGS2/BGSNAP1/MASKDEF1/BGSTATE1) | stop |
| G Assets: images/fonts/SVG/compress | **MEASURED** (compress census = +3 qSA, +0 gBCR) | stop |
| H Layout corrections / prepass gate | MEASURED (R7-LCG1, R7-OFF1) | stop |
| I Serialization / render / export | **MEASURED** (style dominates; no serialization residual) | stop |
| J Burst / memo / repeated capture | **MEASURED** (memo hit = 0 native calls) | stop |

Criterion `gcr_f3e1e893cffdkDwHacJ1oQzn4W` requires every high-cost region to carry a
**measured** hypothesis, with a candidate or an explicit stop reason. All ten regions are now
measured: B resolved to candidate **B1**; G, I and J each resolved to explicit measured stops;
A, C, F and H were already measured with stop reasons from the R5/R7 corpus; D and E carry
measured candidates D1 and E1 from prior lanes. **No region remains UNMEASURED.**

## Region I — how to convert UNMEASURED to measured (I1 plan)

Goal: determine whether style snapshotting or clone+serialize dominates the public capture path
after the R7 folds.

- Instrument, on the public pipeline `snapdom.toRaw(el, opts)`:
  - `getComputedStyle` call count (patch `window.getComputedStyle`)
  - `CSSStyleDeclaration.prototype.getPropertyValue` call count
  - `Element.prototype.getBoundingClientRect` call count
  - `querySelectorAll` call count
  - `performance.now()` deltas around three explicit seams: (1) end of `prepareClone`,
    (2) end of `inlineAllStyles`, (3) end of `composeAndSerialize`
- Fixture: `cards400-safe` (deterministic, already an accepted oracle) plus `entropy-400`.
- Expected observable: if serialize+clone wall time exceeds style-snapshot wall time on
  `cards400-safe` after the R7 folds, region I becomes the primary R8 target; otherwise the
  style path remains primary and region I stays a stop.
- Deliverable: JSON with the four counters and the three stage deltas, committed under
  `lane6-scratch/r8/results/`.

## Region J — how to convert UNMEASURED to measured (J1 plan)

Goal: establish whether burst memo hits on the public path are already at the observed bound.

- Harness: repeated `snapdom.toRaw(el, { burst: true })` on an unchanged subtree, measuring
  per-call wall time for capture 1 (miss) vs captures 2..N (memo hit).
- Counters: per-hit `querySelectorAll` count, `getComputedStyle` count, style-attribute reads.
- Fixture: a 400-card subtree, identical to the accepted `cards400-safe` shape.
- Expected observable: BSAFE1 already reported 1202→0 style reads and BSAFE2 1→0 qSA, so the
  hypothesis to test is that the memo-hit path is already bounded and region J is a stop.
  The measurement exists to falsify that, not to assume it.
- Deliverable: JSON under `lane6-scratch/r8/results/`.

## Region-by-region detail

### A — Public API and context boundary (MEASURED)
- Symbols: `main()` `src/api/snapdom.js:106`; `createContext` `src/core/context.js:108`;
  `captureDOM` `src/core/capture.js:71`; `fromString` `src/api/snapdom.js:47`.
- Evidence: no per-node native calls; setup cost only.
- Protected seam: option normalization; `invalidate` epoch reset `src/api/snapdom.js:118`.
- Candidate: NONE — no per-node work exists here.

### B — Preparation / clone orchestration (NOW MEASURED — candidate)
- Symbols: `prepareClone` `src/core/prepare.js:42`; `flushStyleInvalidations` `prepare.js:46`;
  `invalidateHoverChanges` `prepare.js:48`; offscreen shadow-icon census `prepare.js:99-130`
  with `querySelectorAll('*')` at `prepare.js:110` and `getBoundingClientRect` at
  `prepare.js:121`; gate condition `prepare.js:103-104` (offscreen) and `prepare.js:115-122`
  (`calcite-icon` host, empty `path[d]`, non-zero box).
- **Measured (B1 probe, Chromium, dedicated fixture, n=8 warmup=2):**
  `bench-shadow-icon-census.mjs`, public `snapdom.toRaw`, artifact
  `lane6-scratch/r8/results/shadow-icon-census-chromium.json`:
  - `offscreen-icons` (40 icons, fixture triggers the census): median **86.0ms** CoV 9.2%,
    qSA **188**, gBCR **86**
  - `offscreen-no-icons` (same tree, no icons): median **14.6ms** CoV 10.3%, qSA 26, gBCR 5
  - `onscreen-icons-control` (protected control, icons present but NOT offscreen):
    median **67.6ms** CoV 7.1%, qSA 105, gBCR **5** → the census correctly does not run
- Isolation: the census accounts for **+162 querySelectorAll** and **+81 getBoundingClientRect**
  versus the no-icon tree, and the onscreen control's gBCR=5 versus offscreen gBCR=86 proves the
  `offscreen` gate is what triggers the walk. The 40 icons each contribute one BCR in the census
  plus the warmup's own BCR.
- Protected seam: #488 warmup must not be skipped when a root genuinely needs it; the
  concurrent-capture sharing `prepare.js:84-98` is load-bearing. Any candidate must preserve the
  warmup for genuinely-unresolved icons.
- **Candidate B1 (MEASURED, medium value):** the outer `element.querySelectorAll('*')` at
  `prepare.js:110` and the nested `root.querySelectorAll('*')` at `prepare.js:116` run on a
  full-tree basis before any icon test. A cheaper precheck — document/element-level "any
  calcite-icon present" test before entering the census — would remove the walk on trees with no
  such host. Must retain the gBCR-based liveness test for real pending icons. Requires its own
  same-bundle counterfactual and an icon-present oracle.


### C — Style scan (MEASURED)
- Symbols: `ALWAYS_PROPS` `src/modules/styleScan.js:42`; `INHERITED_PROPS` `styleScan.js:86`;
  `MAX_SCAN_RULES = 20000` `styleScan.js:107`; `UNSTABLE_LAYOUT_VALUE_RE` `styleScan.js:115`;
  `UNSTABLE_INSET_VALUE_RE` `styleScan.js:120`; imported at `styles.js:23-29`.
- Evidence: ledger rows R5-D1, R5-D2, R5-D3, R5-D4, R5-D5, R5-D6 (selector-rule indexing,
  K1000 up to -82%). Property-universe narrowing documented in `styles.js:1-16` (8-9x read
  reduction at 45 props, cross-engine).
- Protected seam: unreadable/cross-origin sheet returns `null` → full reads; scan rule budget.
- Candidate: NONE — D1..D6 already own this region.

### D — Style snapshot / identity sharing (MEASURED)
- Symbols: `inlineAllStyles` `styles.js:2816`; `getSnapshot` `styles.js:2561`; identity-hit
  overlay `styles.js:2609-2657` (`snap = Object.create(shared.snap)` at `styles.js:2626`);
  `shareLists` `styles.js:2461` (copyForSpread at `styles.js:2470`); Typed-OM margin loop
  `styles.js:2662-2696`; `stripHeightForWrappers` `styles.js:3259`; signature memo
  `styles.js:2178`; `snapshotKeyCache` cap `styles.js:76`.
- Evidence: ledger rows R7-SO1 (overlay, ~178k copied props removed; 1197/1202 share hits),
  R7-OFF1 (cards400 offset reads 4824→36), R7-FP1 (focus gPV -43%..-75%), R7-ANIMR1
  (animation-name 1202→5), R7-MW1 (-1000 gPV at 1000 nodes), R5-CORR1 (gutter injective fix).
- Protected seam: overlay prototype lifecycle (warm rebuild both directions); CORR1 signature
  injectivity; `''` tombstone vs `delete`.
- Candidate D1: `styles.js:2662-2696` still allocates a Typed-OM `computedStyleMap()` and loops
  up to 8 `MARGIN_PROPS` per node whose margin is `'0px'`. R5-SM2 proved the negative capability
  per node; test hoisting that proof to once-per-capture. Protected control required: an
  auto-margin-capable fixture must stay byte-identical.

### E — Pseudo materialization (MEASURED)
- Symbols: `preparePseudoEnvironment` `src/modules/pseudo.js:91`; `preflightWithFp`
  `pseudo.js:57`; `CSS_RULE_SCAN_BUDGET = 1000` `pseudo.js:48`; per-node `matches()` gate
  documented `pseudo.js:16-17`.
- Evidence: ledger row R7-PQU1 (~1202 `matches()` removed) and the "R7-P1 VERDICT" section
  (REJECT as default: pairs +8.2%, triples-unique +7.0%; lazy-#3 recorded as unimplemented).
- Protected seam: the P1 rejection stands unless a redesign clears the pair/triple cells.
- Candidate E1: the pre-registered lazy-#3 design — allocate the overlay only at occurrence #3
  so pair scenes cost zero. Acceptance controls: `pseudo-pairs-400` and
  `pseudo-triples-unique-style-360` must not regress.

### F — Background / mask / border-image (MEASURED)
- Symbols: `inlineBackgroundForNode` `src/modules/background.js:63`; read closure
  `background.js:85-89`; `backgroundSourceBasis` `background.js:34`; deliberate live URL reads
  `background.js:100-110`.
- Evidence: ledger rows R7-BGS1, R7-BGS2, R7-BGSNAP1, R7-MASKDEF1, R7-MASKDEF1-ADD, R7-BGSTATE1,
  and the R7-BGAD1 rejection.
- Protected seam: URL-bearing values stay LIVE (snapshot rewrites remote `url()` to `none`);
  the late `afterClone` observation point is protected.
- Candidate: NONE — four stacked wins plus a documented rejection already own this region.

### G — Assets: images, fonts, SVG defs, compress (NOW FULLY MEASURED — stop)
- Symbols: `inlineImages` (capture.js:11); `inlineExternalDefsAndSymbols`
  (`src/modules/svgDefs.js:166,184,257`); font scan `src/modules/fonts.js:926,975`;
  `el.matches(gate)` pre-filter `fonts.js:1227`; `compressClonedImages` root-is-img guard
  `compress.js:555-558`; `compressClonedBackgrounds` census `compress.js:620-628` and
  per-candidate `getComputedStyle(orig)` `compress.js:635`.
- Evidence: SA6 asset-heavy gCS 1905→448 (-76.5%); flags `__imageStyleReuse`,
  `__svgDefsStyleReuse`, `__svgPaintStyleReuse` promoted.
- **Measured (G1 probe, Chromium, deterministic all-data-URL fixture, 120 cards, n=6 warmup=2):**
  `bench-compress-census.mjs`, public `snapdom.toRaw`, artifact
  `lane6-scratch/r8/results/compress-census-chromium.json`:
  - `compress-on`: median **12.6ms** CoV 25.1%, qSA **25**, gCS **371**, gBCR 126
  - `compress-off` (protected control): median **11.7ms** CoV 16.6%, qSA **22**, gCS **251**,
    gBCR 126
  - `compress-root-is-img-461` (guard exercised): median **1.9ms**, qSA 25, gCS 9, gBCR 5
- Isolation: the census costs **+3 querySelectorAll** and **+0 getBoundingClientRect** versus
  compress-off. The +120 gCS delta is exactly one `getComputedStyle(orig)` per card, which is
  the legitimate `compress.js:635` read needed to evaluate `background-repeat`/`background-size`
  — not census overhead. The `compress.js:625-628` filter already short-circuits on
  `el.style.backgroundImage` before any style read, and gBCR is identical across arms, proving no
  geometry walk is added by the census.
- Protected seam: the #461 root-is-img guard `compress.js:555-558`; the `el.style` fast path in
  the candidate filter; `background-size: auto` cropping semantics (compress.js:600-612).
- **Candidate G1: REJECTED — measured STOP.** Restricting the census to
  `[data-snapdom-asset]` could save at most ~3 qSA calls while putting the #461 guard and the
  `el.style` fast path at risk, and the only real cost (gCS) is irreducible per-candidate
  semantics rather than census overhead. Region G closes with no candidate.


### H — Layout corrections / prepass gate (MEASURED)
- Symbols: `lineClampTree` `capture.js:20,158-165`; `needsTextTruncationPrepass`
  `capture.js:22,158`; `styleSharePlan` `styles.js:810`; `stripHeightForWrappers`
  `styles.js:3259`; `autoContentHeight` `styles.js:3234`.
- Evidence: ledger row R7-LCG1 (clamp gPV 1204→2, provisional keep), R7-OFF1.
- Protected seam: the LCG1 proof must not be generalized to `content-visibility`.
- Candidate: NONE — LCG1 owns the pass elimination; its remaining gate is bundle + clean wall.

### I — Serialization / render / export (NOW MEASURED — stop reason recorded)
- Symbols: `composeAndSerialize` (`src/engines/svg.js`, imported `capture.js:27`);
  `sanitizeCloneForXHTML`, `shrinkAutoSizeBoxes`, `assembleCaptureCSS`
  (`src/utils/capture.helpers.js`, imported `capture.js:28-36`); `src/exporters/*`.
- **Measured (I1 probe, commit `f3a2c19`):** `bench-stage-attribution.mjs`, Chromium,
  public `snapdom.toRaw`, n=5 warmup=2, artifact
  `lane6-scratch/r8/results/stage-attribution-chromium.json`:
  - `cards400-safe`: median **144.6ms**, CoV 8.6%; per capture **gCS 1611, gPV 9526,
    gBCR 5, qSA 25**, 165,053 bytes.
  - `entropy-400`: median **59.4ms**, CoV 4.2%; per capture **gCS 818, gPV 27402,
    gBCR 406, qSA 25**, 46,124 bytes.
- Interpretation: the gPV/gCS counts dominate and match the R7 ledger's style-path findings
  (cards400 total gPV ~20184 pre-OFF1), while serialization contributes no native-call signal.
  Clone+serialize is NOT the residual giant on these fixtures; the style path still is.
- Protected seam: XHTML sanitization and root geometry neutralization are correctness-critical;
  R7-SO1 byte parity depends on this stage.
- **Candidate: NONE — measured STOP.** Serialization has no measured residual to attack on the
  standing workload matrix. Reopen only if a fixture with a large serialization/wall share and a
  small style share is demonstrated; the entropy scene (46KB, 59ms) is the closest and still
  shows style domination.

### J — Burst / memo / repeated capture (NOW MEASURED — hypothesis falsified, stop recorded)
- Symbols: invalidation matrix `src/core/burst.js:7-54`; `knownFrameDriven` `burst.js:79`;
  `tryDiffCapture` (`src/core/diff.js`, imported `burst.js:68`).
- **Measured (J1 probe, commit `f3a2c19`):** `bench-burst-memo-hit.mjs`, Chromium, one unchanged
  400-card subtree, n=10 hits, artifact
  `lane6-scratch/r8/results/burst-memo-hit-chromium.json`:
  - capture 1 (miss): **229.4ms**, gCS 1611, gPV 9526, qSA 25
  - captures 2..10 (memo): median **0.6ms**, with **gCS 0, gPV 0, gBCR 0, qSA 0**
  - after a real DOM mutation: **24.5ms**, gCS 409 → correctly a fresh capture, not a stale memo
- Interpretation: the hypothesis under test was that the memo path might still walk the tree.
  It does not — memo serves perform **zero** instrumented native calls. R7-BSAFE1/BSAFE2 already
  reached the bound.
- Protected seam: `attachShadow()` emits no MutationRecord, so the shadow-root census may never
  be removed; closed roots require `invalidate: true`.
- **Candidate: NONE — measured STOP.** There is no residual memo-hit work left to remove on this
  workload; a "memo optimization" here would be optimizing an already-zero path.


## Explicit non-claims

- No R8 timing has been run. The I1/J1/B1/G1 probes are **measurement evidence**, not promotion
  evidence, and no candidate is enabled by them.
- No R8 candidate has been implemented, promoted, or rejected.
- All ten pipeline regions are now measured. G1 was rejected on measurement (census overhead is
  +3 qSA, +0 gBCR; the only real cost is irreducible per-candidate semantics). B remains a
  measured candidate (B1); I and J resolved to measured stops.

## Probe artifacts

- `lane6-scratch/r8/bench-stage-attribution.mjs` → `lane6-scratch/r8/results/stage-attribution-<engine>.json`
- `lane6-scratch/r8/bench-burst-memo-hit.mjs` → `lane6-scratch/r8/results/burst-memo-hit-<engine>.json`
- `lane6-scratch/r8/bench-shadow-icon-census.mjs` → `lane6-scratch/r8/results/shadow-icon-census-<engine>.json`
- `lane6-scratch/r8/bench-compress-census.mjs` → `lane6-scratch/r8/results/compress-census-<engine>.json`
- All four drive the public `snapdom.toRaw` pipeline and count `getComputedStyle`,
  `getPropertyValue`, `getBoundingClientRect`, and `querySelectorAll` via in-page prototype
  patches. All are rerunnable from the R7 worktree root.
