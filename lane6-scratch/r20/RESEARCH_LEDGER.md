# R20: Capture-local inherited ancestor property-universe summary

## Hypothesis and independent experiment
Parent: `cac07a4108086718bc9511663346e1b9fcf4e226`. Isolated worktree/branch `perf/v3-r20-ancestor-universe-memo`.

The R3 `elementUniverseFor` historically inspects live ancestors separately for every child to decide whether ancestor UA styles, inherited inline properties, presentational attributes, and risk tags make narrowed property-snapshotting unsafe. In a deeply nested component tree this is O(N×depth) repeated DOM/CSS inspection. This experiment memoizes immutable inherited-property sets on ancestor elements inside one capture session. Each ancestor is scanned once and then reused by descendants, unless a risk gate vetoes narrowing.

Safety gates:
- memo only with a real per-capture session, currently checked epoch, and no `scan.elementAllRules` that may depend on dynamic state.
- preserve first element's own inline declarations/default probes and all browser selector matching; only summarize ancestors.
- blocked/risk nodes always return the full document property universe.
- paths exceeding the old 1024-node ancestor limit fall back to the exact historical traversal.
- memo is deleted as soon as `deepClone` returns or throws; it may be rebuilt by subsequent pseudo work but is not globally retained.
- explicit internal `__ancestorUniverseMemo:false` restores the historical path.
- no persistence across captures, hover changes, style epochs, or arbitrary DOM sessions.

Acceptance requires:
1. lint/TS/compile and existing selector/element-universe browser tests on Chromium, Firefox and WebKit.
2. exact raw SVG and rendered-pixel parity versus separately compiled frozen parent, with deep CSS inherited paths, neutral deep paths, shallow controls, ancestor inline mutation between captures, selector veto.
3. six balanced timing pairs per regime and engine in the scout; at least six independent hosted runners and paired bootstrap intervals before any improvement claim.
4. PSS/repeated captures plus dynamic mutation/CSSOM stress before promotion. Any output mismatch rejects immediately.

No speed claim before hosted runs. Source changes are an experimental optimization of `src/modules/styles.js`; `src/core/context.js` forwards the counterfactual, and `src/core/prepare.js` bounds the memo lifetime.

## Scout measurement correction

The first hosted three-engine run 37750130708 passed contract checks, CSS tests,
exact output and pixel parity. Its Chromium trial showed systematic fast/slow
alternation *by capture slot* despite alternating treatment assignment: roughly
8 and 24 ms in the same deep fixture. Thus direct treatment medians conflate
version with a strong same-page capture-order effect. These timings are rejected
as decision-grade evidence; parity still stands.

The corrected benchmark isolates the frozen baseline and candidate in distinct
browser pages, independently warms both, alternates scheduling, preserves raw and
pixel guards, adds a same-source A/A two-page null control, and reports
runner-level paired log effects with all samples. The A/A null is mandatory to
interpret candidate-vs-baseline effects. Six independent runners and native
memory evidence remain required for promotion.

## Isolated-page scout, run 37750517060

All historical selector contract checks, raw SVG and pixel parity passed in Chromium,
Firefox, and WebKit. Paired geometric timing effects (candidate minus baseline,
negative faster) on deep-inherited: Chromium +3.45%, Firefox -2.34%, WebKit -0.12%;
deep-neutral: Chromium -7.54%, Firefox -1.31%, WebKit +9.47%.
Shallow controls likewise varied in sign. Same-source A/A null remained nonzero
(Chromium -2.02%, Firefox +5.04%, WebKit -6.43%). These data do not demonstrate
practical Pareto gain, so R20 is **not** promotion-ready.

Next falsifier is direct *engagement*. The new counters are opt-in through the
internal `__ancestorUniverseTelemetry` object and read in a separate untimed
capture. A regime that claims to test the mechanism but has zero summary uses
must fail closed. Further stress extends nested depth from 20/24 to 64/192
and breadth to 32 leaves per branch; do not conflate this synthetic stress
with representative applications. Memory and six-host replicated CIs still gate
any production optimization.

## Engagement falsifier (run 37750877566)

The first instrumentation attempt correctly failed on `deep-inherited` with
`summaryUses=0`. Source inspection showed that `getSnapshot` short-circuits
on a valid prior cross-capture WeakMap snapshot before reaching
`elementUniverseFor`. Ordinary repeated captures can therefore bypass R20,
even with `cache:'disabled'`; earlier repeat-capture timings did not reliably
measure this mechanism. This is a test-design failure, not a source correctness
failure. For R20's true fresh/dirty-style target, revised fixture uses
`invalidate:true` before **every** capture in both independently compiled
arms, and performs the telemetry probe before the initial parity captures.
Any `summaryUses=0` in a non-veto deep fixture remains a hard failure.
