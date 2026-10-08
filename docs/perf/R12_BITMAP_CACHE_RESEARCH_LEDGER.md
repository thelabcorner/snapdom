# R12: Sticky-worker decoded ImageBitmap reuse — experimental research ledger

**Status:** experimental worktree. No speedup or memory Pareto claim is accepted yet.
**Measurement baseline:** exact AS-BLOB v2 production SHA `d391556b80be7a6d97bc4834d2ce6e24137515b2`.
**Measurement candidate:** the SHA that triggers `perf/v3-r12-worker-bitmap-reuse`; frozen by GitHub Actions.
**Constraint:** browser timing, browser fidelity and PSS measurements only on public GitHub Actions runners.

## Mechanism hypothesis

R10 AS-BLOB avoids transferring/reconstructing multi-megabyte base64 strings on repeat captures with changed geometry, but the worker still decodes identical immutable source bytes with `createImageBitmap(blob)` on every target-size cache miss. R12 retains the decoded backing on the **same** worker, and reuses it for later target dimensions. Source identity is an object-identity `WeakMap<Blob, integer>` in the main thread. IDs route all requests for a Blob to one of at most four workers; one serialized job queue per worker prevents an evicted bitmap from being closed during an asynchronous draw.

The decoded bitmap cache is LRU with a **12 MiB decoded RGBA estimate per Worker** (up to 48 MiB in a four-worker pool), against the separately enforced 64 MiB *encoded sidecar* budget. The decoded estimate is nominal width × height × four bytes, not a measurement of GPU/OS resident memory. Worker crashes clear backing via termination. Oversized bitmaps, string-only payloads, decoding failures, and cache-disabled/cold conditions retain previous semantics. Cache-hit status is returned as a non-public worker diagnostic and intercepted by hosted Worker instrumentation.

This buys a possible reduction in repeated decoder work, but at the costs of increased renderer/worker memory, longer bitmap lifetime, an extra serial microtask, sticky-worker load imbalance, and retained GPU surfaces. Every one is a potentially binding bottleneck.

## Evidence already established locally (not browser performance)

- Eight browser-free VM tests: different-geometry same-source reuse; explicit positive bitmap-hit evidence; nonaliasing same-named but different Blobs; correct LRU/close when cap is exceeded; huge-image uncacheable path; unkeyed fallback; exception isolation; deterministic worker affinity.
- Inherited AS-BLOB mechanism proof and full TypeScript/lint/compile checks.
- Reused the R10 runner-level, six-VM, AB/BA order-balanced measurement architecture, preserving CPU environment governance, repeated-control arms, per-condition route proofs, worker Blob identity, captured raw paired samples and Chromium CDP `/proc/smaps_rollup` PSS acquisition.

## Pre-registered acceptance / rejection

1. **First mechanism falsification:** the candidate's positive changed-geometry captures must produce **one actual bitmap-cache-hit message** each and the baseline none. Both arms must still send the same fetched source Blob, with no worker errors. Same geometry, small image and CSP-negative paths must remain no-op.
2. **Timing gate:** six separate GitHub-hosted VM runner-level effects and balanced candidate-first/baseline-first strata; review per-runner and aggregate logs, not a single browser stopwatch. Use `large-scale`, `large-width` as primary mechanisms; `large-same`, `small-scale`, and `large-csp` as negative controls.
3. **Memory gate:** no adoption without examining candidate-minus-baseline process-set PSS and renderer PSS *both after warmup and after the geometry sweep*. The 12 MiB per-worker cap is a trial parameter, not a justified product memory budget.
4. **Fidelity gate:** R11's acceptance of AS-BLOB v2 does **not** validate R12. A separate exact raw/pixel equality gate across Chromium, Firefox, WebKit (source caches, eviction, fallback, CSP) is mandatory before any production merge. Keep this branch experimental until then.
5. **No guaranteed Pareto win:** if the added decoded backing materially inflates memory, throughput degrades for multi-image workloads, or speed improvements fall within hosted noise, abandon or selectively gate bitmap retention by source size/geometry likelihood instead of merging it.

## Additional threats to research

- The sticky mapping `(token-1)%POOL_SIZE` distributes unique source objects, not work durations: heavy sources can collide. A per-source stable allocation biased by outstanding job queue is a future experiment, **not** assumed better.
- A large image skipped by the cap still decodes every time. To test bigger images, vary cap explicitly against memory; never silently raise to hundreds of MiB.
- Same data bytes from distinct Blob objects do not reuse the bitmap; deliberate safety tradeoff avoids expensive hashes or unverified equality.
- A 5-second timeout returns to main-thread decoding while worker may finish later. When testing pathological sources, account for both timing and downstream bitmap lifecycle.
- Browser-specific ImageBitmap / OffscreenCanvas implementations and image color management may differ. Source-specific cross-engine fidelity must be assessed rather than assumed.

**Promotion rule:** no unsupported claimed win, no shortcut around GitHub-hosted repeatability/controls, no cherry-picked single runner, no private force-push to another engineer's active branch.
