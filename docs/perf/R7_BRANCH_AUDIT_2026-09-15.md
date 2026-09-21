# SnapDOM v3 performance branch audit — 2026-09-15

This document records the local/remote preservation state of the v3 performance campaign.
It is an archive/navigation aid, **not** a promotion or PR-readiness list.

## Remote safety

- Fork remote: `origin = https://github.com/thelabcorner/snapdom.git`
- Upstream/Juan remote: `upstream = https://github.com/zumerlab/snapdom.git`
- All publication in this audit targets `origin` only.
- `origin/main` was fast-forwarded from the pre-v3 fork state to current upstream v3.0.0 lineage at `6eb730c50713`.
- No force push was used.
- The frozen scientific v3 release baseline remains `4efcb59e12363c05d7f15d425db0c267a46fae0a`.
- The corrected R7 comparison parent remains `456ca8f41f8887dafe19a5d92858ffc1b205f5b7`.

## Current integration frontier

`perf/v3-r7-style-authority-integration` is the current research-integration branch. It contains the
style-authority work plus later independently switchable research mechanisms, their tests, the R5/R7
iteration ledger, and the `probe-r7-*` deterministic research harnesses.

Important: this branch is **not** a proposed mega-PR. It exists to study interactions and the residual
frontier while individual mechanisms retain separate counterfactuals and, where useful, isolated branches.

Current integrated mechanism families include:

- SA1/SA2/SA4 style-authority handoff work and conditional SA3/SA5 interaction evidence;
- PC1 pseudo counter/content CSE;
- SA6 asset style authority;
- BRST1/2/3 semantic scroll pipeline;
- BSAFE1/2 memo-hit safety fast paths;
- PQU1 UA-q pseudo admission split;
- ANIMR1 animation-name identity rider;
- LCG1 line-clamp pass admission;
- OFF1 static-position inset rider narrowing;
- BGS1/BGS2 late background source admission;
- TXT1/TXT2 research arms retained only for falsification/reproduction; both are rejected for production.

## R7 lane interpretation

### Active / continue to clean timing

| Mechanism | Branch | Notes |
|---|---|---|
| SO1 snapshot overlays | `perf/v3-r7-overlay-gutterfix` | Strong retained-memory result; wall acceptance still blocked by host noise. |
| FP1 focus partition | `perf/v3-r7-focus-partition` | Narrow focus-only state partition; strong deterministic work deletion. |
| GR1 gutter snapshot reuse | `perf/v3-r7-gutter-snapshot-reuse` | Exact-property same-node CSE; targeted scrollbar workloads justify timing. |
| MW1 min-width reuse | `perf/v3-r7-minwidth-snapshot-reuse` | Narrow flex/grid CSE. |
| clean P1 pseudo overlay/key reuse | `perf/v3-r7-pseudo-overlay-clean` | Use this branch, not the older contaminated pseudo-overlay lane, for future acceptance. |
| PC1 pseudo counter/content CSE | `perf/v3-r7-pseudo-content-cse` | Independent pseudo JS-work reduction. |
| SA1 style acquisition CSE | `perf/v3-r7-style-acquisition-cse` | First handoff leg. |
| SA2 style-cache handoff | `perf/v3-r7-style-cache-handoff` | Higher-leverage phase-shared style authority. |
| SA4 backdrop style reuse | `perf/v3-r7-backdrop-style-reuse` | Independently causal late consumer. |
| Integrated residual frontier | `perf/v3-r7-style-authority-integration` | Interaction research and post-SA/BRST/OFF/BGS frontier. |

### Rejected / negative / interaction-only evidence

| Mechanism | Branch | Status |
|---|---|---|
| BR1 border normalization | `perf/v3-r7-border-normalize-reuse` | Rejected: too little whole-capture work removed. |
| SA3 parent style reuse | `perf/v3-r7-parent-style-reuse` | Standalone reject: shifts a global memo miss; positive only with SA4. |
| SA5 pseudo host style reuse | `perf/v3-r7-pseudo-host-style-reuse` | Standalone reject: interaction-only after SA4. |
| old pseudo overlay | `perf/v3-r7-pseudo-overlay` | Superseded by `pseudo-overlay-clean`; old lane is scientifically contaminated by PC1. |
| snapshot probe | `perf/v3-r7-snapshot-probe` | Instrumentation/probe branch, not a product candidate. |
| integration scout | `perf/v3-r7-integration-scout` | Earlier interaction scout, superseded by the current integration frontier. |

