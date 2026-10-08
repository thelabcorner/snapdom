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

## First hosted verdict — INCOMPLETE / NO PERFORMANCE ACCEPTANCE

Frozen baseline `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b`. Experimental production change `c7858f634416e42166a4d70044b602618c365624`. Browser harness correction `caa71b95c12ef141b3fb91385ab35d27a09adf52`, which decodes the public percent-encoded SVG data URL before counting compressed asset markers, was required to reach the measurement phase. [Run 37746367847](https://github.com/thelabcorner/snapdom/actions/runs/37746367847).

All six hosted Chromium A/B runner jobs succeeded; Chromium and Firefox fidelity jobs passed; WebKit passed compressed `html-only`, `mixed-assets` and `svg-background-only` fixtures with exact raw and RGBA hashes, but its `no-compress` fixture failed RGBA hash while raw output hashes matched. This null-arm instability is unresolved; exact cross-engine fidelity was **not** accepted.

| Arm / capture | Estimated change | Runner-level 95% CI |
| --- | ---: | --- |
| HTML-only | +2.8844% | [−10.6787%, +18.5070%] |
| Mixed HTML/CSS/SVG | −6.0481% | [−13.1655%, +1.6527%] |
| SVG+background | −4.2711% | [−10.2704%, +2.1292%] |
| `compress:false` negative control | −0.6856% | [−5.5398%, +4.4180%] |

All four effect confidence intervals intersect zero; the runner image revisions were heterogeneous (`20260927.320.1`, `20261004.327.1`). The exact preregistered aggregator returned `NO_TIMING_ACCEPTANCE`. **No accepted speedup or Pareto win and no production promotion.** Remains isolated only for research into mixed-media concurrency and WebKit A/A null-arm variance. If follow-up is warranted, require two same-source A/A controls before concluding WebKit rendered-pixel differences are implementation-specific.
