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
