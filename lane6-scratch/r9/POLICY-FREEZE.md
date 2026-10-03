# R9 hosted governor policy freeze — 2026-10-03

This file records why `POLICY.json` is frozen. It is part of the measurement-control plane, not a
performance result.

## Calibration owner

- Workflow: `.github/workflows/r9-calibration.yml`
- Completed hosted run: `37097245291`
- Measured head: `3a6007f8b166150799b8f2033060733d0f9fb433`
- Artifact: `r9-calibration-summary-37097245291`
- State: `CALIBRATION_COMPLETE`
- Evidence cells: 16/16
- Node: 22.21.1
- Playwright: 1.55.1
- Runner image: ubuntu-24.04
- Chromium: 8 fresh runners
- Firefox: 4 fresh runners
- WebKit: 4 fresh runners
- Acquisition: N=24, batch=9, warmup=6, bootstrap=12000

The completed self-null matrix measured the same immutable bundle/options in both arms. Across all
engine x fixture cells, the largest absolute endpoint of a runner-level 95% self-null CI was
4.167779454%. The largest observed within-run `maxPairLogSd` was 0.305407529.

The earlier post-settle calibration attempt that showed a Chromium base-null pair offset did not
replicate in this completed replacement matrix. It remains a useful topology/noise warning, not a
reproducible bias law.

## Values frozen from calibration

| Policy field | Frozen value | Basis |
|---|---:|---|
| Chromium confirm replicates | 8 | completed Chromium calibration matrix |
| Firefox/WebKit guard replicates | 4 each | completed cross-engine calibration matrix |
| confirm / engine-guard N | 24 | calibrated acquisition |
| confirm / engine-guard batch | 9 | calibrated acquisition |
| confirm / engine-guard warmup | 6 | calibrated acquisition |
| confirm / engine-guard bootstrap | 12000 | calibrated acquisition |
| equivalenceBand | 0.05 | 5% encloses the worst completed self-null CI endpoint (4.168%) |
| controlBand | 0.05 | same calibrated no-op/control envelope |
| nonRegressionBand | 0.05 | same outer statistical regression envelope; not an equivalence claim |
| maxPairLogSd | 0.35 | 0.3054 observed maximum plus a modest preregistered stability margin |

Scout remains kill-only and non-promotable. It uses the same batch=9 so its acquisition primitive is
not a different instrument; its warmup is 5 and it contributes no numeric promotion evidence.

## Practical policy, not calibration

`promotion.epsilon = 0.01` is a **1% minimum worthwhile improvement (MPE)**. The calibration does
not establish that a 1% effect is universally resolvable. The aggregate runner-level confidence
interval must lie beyond -1% for an IMPROVEMENT claim, so a noisy fixture cannot become promotable
merely because its point estimate exceeds 1%.

In other words:

- 5% describes the calibrated outer no-op/equivalence/control envelope.
- 1% describes what this project considers worth promoting when the evidence is precise enough.
- They answer different questions and must never be inferred from one another.

## Governance invariants

Candidate manifests do not own or override thresholds, bands, replicate counts, acquisition sizes,
tool versions, or runner identity. Runner cells establish evidence validity only. Chromium
confirmation is the only inference phase that may own `PROMOTABLE`; Firefox/WebKit are mandatory
guards and may only become `GUARD_CLEARED`. Zero or incomplete evidence fails closed.
