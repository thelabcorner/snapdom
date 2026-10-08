# snapDOM v3 — Release/reconciliation gate (2026-10-08)

**Purpose:** a collaborative fail-closed integration register, not a declaration that experimental branches are production-ready.

## Freeze and provenance

- R10 AS-BLOB original measured mechanism: `d391556b80be7a6d97bc4834d2ce6e24137515b2`.
- R11 cross-engine raw+RGBA fidelity acceptance: [run 37738858455](https://github.com/thelabcorner/snapdom/actions/runs/37738858455), **accepted**.
- R12 ImageBitmap decoded-reuse mechanism: `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b`.
- R12 Chromium six-runner paired effect vs R10: large-scale capture **−29.28%**, large-width **−25.64%**, [run 37739851567](https://github.com/thelabcorner/snapdom/actions/runs/37739851567). Not a global whole-library claim.
- R12 three-browser exact-output fidelity: [run 37741332761](https://github.com/thelabcorner/snapdom/actions/runs/37741332761), **accepted**.
- Main vs R12 branch: diverged (as audited 2026-10-08), **56 ahead / 9 behind**, not fast-forwardable. Do not merge mechanism and baseline-only harness modifications together without review.

## Workstream decision matrix

| Priority | Mechanism | Current evidence | Outstanding release gate |
| --- | --- | --- | --- |
| P0 | R12 decoded-bitmap cache | Chromium paired speed + three-engine byte/pixel parity accepted | R12 native PSS **NOT ACCEPTED**; [six-runner heterogeneous result](https://github.com/thelabcorner/snapdom/actions/runs/37741929350), 3 older and 3 newer Ubuntu images. [Stratified review](https://github.com/thelabcorner/snapdom/blob/perf/v3-r12-pss-stratified-review/lane6-scratch/r12/R12_STRATIFIED_MEMORY_REVIEW.md) is observational. |
| P0 | R13 single-flight bitmap decode | Three-engine fidelity [pass](https://github.com/thelabcorner/snapdom/actions/runs/37742909995). Controlled Worker micro measurements suggest concurrency-specific wins, but run mixed hosted-image cohorts. | Repeat preregistered **end-to-end** timing under homogeneous or predeclared stratified policy; confirm worker scheduling and PSS, no one-image regression. |
| P1 | R12 exact SVG header fast path | [Cross-engine unit/pixel/build workflow pass](https://github.com/thelabcorner/snapdom/actions/runs/37740540543). | Reconcile SVG exports with raster clamping and Safari cases; production memory/complexity and real-capture gains. |
| P1 | R13 oversize raster clamp | [Cross-engine workflow pass](https://github.com/thelabcorner/snapdom/actions/runs/37741153484). | Confirm downstream export contracts, huge dimensions, refusal and error semantics when composed with header fastpath. |
| P1 | R14 Safari shadow header scan | [Cross-engine workflow failure](https://github.com/thelabcorner/snapdom/actions/runs/37741935379): WebKit shadow case. | Fix or retire; never bypass failing WebKit shadow parity. |
| P1 | R15 external SVG image memo | [Three browser contract jobs pass](https://github.com/thelabcorner/snapdom/actions/runs/37743618340). [Native PSS evidence collected](https://github.com/thelabcorner/snapdom/actions/runs/37744482998); aggregate explicitly says `memoryPromotionAccepted:false`. | Six-runner capture CI homogeneous criterion failed due host images. Repreregister, rerun; review bounded retained string memory and untrusted-proxy/relative-URL controls. |
| P1 | R16 native candidate filtering of backgrounds | Isolated branch `perf/v3-r16-background-selector-frontier`, [hosted A/B + fidelity](https://github.com/thelabcorner/snapdom/actions/runs/37745225552). | Full 6-host verdict, per-engine parity, dense regression, memory. No accepted performance claim at document creation. |
| P0 | Integration with main | No final reconciled release candidate. | Classify exact source diffs, resolve divergence, compile all consumer bundles, run complete browser suites and frozen perf baselines, then release review. |

## Protocol: actions before promotion

1. **Do not post-hoc pool** run results from Ubuntu image revisions `20260927.320.1` and `20261004.327.1` under the original homogeneous six-host contract. Preserve `INCOMPLETE_EVIDENCE` and the raw artifacts. For a new design, preregister host-stratified analysis before acquisition, or await convergence and use six homogeneous fresh runners.
2. For memory, measure process-set proportional set size via CDP-owned process membership and Linux `/proc/*/smaps_rollup`; require stable PID:starttime, warmed and post-sweep readings, negative controls, matched baseline/candidate measurement and explicit memory budget.
3. For fidelity, require **exact raw SVG string/byte comparison and exact rendered RGBA hashes** on Chromium, Firefox and WebKit. Cover no-worker/CSP, same geometry, changed geometry, corruption, failure/fallback, SVG/xlink, gradients, transforms, shadow, raster oversize, and mixed-media/text fixtures.
4. For timing, make distinct claims for throughput, capture latency, capture+render latency, hot vs cold, memory and byte footprint. Pair AB/BA on fresh GitHub-hosted runners; report 95% runner-level confidence intervals and no claim if the interval crosses zero or the required noise gate fails.
5. Performance regression controls: no-cache, nonmatching content, single image, multi-image gallery/affinity, heavy CSS, document root, same-image and unique-source churn.
6. Integration must be its own branch. Rebase or merge the frozen provenance lineage carefully; validate with the **combined** mechanisms switched on, including cache invalidation, JS worker-pool teardown, and differential captures. Retest release artifacts against the current `main` plus relevant upstream changes.
7. Do not merge test-harness-only acceptance patches as if they were production-source speedups. Avoid replacing existing R11/R12 source identities with benchmark-runner heads.
8. Reject any mechanism that compromises fidelity or bounded failure semantics even when its microbenchmark is unusually fast. Preserve parallel owner branches and dirty worktrees.

## Next engineering order

P0: R12 process PSS rerun/repreregistration → R13 end-to-end experimental timing gate → R13 native memory → integration branch.

P1: R15 joined capture/memory interpretation, R14 WebKit shadow discrepancy (fix or retire), R12 SVG header + R13 clamp composition, R16 full-capture timing.

P2: New frontier research on compression candidate indexing, capture-session asset registry, clone/style traversal count, serialization, Worker fairness and retained-memory cleanup. Any new code requires independent preregistered falsification and exact fidelity gate.

This ledger deliberately contains unaccepted experiments for coordination; it should be updated after new evidence rather than retroactively declaring success.

## Update — R16 experiment resolved: rejected

[Completed run #37745225552](https://github.com/thelabcorner/snapdom/actions/runs/37745225552) passed all source preparation, 3 browser fidelity and six Chromium timing runner jobs. The aggregate reports **`NO_TIMING_ACCEPTANCE`**, and its substantive verdict supersedes any inference from green job badges. The no-background effect was −1.99% (95% CI [−4.85%, +0.97%]); sparse-background +0.12% (CI [−6.38%, +7.07%]); **dense-background +3.18% slower (CI [+2.12%, +4.25%])**. Runner images were heterogeneous, another independent invalidation of homogeneous timing acceptance. **Do not promote R16's source patch**. Experimental source is retained only on `perf/v3-r16-background-selector-frontier`; no production branch changed.

## Update — R17 parallel compression experiment is unaccepted

Source branch: `perf/v3-r17-concurrent-asset-compression`; independent [hosted trial 37746367847](https://github.com/thelabcorner/snapdom/actions/runs/37746367847). Six Chromium runner jobs, Chromium and Firefox fidelity success. WebKit compressed fixtures passed but `compress:false` null fixture exhibited mismatched rendered RGBA hashes despite equal raw output. Mixed HTML/CSS/SVG capture effect −6.05% with 95% runner interval [−13.17%, +1.65%], plus split Ubuntu image revisions, means no official speedup or completed cross-engine fidelity acceptance. **Keep isolated; no promotion** until revised preregistered experiment with WebKit A/A self-null and homogeneous-host criteria, memory and integration checks.

## Update — R12 native-memory evidence acquisition and R14 exact failure

The original six-runner R12 PSS run [37741929350](https://github.com/thelabcorner/snapdom/actions/runs/37741929350) and an unchanged-policy fresh retry [37746418740](https://github.com/thelabcorner/snapdom/actions/runs/37746418740) both report **INCOMPLETE_EVIDENCE**, solely from heterogeneous Ubuntu hosted-image identities. All six retry measurement jobs completed and exact candidate/base provenance validated. Do **not** pool across revisions or relabel those runs.

A **new, prospectively preregistered** twelve-runner experiment [37747198712](https://github.com/thelabcorner/snapdom/actions/runs/37747198712) lives on `perf/v3-r12-pss-cohort-confirmation`, with original source mechanisms frozen and an explicit metadata-only homogeneous image stratum: retain all 12 runner artifacts, validate every one, choose largest image stratum with >=6 runners before looking at memory values, report excluded IDs and image identity. This avoids post-hoc cherry-picking. Results remain unaccepted until the aggregator completes. No source promotion is permitted by this workflow.

R14 Safari failure root is more specific than generic WebKit CI red: `__tests__/exporter.safariPaths.test.js` fails `shadow keeps its live orientation (below the box) in the scaled vector output`; expected blue shadow channel >200 below the element was not observed. See [run 37741935379](https://github.com/thelabcorner/snapdom/actions/runs/37741935379). It is a required pixel-fidelity blocker; avoid weakening the assertion absent cross-engine geometry evidence.

R17 separate same-source, same-bundle WebKit A/A render-stability experiment [37747398010](https://github.com/thelabcorner/snapdom/actions/runs/37747398010) is isolated on `perf/v3-r17-webkit-aa-control` and is diagnostic only, not a retroactive way to bypass R17's failed `compress:false` rendered-pixel control.