Other R7 branches remain preserved because they document intermediate representations, interaction work,
or falsified hypotheses. See `lane6-scratch/r5/R5_ITERATION_LEDGER.md` for the verdict attached to each mechanism.

## Foundational R2–R6 research

All local `perf/v3-r2-*`, `perf/v3-r3-*`, `perf/v3-r4-*`, `perf/v3-r5-*`, and `perf/v3-r6-*`
branches are also published to the fork. Several are deliberately obsolete or superseded; they are retained
because the campaign relies on their negative results, causal probes, and selector/style-router history.

## Full published v3 branch inventory

All entries below exist on `origin` at the same commit as the local branch at the time of this audit.

```text
perf/v3-assets-cache 5a363bc
perf/v3-attr-share-key 5a363bc
perf/v3-frontier f54812b
perf/v3-frontier-clean fb212ab
perf/v3-r2-clean 7c0fcc4
perf/v3-r2-style-share f54812b
perf/v3-r3-universe 1fcd784
perf/v3-r4-frontier fdc3064
perf/v3-r5-attr-rule-index d8b355e
perf/v3-r5-attr-value-index 8d10f69
perf/v3-r5-auto-margin-gate 456ca8f
perf/v3-r5-burst-retained-scroll 3cfecb2
perf/v3-r5-burst-scroll 3cfecb2
perf/v3-r5-clone-overhead 7c14bb4
perf/v3-r5-cssvar-precheck 79b3a3c
perf/v3-r5-d-su 094c1d3
perf/v3-r5-general-key-planner 18e1afb
perf/v3-r5-multikey-selectivity 56da132
perf/v3-r5-pseudo-candidates 3cfecb2
perf/v3-r5-rule-index 5166cc7
perf/v3-r5-scroll-node-map-reuse f74d60b
perf/v3-r5-selector-cse 7f639d9
perf/v3-r5-session-snapshot-handoff ea36cc5
perf/v3-r5-share-universe 3897222
perf/v3-r5-style-sig-gutter 277a275
perf/v3-r5-style-sig-gutter-d6 b56daff
perf/v3-r6-scroll-observation-reuse e4a6432
perf/v3-r6-scroll-reuse-sm2 3899958
perf/v3-r7-backdrop-style-reuse 301ed2d
perf/v3-r7-border-normalize-reuse ea07b0c
perf/v3-r7-focus-partition a047f45
perf/v3-r7-gutter-snapshot-reuse 85ace8d
perf/v3-r7-integration-scout 85f38bf
perf/v3-r7-minwidth-snapshot-reuse 7ff44bb
perf/v3-r7-overlay-gutterfix 356f3c1
perf/v3-r7-overlay-sm2-lazy 7a47572
perf/v3-r7-parent-style-reuse d395b3d
perf/v3-r7-pseudo-content-cse 40c2d28
perf/v3-r7-pseudo-host-style-reuse eda8862
perf/v3-r7-pseudo-local-cse 456ca8f
perf/v3-r7-pseudo-overlay 9fdd822
perf/v3-r7-pseudo-overlay-clean 1495130
perf/v3-r7-snapshot-overlay 844fe50
perf/v3-r7-snapshot-overlay-sm2 52c3f1e
perf/v3-r7-snapshot-probe 670862b
perf/v3-r7-style-acquisition-cse 330aca1
perf/v3-r7-style-authority-integration 790b0f3
perf/v3-r7-style-cache-handoff 825c138
```

## Exclusions from automatic archival commits

- Detached immutable v3 baselines were left untouched.
- The detached v2-stable worktree was left untouched.
- The primary `perf/juan-ready` working directory still contains unrelated local dirty/untracked research state.
  Its committed branch tip is published to `origin`, but this audit intentionally did **not** sweep its nested
  worktrees/temp folders into a synthetic commit.

## Publication policy

Publishing a branch means only that its research state is preserved on the fork. Promotion still requires the
campaign acceptance policy: exact output parity, adversarial correctness, mechanism causality, and clean controlled
wall timing where wall performance is part of the claim. Counter reductions alone are not product-speed claims.
