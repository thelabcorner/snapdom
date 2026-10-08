# R12 decoded-bitmap PSS — preregistered metadata-only image-cohort trial

**Study classification:** NEW, independent prospective hosted measurement design. Never retroactively applies to runs 37741929350 or 37746418740, which remain `INCOMPLETE_EVIDENCE`.

## Immutable treatments

- Candidate: `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b` (R12 decoded ImageBitmap cache).
- Baseline: `d391556b80be7a6d97bc4834d2ce6e24137515b2` (AS-BLOB v2).
- No production-source edits. Source SHA and compiled bundle SHA verified in prepare + every runner.
- Original R10/R12 five conditions, AB/BA acquisition, independent browser-process PSS, CDP process membership and /proc proportional memory + warm/sweep settle rules retained.

## New sampling contract — fixed BEFORE GitHub Actions run

1. Acquire **12 independent fresh GitHub-hosted Ubuntu 24.04 runners** identified 0…11. Do not stop or retry based on any numerical outcome.
2. Validate **all 12 complete runner artifacts** for provenance, identities, exact bundle/fixture digests, per-condition sample counts, finite timing/PSS states, and stable process PIDs before cohort selection.
3. Group runners by exact runner image `imageOs@imageVersion`, without examining any timing or memory value.
4. Require a homogeneous stratum with at least **six** unique runner IDs. Select the stratum with the **largest count**; break count ties by lexicographically greatest runner image identity (newest revision if standardized naming). Include *all* runners in the selected stratum, not just the most favorable six.
5. Exclude all other-image points from the **primary** summary while retaining their raw artifacts/IDs and reporting their count/image version. No outcomes are consulted during selection, and excluded data are never erased.
6. If no homogeneous stratum has >=6 valid runners, or any original artifact/provenance/integrity check fails, output `INCOMPLETE_EVIDENCE` and make no numeric acceptance claim. A complete 12-runner batch with 2 revisions guarantees >=6 for one revision; 3+ revisions may still fail.
7. Compute the original Student-t runner-level timing and PSS estimates over selected homogeneous runner effects (not per-sample pseudo-replication); primary PSS includes retention, warm/sweep and matched worker-blocked negative control. Supply 95% confidence intervals and full runner points.
8. This remains `EVIDENCE_ONLY_NO_PROMOTION` without separately preregistered memory budget, explicit tradeoff decision and combined integration tests. If accepted, it establishes observational memory impact **conditional on that exact runner image revision**, not an image-independent effect.

The acquisition and aggregator code that implements these eight conditions is part of the commit SHA frozen *before* any 12-runner measurement begins. The original six-runner studies and their failed conclusions remain unchanged. Tests must exercise mixed host identities, tie-breaks, missing runners, malformed provenance and incomplete evidence.

## Prospective study outcome — COMPLETE, cohort-specific

[GitHub Actions run 37747198712](https://github.com/thelabcorner/snapdom/actions/runs/37747198712) executed the preregistered 12-runner study, passing all frozen source/build/provenance, collection, and aggregate gates. Final summary state is `EXPERIMENT_COMPLETE_IMAGE_COHORT`, `complete:true`, `performanceClaim:false`. The exact metadata-only rule selected all eight runners from `ubuntu24@20260927.320.1` (IDs 0,1,2,4,6,7,8,11); excluded four `ubuntu24@20261004.327.1` runners (IDs 3,5,9,10), whose source-identical raw evidence remains retained. Chromium version `140.0.7339.186`.

| Predefined condition | Capture difference | 95% CI | Warm retention candidate−baseline (KiB) | 95% CI KiB | Total post-sweep difference (KiB) / CI |
| --- | ---: | --- | ---: | --- | --- |
| large-same | −0.20% | [−5.68%, +5.61%] | +5065.5 | [+3357.6,+6773.4] | +4113.5 / [+1776.2,+6450.8] |
| large-scale | **−25.50%** | **[−27.52%,−23.42%]** | **+4698.25** | **[+3713.77,+5682.73]** | +4050.4 / [+604.5,+7496.2] |
| large-width | **−28.12%** | **[−29.82%,−26.38%]** | **+3922.38** | **[+2250.43,+5594.32]** | +1403.3 / [−1356.0,+4162.5] |
| small-scale | −0.34% | [−3.48%,+2.91%] | +331 | [−1009.7,+1671.7] | +298.8 / [−890.8,+1488.3] |
| large-csp | −2.64% | [−11.19%,+6.72%] | −912.4 | [−3125.6,+1300.8] | +2884.4 / [−3330.0,+9098.8] |

**Decision:** accepted prospective homogeneous-host **memory and timing measurement evidence**. Large-image warm retention is significantly positive (~3.8–4.6 MiB); source optimization is a latency-for-memory tradeoff, **not memory Pareto dominance**. Small-image and CSP controls have no statistically established warm-retention increase. This study does not itself set the product's memory budget, certify high-cardinality churn/leaks, or promote the branch to main.
