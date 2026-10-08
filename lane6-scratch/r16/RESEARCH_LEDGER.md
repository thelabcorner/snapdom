# R16 — Native background candidate selector (preregistered)

**Status:** EXPERIMENT ONLY. Source base: `perf/v3-r12-decoded-bitmap-scout` (R12 decoded-bitmap mechanism); do not promote without separate accepted timing, memory, and fidelity evidence. R12/R13/R14/R15 owner branches are untouched.

## Observed redundant work

`compressClonedBackgrounds` materializes `[clone, ...clone.querySelectorAll('*')]` and reads `el.style.backgroundImage` on every descendant for every compressed capture, even where zero elements can enter the data-URL background downsampling path. The already-inlined backgrounds are persisted in inline `style` attributes.

## Single mechanism

Replace the unconditional every-descendant collection with an attribute substring query `[style*="data:image"]`, retaining the existing explicit `el.style.backgroundImage.includes('data:image')` guard. Handle clone root separately. Do not change image encoding, geometry, cache eligibility, route counters, or output serialization.

## Falsifiers / gates

1. Exactly the same candidates in DOM tree order as the old full scan, including root; CSS unrelated properties that mention data URLs must remain excluded; inline style case and SVG elements must retain prior behavior.
2. Chromium, Firefox, WebKit: byte-for-byte raw SVG output and equal pixel RGBA hashes across baseline/candidate for both no-background and sparse-background large DOMs. Include root backgrounds, nested SVG, uncompressed captures, and capture root only.
3. Timing on at least six independently hosted runners, paired AB/BA order, with 8+ samples per arm. Measure **end-to-end capture** separately from compression path microtiming. Include dense-background regression arm; no claim unless 95% runner-level CI excludes 0 and source controls demonstrate actual traversal elimination.
4. Omit promotion if candidate increases memory, hurts dense background workloads materially, alters error or fallback handling, or fails fixtures.
5. Do not infer overall snapDOM speed from only selector or compression microbenchmarks; explicit cold/warm, full-capture fidelity gating is required.

## Comparability

Do not combine these experimental percentages with R10/R12 percentages by arithmetic addition. Record branch SHA, frozen comparison SHA, browser revision, runner image, timings and exact output hashes for every paired measurement. A failing or incomplete job yields **NO_CLAIM**.

## Final experiment result — REJECTED (2026-10-08)

Source candidate commit `f495f11c9a8018cae7684874ba20a6c96dfdf61d`.
GitHub Actions [run #37745225552](https://github.com/thelabcorner/snapdom/actions/runs/37745225552) completed all build/type/lint/contract, 3-engine fidelity, 6 Chromium paired timing, and aggregation jobs successfully. The aggregator's **substantive** decision is `NO_TIMING_ACCEPTANCE`.

| Regime (capture) | Candidate vs R12 baseline | Runner-level 95% CI | Verdict |
| --- | ---: | ---: | --- |
| no-background | −1.9857% | [−4.8539%, +0.9690%] | CI crosses zero |
| sparse-background | +0.1216% | [−6.3776%, +7.0719%] | CI crosses zero |
| dense-background | **+3.1784%** | **[+2.1183%, +4.2494%]** | **significant regression** |

All 3 browser fidelity jobs (Chromium, Firefox, WebKit) and all 6 Chromium timing runner jobs passed their exact-output gates. The runner images nonetheless mixed `20261004.327.1` and `20260927.320.1`; the preregistered homogeneous-host timing acceptance condition also fails.

**Disposition: `REJECTED_NO_PROMOTION`.** Do not cherry-pick or merge the native `[style*="data:image"]` compression candidate-selector source patch. A passing workflow exit code is not a passing performance acceptance decision. Preserve the experiment and artifacts for falsification/research. Future asset-index work must first establish an actual end-to-end breakeven against dense and sparse controls.
