# snapDOM R9 hosted calibration

This lane is deliberately **non-promotable**. It measures the GitHub-hosted timing rig before
R9 accepts another performance claim.

## Hard rules

- Browser execution is GitHub-Actions-only. `run.mjs` refuses to spawn a browser unless the
  GitHub Actions provenance environment is present.
- The calibration is a self-null: the same compiled bundle and the same options are used on
  both arms. A non-zero effect is measurement bias/noise, not a snapDOM speedup.
- Raw samples are retained. No outlier deletion is performed.
- A blocked ambient gate, missing report, parity failure, provenance drift, or missing matrix
  cell makes the closeout incomplete/red. Zero evidence can never look like a successful
  benchmark.
- `CALIBRATION_COMPLETE` means only that the preregistered noise matrix was collected. It is
  **not** an optimization or non-regression claim.

## Preregistered matrix

- Chromium: 8 fresh hosted runners.
- Firefox: 4 fresh hosted runners.
- WebKit: 4 fresh hosted runners.
- Each runner: standing suite, four fixtures, N=24 acquisition blocks, batch=9, six-layout
  base/opt + base/base + opt/opt crossover, symmetric micro-interleaving.
- Matrix concurrency is capped at 8.

The aggregate is runner-level. It reports each engine/fixture's self-null point estimate,
Student-t 95% CI across fresh VMs, runner SD(log ratio), an estimated between-runner variance
after subtracting average within-run variance, I², both duplicate-null effects, and an
option-state slot-interaction diagnostic.

The result of this calibration is used to freeze the later promotion policy. Thresholds for
real candidates are not chosen until this self-null has completed, so candidate outcomes
cannot tune the measuring instrument.
