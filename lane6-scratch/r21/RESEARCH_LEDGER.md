# R21 — Ancestor universe production-acceptance scout

## Scope, provenance, and isolation

- Parent candidate: R20 `f1259ab411890f8c0a10d5a35b83ef5ec5c56e04` on `perf/v3-r20-ancestor-universe-memo`.
- Frozen pre-R20 oracle: `cac07a4108086718bc9511663346e1b9fcf4e226`.
- R21 branch: `perf/v3-r21-ancestor-acceptance`, separate worktree.
- The R21 commit MUST change no files under `src/` and MUST NOT be presented as a new performance optimization. It is an independent acceptance gate for the R20 optimization, which demonstrated scoped fresh-style throughput improvements.
- Host evidence: `.github/workflows/r21-ancestor-acceptance.yml`.

## Why R21 is necessary

R20's 12-host confirmation provided evidence of 10–15% capture acceleration on fresh deep-style trees and approximately 42% on ultra-deep synthetic stress. The speedup is **not** established for normal warm repeat captures: existing cross-capture snapshots short-circuit ancestor-universe evaluation. R20's isolated memory cost and broad mutation fidelity were not certified. WebKit's same-source A/A control also showed a nonzero positional timing effect, so any absolute WebKit speed claims require careful interpretation.

R21 tests *production acceptance*, not a new algorithm:

1. Cross-engine scenarios: deep inherited CSS, live CSSOM updates, attribute/inline/child mutations, hover pseudoclasses, Shadow DOM + slots, semantic UA-risk ancestors, and traversal crossing 1024 ancestors.
2. Each candidate capture explicitly requests fresh style snapshots and records memo-use telemetry. Stable-node cases must exercise the memo; risk/dynamic-selector cases may correctly veto it.
3. Every scenario compares separately compiled source revisions' exact raw SVG data URL and rendered RGBA SHA-256 digest, before and after mutations. A fixture with no effect at all must fail.
4. Native memory on **six independent hosted Linux Chromium runners**: candidate and baseline execute in separate browser process families. We sample total process-tree and renderer PSS using `/proc/<pid>/smaps_rollup`, including workers and GPU/utility processes.
5. Every memory runner uses balanced AB and BA order and two paired observations. The aggregator treats the runner, not individual capture or process sample, as the independent unit, reporting mean differences and cluster-bootstrap 95% intervals. Image/OS version and browser-launch differences remain relevant residual confounders.
6. Candidate `src/` is byte-identical to R20; no production code changes are authorized by this scout.

## Stop conditions and evidence contract

- Any baseline-vs-candidate SVG or pixel mismatch, unexercised memo in an eligible fixture, missing memory cohort, missing AB/BA arm, invalid pinned SHA, or tests/toolchain failure blocks promotion.
- No inference of memory *improvement* from an insignificant delta; PSS is primarily a leak/regression veto.
- A passing synthetic gate does **not** prove all public HTML/CSS combinations or all real websites are parity-safe. A general purpose release also needs real-application fixtures, font loading, iframe boundaries, and browser-version coverage.
- Do not merge R19 SVG serializer: it was rejected on public capture timings.
- R12 decoded-bitmap image caching is an independent performance mechanism; R21 results cannot be attributed to it.
- After hosted evidence, inspect per-engine failure artifacts and complete a manual release decision, documenting memory ceiling, fidelity and throughput before any integration.

## Implementation notes

`scripts/r21-ancestor-fidelity.mjs`: separate pages for baseline and candidate and exact raw plus RGBA gates for each mutation stage.

`scripts/r21-ancestor-pss.mjs`: separate Chromium processes for each arm; sample PSS after GC and before/after a 32-capture invalidation/mutation sweep. Checks deterministic source hashes and memo engagement.

`scripts/r21-ancestor-memory-aggregate.mjs`: runner-level bootstrap summaries with complete-cohort requirements.

**Current state:** experimental harness; do not claim R21 accepted until GitHub-hosted evidence is complete and inspected.
