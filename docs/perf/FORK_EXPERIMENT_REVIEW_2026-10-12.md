# snapDOM v3 — experimental optimization review ledger (2026-10-12)

This is a **research audit**, not a production-release assertion. It tracks remote experiment refs, reproducible hosted evidence, rejected hypotheses, and the smaller reconstructed fork PRs for Juan's eventual consideration. Past benchmark results apply only to their frozen revisions and hardware.

## Reconciliation and scope

- Fork: [thelabcorner/snapdom](https://github.com/thelabcorner/snapdom); upstream: [zumerlab/snapdom](https://github.com/zumerlab/snapdom).
- Fork baseline `d97442f4` was two commits ahead and 87 behind upstream main `294dae56` on 2026-10-12.
- [Draft PR #7](https://github.com/thelabcorner/snapdom/pull/7) reconciles upstream v3.3.3 and removes the broken auto-triggered R7 timing workflow (missing experimental scripts on a clean clone); experimental branches and artifacts remain available.
- The dirty `perf/juan-ready` checkout was **not** cleaned, rebased, reset or staged. Curated changes use separate clean worktrees.
- This report inventories 90 GitHub remote branches matching `perf/v3-*` (table below). It does not claim that all local-only or untracked experimental files, older v2 projects, or every Actions artifact have been individually audited.

## Currently curated fork PRs

| PR | Concern | Verified on new v3.3 base | Outstanding |
| --- | --- | --- | --- |
| [#7](https://github.com/thelabcorner/snapdom/pull/7) | Upstream reconciliation and orphaned CI removal | Clean non-conflicting upstream merge, isolated obsolete workflow removal | Broader v3.3 acceptance before promotion to fork main |
| [#8](https://github.com/thelabcorner/snapdom/pull/8) | R12 canonical SVG data-URL header scaling, preserving encoded body | Exact-byte Node tests 2 pass, lint/types/build pass, Firefox/Chromium exporter CI pass | Hosted paired end-to-end performance, WebKit shadow fixture is red on **unchanged upstream baseline** too |
| [#9](https://github.com/thelabcorner/snapdom/pull/9) | R13 oversized raster SVG header clamping | Exact-byte Node tests 2 pass, lint/types/build pass, Firefox/Chromium exporter CI pass | Same hosted gate and export-path performance validation; stacked on #8 |

**Review topology:** `main → #7 → #8 → #9`. Each PR is draft and targets its immediate parent; neither optimization is upstreamed or merged.

### Independent WebKit control

The unchanged v3.3 source reproduces the identical `exporter.safariPaths.test.js` failure (`shadow keeps its live orientation (below the box)`, expected blue channel >200, observed 0). Evidence: [baseline run 38293976226](https://github.com/thelabcorner/snapdom/actions/runs/38293976226), alongside [candidate run 38293687275](https://github.com/thelabcorner/snapdom/actions/runs/38293687275). Do **not** delete the test, change pixel tolerances, or claim cross-engine acceptance based only on this attribution. It remains a separately actionable upstream fidelity defect.

## Research decisions and falsifiers

| Experiment family | Evidence and status | Release decision |
| --- | --- | --- |
| R12 SVG header scaling / R13 raster clamp | Historical 3-engine validation [R12 run 37740540543](https://github.com/thelabcorner/snapdom/actions/runs/37740540543) and [R13 run 37741153484](https://github.com/thelabcorner/snapdom/actions/runs/37741153484) | **Reconstructed for review:** #8 and #9; require new v3.3 real-export paired timings |
| R12 sticky-worker decoded bitmap reuse | 8-image-homogeneous-runner memory study [37747198712](https://github.com/thelabcorner/snapdom/actions/runs/37747198712): large capture −25.50% latency, CI [−27.52%,−23.42%], but **+4698 KiB PSS**; width −28.12% latency, **+3922 KiB PSS** | **Hold**: measured latency/memory tradeoff; unique-source churn and retention budget unresolved |
| R13 single-flight decode | [Three-engine fidelity pass 37742909995](https://github.com/thelabcorner/snapdom/actions/runs/37742909995) | **Hold**: controlled end-to-end timing, PSS and worker scheduling/identity guards |
| R14 Safari shadow handling | [WebKit blue-shadow pixel failure 37741935379](https://github.com/thelabcorner/snapdom/actions/runs/37741935379) | **Reject promotion** unless pixel fidelity fixed |
| R15 external SVG image memo / R16 two-hit admission | Cache contracts; native-memory aggregate explicitly `memoryPromotionAccepted:false` [37744482998](https://github.com/thelabcorner/snapdom/actions/runs/37744482998) | **Hold**, no accepted real-capture + memory dominance |
| R16 background selector gate | [37745225552](https://github.com/thelabcorner/snapdom/actions/runs/37745225552) dense background **+3.18% slower**, 95% CI [+2.12%,+4.25%]; other regimes ambiguous | **Rejected** |
| R17 image workqueue | Strong narrow straggler trials, but [native-memory review 37747577364](https://github.com/thelabcorner/snapdom/actions/runs/37747577364) has `memoryPromotionAccepted:false` | **Hold**, do not assume host-image cohort mixing is valid |
| R17 concurrent compression | Mixed capture −6.05% CI [−13.17%,+1.65%], WebKit same-source RGBA instability [37746367847](https://github.com/thelabcorner/snapdom/actions/runs/37746367847) | **Hold**, effect interval includes zero and fidelity control unresolved |
| R18 font variant memo | Isolated 32-line mechanism `70045eb`; cross-engine [37748391311](https://github.com/thelabcorner/snapdom/actions/runs/37748391311), native-PSS [37748673460](https://github.com/thelabcorner/snapdom/actions/runs/37748673460) | **Candidate for separate follow-up**, inspect aggregated memory effect and v3.3 end-to-end before opening source PR |
| R19 SVG serialization scanner | Exact output preserved but no meaningful capture improvement and some regressions [37749296803](https://github.com/thelabcorner/snapdom/actions/runs/37749296803) | **Rejected** by its own research ledger |
| R20–R23 inherited ancestor property-universe memo | Deep invalidated styles ~10–15% faster; ultra-deep synthetic ~42%; warm snapshots can bypass. R21–R23 validate mutation/memory and A/A null [37758528902](https://github.com/thelabcorner/snapdom/actions/runs/37758528902) | **Hold**. It depends on experimental R3 `elementUniverseFor`, which does not exist in upstream v3.3. Do not cherry-pick R20 alone |
| R2–R10 selector/style/gutter/pseudo/cache work | Extensive branch matrix, with counterexamples and timing noise. See [original integrated release gate](https://github.com/thelabcorner/snapdom/blob/perf/v3-release-integration-ledger/docs/perf/V3_RELEASE_GATE_20261008.md) | **Research-only until mechanism-specific v3.3 revalidation** |

## Promotion protocol for discussions with Juan

1. **One concern per PR**, minimal source/test diff, no generated research bulk, no unrelated source formatting, no public API knobs.
2. Compare the right pipeline: full public capture for capture optimizations, full public export for exporter optimizations; internal microbenchmarks do not imply global gains.
3. Host independent balanced A/B and same-source A/A null controls; pin frozen baseline SHA, OS/runner image, browser version, output hashes. Report per-runner 95% confidence intervals, not pooled pseudoreplicates.
4. Require exact SVG bytes **and** rendered RGBA comparisons on Chromium, Firefox and WebKit for scaled, shadowed, transformed, malformed, proxy, Shadow DOM, font, CSP and fallback cases. Preserve failing controls.
5. For caches, constrain retention; measure warmed and post-unique-source-sweep native process-family PSS and verify invalidation.
6. Preserve the original research and negative evidence. Never merge the historic R12–R23 branch heads wholesale; they include independent features and CI-only revisions.

## Complete remote branch head inventory

Fetched `origin/perf/v3-*` on 2026-10-12. Entries below are **pointers to historical evidence, not approvals**; a branch's head can be a CI-only change with a long ancestry of experimental source patches.


| Historical branch | HEAD | Last commit subject |
| --- | --- | --- |
| [perf/v3-frontier](https://github.com/thelabcorner/snapdom/tree/perf/v3-frontier) | f54812b | perf(styles): partition structural selector sharing |
| [perf/v3-frontier-clean](https://github.com/thelabcorner/snapdom/tree/perf/v3-frontier-clean) | fb212ab | wip(research): preserve perf/v3-frontier-clean experiment state |
| [perf/v3-r2-clean](https://github.com/thelabcorner/snapdom/tree/perf/v3-r2-clean) | 7c0fcc4 | perf(styles): partition structural selector sharing |
| [perf/v3-r2-style-share](https://github.com/thelabcorner/snapdom/tree/perf/v3-r2-style-share) | f54812b | perf(styles): partition structural selector sharing |
| [perf/v3-r3-universe](https://github.com/thelabcorner/snapdom/tree/perf/v3-r3-universe) | 1fcd784 | perf(styles): index element-universe dependencies |
| [perf/v3-r4-frontier](https://github.com/thelabcorner/snapdom/tree/perf/v3-r4-frontier) | fdc3064 | perf(styles): harden shared style identity |
| [perf/v3-r5-attr-rule-index](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-attr-rule-index) | d8b355e | wip(research): preserve perf/v3-r5-attr-rule-index experiment state |
| [perf/v3-r5-attr-value-index](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-attr-value-index) | 8d10f69 | perf(styles): index exact data attribute values |
| [perf/v3-r5-auto-margin-gate](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-auto-margin-gate) | 456ca8f | fix(styles): make scrollbar gutter correction idempotent |
| [perf/v3-r5-burst-retained-scroll](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-burst-retained-scroll) | 3cfecb2 | perf(styles): index direct subject attributes |
| [perf/v3-r5-burst-scroll](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-burst-scroll) | 3cfecb2 | perf(styles): index direct subject attributes |
| [perf/v3-r5-clone-overhead](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-clone-overhead) | 7c14bb4 | wip(research): preserve perf/v3-r5-clone-overhead experiment state |
| [perf/v3-r5-cssvar-precheck](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-cssvar-precheck) | 79b3a3c | wip(research): preserve perf/v3-r5-cssvar-precheck experiment state |
| [perf/v3-r5-d-su](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-d-su) | 094c1d3 | perf(styles): guard composed universe selector work |
| [perf/v3-r5-general-key-planner](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-general-key-planner) | 18e1afb | fix(styles): harden compound rule key planning |
| [perf/v3-r5-multikey-selectivity](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-multikey-selectivity) | 56da132 | wip(research): preserve perf/v3-r5-multikey-selectivity experiment state |
| [perf/v3-r5-pseudo-candidates](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-pseudo-candidates) | 3cfecb2 | perf(styles): index direct subject attributes |
| [perf/v3-r5-rule-index](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-rule-index) | 5166cc7 | perf(styles): adapt selector rule indexing |
| [perf/v3-r5-scroll-node-map-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-scroll-node-map-reuse) | f74d60b | test(styles): pin PR 492 fidelity invariants |
| [perf/v3-r5-selector-cse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-selector-cse) | 7f639d9 | test(styles): pin v3 fidelity cases from prior perf review |
| [perf/v3-r5-session-snapshot-handoff](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-session-snapshot-handoff) | ea36cc5 | wip(research): preserve perf/v3-r5-session-snapshot-handoff experiment state |
| [perf/v3-r5-share-universe](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-share-universe) | 3897222 | perf(styles): compose style sharing with element universes |
| [perf/v3-r5-style-sig-gutter](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-style-sig-gutter) | 277a275 | wip(research): preserve perf/v3-r5-style-sig-gutter experiment state |
| [perf/v3-r5-style-sig-gutter-d6](https://github.com/thelabcorner/snapdom/tree/perf/v3-r5-style-sig-gutter-d6) | b56daff | test(styles): harden selector CSE invalidation |
| [perf/v3-r6-scroll-observation-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r6-scroll-observation-reuse) | e4a6432 | wip(research): preserve perf/v3-r6-scroll-observation-reuse experiment state |
| [perf/v3-r6-scroll-reuse-sm2](https://github.com/thelabcorner/snapdom/tree/perf/v3-r6-scroll-reuse-sm2) | 3899958 | wip(research): preserve perf/v3-r6-scroll-reuse-sm2 experiment state |
| [perf/v3-r7-backdrop-style-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-backdrop-style-reuse) | 301ed2d | wip(research): preserve perf/v3-r7-backdrop-style-reuse experiment state |
| [perf/v3-r7-border-normalize-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-border-normalize-reuse) | ea07b0c | wip(research): preserve perf/v3-r7-border-normalize-reuse experiment state |
| [perf/v3-r7-focus-partition](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-focus-partition) | a047f45 | wip(research): preserve perf/v3-r7-focus-partition experiment state |
| [perf/v3-r7-gutter-snapshot-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-gutter-snapshot-reuse) | 85ace8d | wip(research): preserve perf/v3-r7-gutter-snapshot-reuse experiment state |
| [perf/v3-r7-integration-scout](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-integration-scout) | 85f38bf | wip(research): preserve perf/v3-r7-integration-scout experiment state |
| [perf/v3-r7-minwidth-snapshot-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-minwidth-snapshot-reuse) | 7ff44bb | wip(research): preserve perf/v3-r7-minwidth-snapshot-reuse experiment state |
| [perf/v3-r7-overlay-gutterfix](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-overlay-gutterfix) | 356f3c1 | wip(research): preserve perf/v3-r7-overlay-gutterfix experiment state |
| [perf/v3-r7-overlay-sm2-lazy](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-overlay-sm2-lazy) | 7a47572 | wip(research): preserve perf/v3-r7-overlay-sm2-lazy experiment state |
| [perf/v3-r7-parent-style-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-parent-style-reuse) | d395b3d | wip(research): preserve perf/v3-r7-parent-style-reuse experiment state |
| [perf/v3-r7-pseudo-content-cse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-pseudo-content-cse) | 40c2d28 | wip(research): preserve perf/v3-r7-pseudo-content-cse experiment state |
| [perf/v3-r7-pseudo-host-style-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-pseudo-host-style-reuse) | eda8862 | wip(research): preserve perf/v3-r7-pseudo-host-style-reuse experiment state |
| [perf/v3-r7-pseudo-local-cse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-pseudo-local-cse) | 456ca8f | fix(styles): make scrollbar gutter correction idempotent |
| [perf/v3-r7-pseudo-overlay](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-pseudo-overlay) | 9fdd822 | wip(research): preserve perf/v3-r7-pseudo-overlay experiment state |
| [perf/v3-r7-pseudo-overlay-clean](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-pseudo-overlay-clean) | 1495130 | wip(research): preserve perf/v3-r7-pseudo-overlay-clean experiment state |
| [perf/v3-r7-pwh1-inline-wh-rider](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-pwh1-inline-wh-rider) | 1f8bcd4 | perf(pseudo): PWH1 rev4 - case-insensitive container exposure guards |
| [perf/v3-r7-snapshot-overlay](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-snapshot-overlay) | 844fe50 | wip(research): preserve perf/v3-r7-snapshot-overlay experiment state |
| [perf/v3-r7-snapshot-overlay-sm2](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-snapshot-overlay-sm2) | 52c3f1e | wip(research): preserve perf/v3-r7-snapshot-overlay-sm2 experiment state |
| [perf/v3-r7-snapshot-probe](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-snapshot-probe) | 670862b | wip(research): preserve perf/v3-r7-snapshot-probe experiment state |
| [perf/v3-r7-style-acquisition-cse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-style-acquisition-cse) | 330aca1 | wip(research): preserve perf/v3-r7-style-acquisition-cse experiment state |
| [perf/v3-r7-style-authority-integration](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-style-authority-integration) | 4f02f6c | r8: E1 lazy pseudo reuse REJECTED — fixes pairs/triples, new quad regression |
| [perf/v3-r7-style-cache-handoff](https://github.com/thelabcorner/snapdom/tree/perf/v3-r7-style-cache-handoff) | 825c138 | wip(research): preserve perf/v3-r7-style-cache-handoff experiment state |
| [perf/v3-r8-p1-breakeven](https://github.com/thelabcorner/snapdom/tree/perf/v3-r8-p1-breakeven) | 8ea5495 | ci: re-trigger r7-timing pull_request run with valid main workflow |
| [perf/v3-r8-p1-lazy-current](https://github.com/thelabcorner/snapdom/tree/perf/v3-r8-p1-lazy-current) | 2186eeb | ci(r8): fix absolute P1 baseline path on Actions |
| [perf/v3-r8-pwh1-current](https://github.com/thelabcorner/snapdom/tree/perf/v3-r8-pwh1-current) | 06c5f83 | docs(r8): record clean GHA PWH1 null verdict |
| [perf/v3-r9-calibration-rerun-fix](https://github.com/thelabcorner/snapdom/tree/perf/v3-r9-calibration-rerun-fix) | 3a6007f | ci(r9): make calibration artifacts retry-stable |
| [perf/v3-r9-gha-bench](https://github.com/thelabcorner/snapdom/tree/perf/v3-r9-gha-bench) | 8c60647 | perf(r9): settle hosted runner before calibration gate |
| [perf/v3-r9-governor-v2](https://github.com/thelabcorner/snapdom/tree/perf/v3-r9-governor-v2) | 4cb6a90 | fix(r9): allow prepared provenance across failed-job retries |
| [perf/v3-r9-topology-challenge](https://github.com/thelabcorner/snapdom/tree/perf/v3-r9-topology-challenge) | 8d68475 | test(r9): preregister topology replacement decision |
| [perf/v3-r10-animation-scope](https://github.com/thelabcorner/snapdom/tree/perf/v3-r10-animation-scope) | 19ed994 | test(r10): model shadow animations as scanner-boundary controls |
| [perf/v3-r10-asset-frontier](https://github.com/thelabcorner/snapdom/tree/perf/v3-r10-asset-frontier) | 2744bd9 | test(r10): use CDP process membership for PSS |
| [perf/v3-r10-icon-memo](https://github.com/thelabcorner/snapdom/tree/perf/v3-r10-icon-memo) | c235e8e | ci(r10): harden icon ceiling evidence lane |
| [perf/v3-r10-shadow-identity](https://github.com/thelabcorner/snapdom/tree/perf/v3-r10-shadow-identity) | b13a7ef | ci(r10): repair F4 artifact materialization and stage ownership |
| [perf/v3-r11-fidelity-gate](https://github.com/thelabcorner/snapdom/tree/perf/v3-r11-fidelity-gate) | f513db5 | test(r11): catch percent-encoded missing-image sources in raw fidelity guard |
| [perf/v3-r12-bitmap-pss](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-bitmap-pss) | 7c845ec | ci(r12): repeat immutable PSS confirmation after heterogeneous runner-image rollout |
| [perf/v3-r12-decoded-bitmap-scout](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-decoded-bitmap-scout) | ce135fb | ci(r12): include vendored R10 benchmark generator in hosted workflow path gate |
| [perf/v3-r12-fidelity-gate](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-fidelity-gate) | 4504f46 | test(r12): match first generated scale step label in adversarial fixture |
| [perf/v3-r12-pss-cohort-confirmation](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-pss-cohort-confirmation) | 74c8a16 | docs(r12): record accepted eight-image-cohort timing and native PSS measurements |
| [perf/v3-r12-pss-stratified-review](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-pss-stratified-review) | 3b2918d | research(r12): preserve fail-closed PSS verdict and review split runner-image cohorts |
| [perf/v3-r12-pss-verification-retry](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-pss-verification-retry) | 62c4362 | test(r12-pss): allow SHA-hashed dedicated retry workflow in provenance guard |
| [perf/v3-r12-svg-header-fastpath](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-svg-header-fastpath) | cac07a4 | test(r12): add pinned two-build cross-engine public scaled SVG export crossover |
| [perf/v3-r12-worker-bitmap-reuse](https://github.com/thelabcorner/snapdom/tree/perf/v3-r12-worker-bitmap-reuse) | 1a4fb92 | perf(r12): prototype bounded sticky-worker ImageBitmap reuse and hosted A/B experiment |
| [perf/v3-r13-raster-header-clamp](https://github.com/thelabcorner/snapdom/tree/perf/v3-r13-raster-header-clamp) | 6a17477 | style(r13): correct warning literal escaping for ESLint |
| [perf/v3-r13-singleflight-bitmap-decode](https://github.com/thelabcorner/snapdom/tree/perf/v3-r13-singleflight-bitmap-decode) | 2d27ad4 | ci(r13): aggregate six hosted Worker trials, fail closed on mixed runner images |
| [perf/v3-r13-singleflight-capture-bench](https://github.com/thelabcorner/snapdom/tree/perf/v3-r13-singleflight-capture-bench) | 14b8a09 | bench(r13): fail-closed paired end-to-end capture inference with negative-control contrasts |
| [perf/v3-r13-singleflight-cold-capture](https://github.com/thelabcorner/snapdom/tree/perf/v3-r13-singleflight-cold-capture) | a2c7bb2 | ci(r13): cold decoded-bitmap gate with Blob memo priming and end-to-end captures |
| [perf/v3-r13-singleflight-fidelity-gate](https://github.com/thelabcorner/snapdom/tree/perf/v3-r13-singleflight-fidelity-gate) | a46d07d | test(r13): enforce branch-specific fidelity workflow provenance |
| [perf/v3-r14-safari-header-scan](https://github.com/thelabcorner/snapdom/tree/perf/v3-r14-safari-header-scan) | 75be60c | style(r14): ensure helper source ends in newline |
| [perf/v3-r15-svg-image-memo](https://github.com/thelabcorner/snapdom/tree/perf/v3-r15-svg-image-memo) | febfbf3 | fix(r15-pss): resolve Chromium browser PID via CDP rather than Puppeteer-only API |
| [perf/v3-r16-background-selector-frontier](https://github.com/thelabcorner/snapdom/tree/perf/v3-r16-background-selector-frontier) | a83784f | docs(r16): reject selector frontier on dense-background regression and host heterogeneity |
| [perf/v3-r16-svg-two-hit-admission](https://github.com/thelabcorner/snapdom/tree/perf/v3-r16-svg-two-hit-admission) | 67ad338 | ci(r16): run cache contracts after browser install instead of missing chromium binary |
| [perf/v3-r17-concurrent-asset-compression](https://github.com/thelabcorner/snapdom/tree/perf/v3-r17-concurrent-asset-compression) | 6e71062 | docs(r17): record hosted no-acceptance and WebKit null-arm variance |
| [perf/v3-r17-image-pss-review](https://github.com/thelabcorner/snapdom/tree/perf/v3-r17-image-pss-review) | f15c06e | fix(r17-pss): spawn own Chromium PID and attach over public CDP instead of invalid Browser.process |
| [perf/v3-r17-image-workqueue](https://github.com/thelabcorner/snapdom/tree/perf/v3-r17-image-workqueue) | 5261af4 | fix(r17-bench): demand the public named snapdom ESM export |
| [perf/v3-r17-three-engine-parity](https://github.com/thelabcorner/snapdom/tree/perf/v3-r17-three-engine-parity) | 016b17f | docs(r17): record scoped latency win, full three-engine parity, and memory tradeoff |
| [perf/v3-r17-webkit-aa-control](https://github.com/thelabcorner/snapdom/tree/perf/v3-r17-webkit-aa-control) | 6139023 | ci(r17): compare identical WebKit SVG render in shared HTTP-cache context |
| [perf/v3-r18-font-cross-engine](https://github.com/thelabcorner/snapdom/tree/perf/v3-r18-font-cross-engine) | 9506b5e | ci(r18): require raw and pixel parity on 120 frozen pairs in three browsers |
| [perf/v3-r18-font-memory-review](https://github.com/thelabcorner/snapdom/tree/perf/v3-r18-font-memory-review) | 96c2ad1 | test(r18-pss): reject wrong-schema memory runner artifacts |
| [perf/v3-r18-font-variant-memo-scout](https://github.com/thelabcorner/snapdom/tree/perf/v3-r18-font-variant-memo-scout) | 8cf8a2d | ci(r18): decouple hosted paired benchmarking from slow independent browser installs |
| [perf/v3-r19-svg-serialization-scan](https://github.com/thelabcorner/snapdom/tree/perf/v3-r19-svg-serialization-scan) | e9f9994 | docs(r19): reject SVG scanner after mixed hosted capture results |
| [perf/v3-r20-ancestor-universe-memo](https://github.com/thelabcorner/snapdom/tree/perf/v3-r20-ancestor-universe-memo) | f1259ab | test(r20): add 12-independent-host cross-engine timing confirmation |
| [perf/v3-r21-ancestor-acceptance](https://github.com/thelabcorner/snapdom/tree/perf/v3-r21-ancestor-acceptance) | 6fcd49e | test(r21): maintain foreground hover state for each browser comparison |
| [perf/v3-r22-ancestor-memory-confirm](https://github.com/thelabcorner/snapdom/tree/perf/v3-r22-ancestor-memory-confirm) | 2b7e055 | test(r22): preregister homogeneous image memory cohort and same-source null |
| [perf/v3-r23-ancestor-memory-null](https://github.com/thelabcorner/snapdom/tree/perf/v3-r23-ancestor-memory-null) | d7668a2 | test(r23): remove positional bias with balanced same-source null pairs |
| [perf/v3-release-integration-ledger](https://github.com/thelabcorner/snapdom/tree/perf/v3-release-integration-ledger) | b8315f2 | docs(v3): register R17 image-workqueue six-runner native-memory review and non-promotion |
