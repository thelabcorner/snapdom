# R17 — Work-conserving image-inlining queue: campaign evidence

## Source and mechanism
- Frozen parent: `ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b` (R12 decoded-bitmap scout).
- Frozen production candidate: `5261af4114f5886d71645126ef26ecd74078e771`.
- Only production changes are `src/modules/images.js` and `src/utils/boundedSettled.js`.
- Six continuously refilled promise slots replace fixed six-item `Promise.allSettled` batches; SVG image work no longer waits for the entire HTML img list to settle. Same per-item handling and six-request ceiling.
- Branches with additional benchmark-only code retain the measured production commit via explicit checkout. Do not cherry-pick new harness files as an unmeasured speed candidate.

## Timing (accepted, scoped)
- Hosted Actions [37746547523](https://github.com/thelabcorner/snapdom/actions/runs/37746547523).
- Six independent Chromium runners, each 8 AB/BA pairs per scenario; 48 pairs per regime.
- Mixed 36 assets with deterministic uneven latency: -53.85%, bootstrap CI [-55.23%, -52.66%].
- HTML-only uneven latency: -68.74%, CI [-69.12%, -68.35%].
- SVG-only uneven latency: -67.96%, CI [-68.47%, -67.38%].
- Mixed fast assets: -3.61%, CI [-7.00%, +1.71%], not significant.
- 36 already-inline images: +1.41%, CI [-2.50%, +5.49%], not significant.
- Six-item small mixed: -17.76%, CI [-21.07%, -15.02%].
- All benchmark pairs required exact URL/string and rendered RGBA pixel hashes; all asserted <=6 in-flight image fetch requests.
- These percentages are NOT universal snapDOM speedups and cannot be added to R10/R12 percentage changes.

## Cross-engine fidelity (accepted)
- [37747884830](https://github.com/thelabcorner/snapdom/actions/runs/37747884830): `R17_THREE_ENGINE_FIDELITY_ACCEPTED`, 144/144 exact pairs, 48 in each Chromium, Firefox and WebKit.
- Frozen baseline/candidate sources, six varied workloads in each engine, eight balanced pairs per workload; exact raw SVG, rendered-pixel hash, and <=6 request concurrency ceiling.
- Original browser-free and three-engine unit gate passed [37746002230](https://github.com/thelabcorner/snapdom/actions/runs/37746002230).

## Native memory (observed, not Pareto accepted)
- [37747577364](https://github.com/thelabcorner/snapdom/actions/runs/37747577364): six isolated Chromium process trials, Linux process-set PSS in MiB; three runners per distinct host image; strict raw SHA and GC-separated samples.
- Host image 20261004.327.1: median warm candidate-baseline +0.16 MiB, unique-image sweep +1.91 MiB.
- Host image 20260927.320.1: warm +2.50 MiB, sweep +3.73 MiB.
- Unique sweep individual observations: -0.11 to +7.13 MiB. No cross-host-image pooled estimate.
- Measurements do not include transient peak memory; positive observed deltas warrant profiling before strict Pareto claims.
- The work queue has no new persistent asset memo, but this alone does not demonstrate equal memory use.

## Integration criteria
1. Bring mechanism into reconciled current production line, preserving R15 SVG-image cache, R16 selector changes and any other active separate owner branches; rerun full gates on integrated commit.
2. Re-measure mixed latency under representative real application workloads, and consider a peak-memory trace and larger paired PSS cohorts.
3. Keep experimental gains scoped; allow promotion only after explicit memory tradeoff review and any integration conflict resolutions.
