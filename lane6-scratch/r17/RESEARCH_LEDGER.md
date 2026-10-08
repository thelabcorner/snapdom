# R17 — Concurrent independent raster compression passes

**State:** isolated experimental hypothesis, NOT a performance or production claim. Frozen mechanism baseline: `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b` (R12 decoded-bitmap candidate).

## Observation

`compressCloneAssets` awaits three independent DOM target passes in sequence:
1. `compressClonedImages` mutates only HTML `<img>` `src`.
2. `compressClonedBackgrounds` mutates `background-image` inline style.
3. `compressClonedSvgImages` mutates SVG `<image>` `href`/`xlink:href`.

Each pass uses its own bounded six-wide work queue. When one pass waits for large image Worker decode and encode, the other classes cannot post work even though the Worker pool may have spare capacity. This may matter to charts/documents with both bitmap artwork and SVG embedded images, and to CSS-background-heavy cards.

## Isolated mechanism

Launch three existing compression passes concurrently using `Promise.all` with the same shared geometry and route counters. Each element's destination property is disjoint; the final asset registry renumbers tokens in DOM order at serialization. Preserve the original per-class bounded batches, source/target geometry, Blob sidecars, compression cache, all worker and error fallback behavior.

## Fail-closed falsifiers

- Byte-for-byte SVG and RGBA pixel parity across Chromium, Firefox, WebKit; comparisons are between distinct SHA-frozen candidate/baseline compiled bundles. Fixture arms include HTML-only, mixed HTML/CSS/SVG, CSS/SVG-only and SVG-only, with real large raster payloads and distinct source URLs.
- HTML-only and no-compress controls must not regress significantly. Distinct-source mixed image arm must actually exercise all three paths with eligible image resizes; otherwise no causal speed claim.
- Six GitHub-hosted Chromium runners, 8 balanced AB/BA measured pairs per arm, run-level effects and 95% confidence intervals. **Original homogeneous Ubuntu image acceptance** is retained; different images yield observational `NO_TIMING_ACCEPTANCE`, never a pooled claim.
- Capture and capture+render timings separately; serialized string byte hashes, pixel hashes and size equality. No measured effect credited to microbench-only work.
- Native process-set PSS, Worker-pool queue/fairness, timeout/fallback, exception, CSP, oversized and high-cardinality churn must pass before production promotion.
- If main-thread decode fallback or shared-cache inflight races cause fidelity variance or >meaningful regression, retire/revert. Do not combine R17 with R15, R13, or release until each source provenance and integration fidelity gate completes.

## Expected outcome

Potentially lower mixed-media capture latency without altering compression algorithms. Might lose because the browser/pool is CPU-saturated, concurrent serialization increases contention, or all work already benefits from shared compression memo; require independent evidence, not assumption.
