# R22 — preregistered native-memory confirmation for R20

The R20 ancestor-universe memo has already shown per-engine exact-output parity and replicated fresh-style acceleration. R21's first process-family PSS run revealed mixed GitHub Ubuntu-image revisions and substantial process-order noise. Its pooled six-host memory aggregator is not an acceptable production inference.

## Frozen provenance

- Immutable pre-R20 oracle: `cac07a4108086718bc9511663346e1b9fcf4e226`.
- R20 optimized source: `f1259ab411890f8c0a10d5a35b83ef5ec5c56e04`.
- R22 test-only branch: `perf/v3-r22-ancestor-memory-confirm`. No changes to `src/`.
- R21 browser-fidelity follow-up runs separately; memory evidence alone does not certify release.

## Preregistered design

1. Acquire all twelve independent Ubuntu-24.04 Chromium hosts, each running two isolated-browser baseline/candidate pairs in AB and BA order. Do not stop early or choose hosts by measured PSS.
2. Each host independently runs a baseline-vs-baseline native-memory null, with an identical deterministic HTML, CSS, and 36-capture invalidated-style workload.
3. Record `ImageOS` and `ImageVersion` before analysing memory contrasts. *After* verifying every host record, select the largest runner-image cohort strictly by image identity/count. Lexical tie-break. Require at least six independent runners in that identity group, otherwise `INCOMPLETE_EVIDENCE`.
4. Preserve and publish all included and excluded host IDs and image identities. Never post-hoc pool distinct GitHub image versions.
5. Each host contributes one AB/BA-averaged candidate-baseline PSS point and one A/A null. Compute 95% cluster-bootstrap intervals over independent hosts; 20,000 seeded resamples. Subcaptures are **not** independent samples.
6. The memory probe measures process-set and renderer proportional set size using Linux `/proc/<pid>/smaps_rollup`, after several forced browser GC passes; independently launched process families prevent A/B bundle contamination. Retained PSS after a unique-state sweep and additional warmed-to-swept PSS are separate quantities.
7. Require exact raw SVG SHA equality at paired checkpoints, real candidate ancestor-memo engagement, pinned baseline/source SHA, complete AB/BA evidence, nonfinite-value rejection, and source identity validation.
8. If same-source null confidence intervals exclude zero, or null uncertainty dominates candidate effects, flag `SAME_SOURCE_NOISE_REQUIRES_REVIEW`, not a memory acceptance.
9. Do not automatically promote any R20 patch from this workflow: a passing workflow is evidence acquisition, and an explicit byte/memory budget and broad application fidelity evaluation are still required.

## Interpretation

An R22 verdict is scoped to forced-invalidated, synthetic nested CSS DOMs, Chromium on Linux, and the selected GitHub runner image. It is not evidence of global memory reductions in Firefox, WebKit, all websites, or ordinary warm captures. R20's source behavior remains frozen for comparable evaluation.
