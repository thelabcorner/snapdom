# R12 decoded-bitmap cache — stratified native PSS review

**Evidence source:** GitHub-hosted `snapDOM R12 decoded-bitmap process-PSS confirmation`, run [#37741929350](https://github.com/thelabcorner/snapdom/actions/runs/37741929350). All six runner artifacts have been retrieved and inspected directly. This review intentionally does **not** change the original aggregate's `INCOMPLETE_EVIDENCE` verdict: its six-host homogeneity criterion was not met.

## Immutable provenance

- R12 decoded-ImageBitmap candidate: `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b`.
- R10 AS-BLOB baseline: `d391556b80be7a6d97bc4834d2ce6e24137515b2`.
- Measurement commit: `7c845ecea2e49d99c3e6bc85ba4d28fdcc77488e`.
- Every runner retained these exact identities and the same frozen bundle hashes. Chromium version `140.0.7339.186`; Node `22.21.1`.
- For each of five conditions, each of six runners recorded an isolated baseline and candidate Chromium process set, sampling initial, warmed and final states through `/proc/*/smaps_rollup`. All **60** baseline/candidate memory sequences reported stable initial, warmed and final settle windows.

## Reason aggregate rejected

The runner provisioner supplied two different Ubuntu 24.04 image revisions in equal numbers:

| Runner replicates | Ubuntu image version |
| --- | --- |
| r0, r4, r5 | `20260927.320.1` |
| r1, r2, r3 | `20261004.327.1` |

The original R10-style aggregator requires one homogeneous six-runner image and correctly rejected cross-image pooling. Do not discard or rewrite this requirement after seeing results; preserve the original rejection and label the following analysis exploratory, stratified and retrospective.

## Native process-set PSS differences

Values are **candidate minus baseline**, MiB. Reported for each three-host image cohort as the median of independent hosted-runner paired measurements. Warm retention is relative initial-to-warmed increase; total is relative initial-to-final increase, **not** absolute final process memory.

| Condition | 20260927 warm retention | 20261004 warm retention | 20260927 total increase | 20261004 total increase |
| --- | ---: | ---: | ---: | ---: |
| large-same (null-memo) | +2.84 | +5.82 | +0.49 | +9.72 |
| large-scale (claimed mechanism) | +4.01 | +6.18 | +0.86 | +4.00 |
| large-width (claimed mechanism) | +3.47 | +3.38 | −1.02 | +3.61 |
| small-scale (small-negative) | +0.81 | −0.42 | +0.37 | −0.69 |
| large-csp (worker-negative) | +0.37 | +0.84 | −0.71 | +1.00 |

Large-scale per-runner final-total deltas:
- older-image r0 +1.59 MiB, r4 −3.57 MiB, r5 +0.86 MiB;
- newer-image r1 +5.38 MiB, r2 +1.68 MiB, r3 +4.00 MiB.

Large-width per-runner final-total deltas:
- older-image r0 −2.20 MiB, r4 −1.02 MiB, r5 +0.33 MiB;
- newer-image r1 −1.72 MiB, r2 +12.99 MiB, r3 +3.61 MiB.

All figures retain the exact fixture, PSS, engine-version and process-membership telemetry in each original GitHub runner artifact. Comparisons were *within the same hosted runner*; the two image-version strata are **not** combined for a confidence interval.

## Interpretation and action

R12's native memory does **not** display an obvious monotonic catastrophic leak in these observations, and the claimed image-geometry change arms suggest roughly a few extra MiB of warm retention for the optimized worker-bitmap path. However, controls also show nontrivial noise, individual total-PSS deltas sometimes exceed 10 MiB, and cohort size is only three. Neither equivalence nor a non-regression bound is established.

The performance speedup and three-engine fidelity success are separately measured; this retrospective report does not override the original memory gate. Close R12 memory acceptance by either (a) repeating the pre-registered homogeneous six-host run once provisioner images converge, or (b) pre-registering a new explicitly stratified or within-run paired PSS criterion **before** collecting new samples. Do not merge an acceptance gate rewrite with source optimization.

**State: STRATIFIED_OBSERVATIONS_ONLY; R12_MEMORY_ACCEPTED = false.**
