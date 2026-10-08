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
