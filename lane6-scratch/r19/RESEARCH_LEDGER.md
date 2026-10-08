# R19 — SVG serialization interning scanner (experimental)

## Scope and provenance

- Source parent: `cac07a4108086718bc9511663346e1b9fcf4e226` (frozen R12 public SVG-export branch), not current main.
- Isolated branch/worktree: `perf/v3-r19-svg-serialization-scan`.
- Production change confined to `src/engines/svg.js`, specifically the string-level inline-style interner. No public API changes.
- R12 bitmap PSS, R13–R18 independent experiment worktrees were left untouched.

## Hypothesis

The current interner produces substring spans, scans the text via regular expressions and usually returns the original SVG string because fewer than 2048 bytes can be saved. With embedded base64 PNGs the serialized foreignObject can exceed 16 MiB. The candidate stores numeric slice offsets, counts style attributes with native `indexOf`/slice, and defers copies until the existing savings gate passes.

It retains the historical author-style exclusion regex, the same data-sdi protection, the same style-signature token order, and the exact protected style policy. This is a CPU/allocation optimization, not a change in captured content.

## Local results (not browser claims)

Node 22 development workstation, synthetic serialized foreignObjects, 15 median measurements in each direction, warmed before timing. All 1000 seeded and 20 large-payload differential source-string fixtures produced exactly equal results.

| regime | old median ms | candidate median ms | change |
| --- | ---: | ---: | ---: |
| 16 MiB image, four styled nodes | 2.8591 | 2.6612 | -6.92% |
| 16 MiB image, 2500 styled nodes | 22.3392 | 21.7436 | -2.67% |
| 2500 styled nodes without image | 3.2832 | 2.9489 | -10.18% |
| 100 styled nodes, 16 KiB image | 0.1238 | 0.1475 | +19.14% |

The local `image-no-intern` fixture did not create an image because it had zero rows, so that measurement is **not evidence** of an image-only path. These numbers apply only to `internInlineStyles`, not full capture. The small mixed-content result regressed. There is not yet evidence of major end-to-end benefit.

## Hosted experiment and accept/reject rules

`.github/workflows/r19-svg-scan.yml` independently compiles both source revisions and uses Chromium, Firefox and WebKit to run preexisting style-interning tests, exact public toRaw comparisons, pixel hashes, and alternating 6 measured pairs per regime. The node test requires the pinned baseline commit and thus full fetch history.

**Reject** as a performance optimization if the hosted public capture interval indicates no practical win or regression, even when the isolated Node microbenchmark is positive. Never infer an overall speedup from serialized-byte-only timings. The implementation is still experimental and must not be merged without a release gate and external browser evidence.

## Further high-impact frontier

The R19 preflight cost appears too small relative to DOM clone/style acquisition. A likely more promising algorithmic problem is `elementUniverseFor`'s repeated ancestor traversal on deep trees (see `src/modules/styles.js`); investigate snapshot-safe per-capture ancestor summaries with strict mutation/hover/CSSOM invalidation, no optimism around dynamic selectors, and depth 1024 fidelity, before changing that path.

## Hosted outcome — 2026-10-08

- Run: https://github.com/thelabcorner/snapdom/actions/runs/37749296803
- Full workflow verdict: success across contracts, Chromium, Firefox and WebKit. Raw URLs and pixel hashes matched all measured A/B pairs.
- Representative median captures in Chromium, baseline → candidate (ms): large image 61.9 → 61.6, repetitive styles 19.4 → 21.2, image+table 79.6 → 81.8.
- Firefox: 133 → 134, 38 → 41, 173 → 168 respectively.
- WebKit: 208 → 212, 15 → 15, 236 → 229 respectively.
- Six measured pairs per workload/browser, one independent browser runner per engine; these single-run medians are **not** a significant improvement claim and must not be treated as confidence intervals.
- **Decision: REJECT FOR PROMOTION.** The change preserved fidelity but did not establish a practical, replicated, Pareto-improving end-to-end capture speedup. Keep the branch as a falsified experiment, do not merge.
