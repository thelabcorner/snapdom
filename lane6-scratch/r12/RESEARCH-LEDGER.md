# R12 — decoded ImageBitmap reuse frontier

**Status: isolated experimental prototype, NOT a production improvement or a validated speedup.**
Frozen comparison baseline: `d391556b80be7a6d97bc4834d2ce6e24137515b2`. Branch: `perf/v3-r12-decoded-bitmap-scout`. R11 controls the release acceptance of the frozen baseline; R12 does not alter it.

## Hot-path finding
`downsampleDataURL` already memoizes results using source equality plus geometry, and R10 AS-BLOB retains the original Blob. But whenever a target scale or width changes, the compression memo misses. Each Worker then runs `createImageBitmap(blob)`, `drawImage`, and `convertToBlob` again. Decoding the same Blob repeatedly is a testable redundancy, whereas the requested re-encode for new dimensions is not.

## Hypothesis
A Worker-local cache of a **decoded ImageBitmap**, keyed by a stable token for the actual same Blob object, should avoid some repeated decoding while leaving output geometry and encoding identical. The prototype uses `WeakMap<Blob, integer>` and stable routing to a worker, LRU storage, 4 MiB per Worker (16 MiB with 4 workers), explicit `bitmap.close()` eviction, concurrent borrower pinning, and a `bitmapHit` response field for evidence. Non-Blob messages retain round-robin routing and never populate the decoded cache. Oversize bitmaps are decoded and released exactly as before.

## Falsification requirements
1. **Correctness:** exact SVG byte parity and exact RGBA pixel parity with the frozen baseline in each of Chromium, Firefox and WebKit. Include orientation, ICC profiles, premultiplication/alpha, cache-disabled, worker denied, concurrent same-key decode and switched-source cases.
2. **Causal routing:** independently prove repeat geometries actually hit decoded cache; verify null arms never claim a benefit.
3. **Throughput:** at least six fresh GitHub-hosted VMs, balanced AB/BA order, eight paired measured captures per arm. Main results: capture/compression latency, capture+render, and 95% confidence intervals. Include multi-image gallery to expose affinity-induced serialization.
4. **Memory:** monitor full browser/worker process-tree PSS and identify actual incremental decoded resource retention. 16 MiB is a provisional ceiling, not evidence that retention is acceptable.
5. **Failure:** worker crashes, CSP, timeouts, exception before/after encoding, concurrent decode, source replacement, and worker pool termination must all remain bounded and fail safely.
6. **Retirement:** discard any candidate that is dominated by R10 AS-BLOB or introduces fidelity variance, higher unacceptable memory, or meaningful gallery slowdown.

## Adjacent candidates (not implemented)
- Avoid redundant clone-wide selectors and repeated compression passes by using asset-node registry built during inline traversal.
- Replace repeated DOM style and geometry reads with phase-consistent immutable capture-session snapshots.
- Narrow style selector indexing and pseudo-element dispatch further on adversarial large DOMs.
- Reassess Worker pool size with scheduling fairness, not an unconditional increase.
- Try browser-native `createImageBitmap` resize options only as a separate fidelity experiment; these may NOT be pixel-identical to the current high-quality canvas draw.

## Prior art / API contracts
https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/createImageBitmap
https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap/close
https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/transferToImageBitmap
