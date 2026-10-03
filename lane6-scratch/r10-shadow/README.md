# R10 F4 — hosted wall falsifier for the per-root identity partition

This lane answers exactly one preregistered question and is deliberately built so that the
answer can be **no**:

> Does extending the identity share into shadow roots, partitioned per root, earn its cost in
> wall time?

It is a falsifier, not a benchmark that looks for a win. The thresholds, the matrix and both
branches of the decision rule live in `F4_POLICY.json`, whose SHA-256 is pinned by `prepare.mjs`
together with every measurement file. `validate.mjs` is the only place a verdict is formed and
it reads the policy rather than restating it, so changing a threshold is a policy edit and shows
up in the pinned hash.

## Why the ceiling arm, and why it is allowed to be wrong

A sound partition is expensive by necessity, not by accident. To share two shadow nodes from
the same root, the library must know that root's own sheets, because `:nth-child(2)` written
inside a shadow root splits two structurally identical siblings exactly the way
`:host(:not(:first-child))` splits hosts in #488. The document scan cannot see those rules, so a
per-root scan is the correctness floor, not an optimisation.

That creates the measurement trap: if the sound partition lands below 1%, nobody can tell
whether 1.2% was missed by a sloppy implementation or by the idea. So the opt arm is a
**ceiling spike** and nothing more:

- it hands shadow content a per-root identity token and nothing else;
- it does not read the root's sheets, so it is expected to paint wrongly on `host-split-shadow-cards`
  and `slotted-split-shadow-cards`;
- therefore the sound build can only be **smaller** than what it measures.

Two consequences are baked into the harness rather than left to the reader:

1. **Byte parity is a diagnostic here, not a gate.** A fixture whose two arms agree byte-for-byte
   is reported as `spikeByteSafe`. A splitting fixture whose arms diverge is the expected
   behaviour of an upper bound, and it is also the evidence for what the sound build must add.
2. **Only splitting-free fixtures can carry a promotion case** (`splittingFixtures` in the
   policy). A divergence there would be a defect in the spike, not a cost of the sound design.

## The decision rule, verbatim from the policy

`REJECT_PARTITION` when any of:

- no shadow fixture's 95% CI **upper** bound reaches `minEffectPct` (1.0). The upper bound, not
  the point estimate: a point estimate under 1% with a wide interval is not evidence of absence;
- the instrument is noisy on any fixture (an A/A control outside `controlBand`, or
  `maxPairLogSd` over `maxPairLogSd`);
- the no-op control (`document-uniform-cards`) is not equivalent;
- any fixture regresses by more than `minEffectPct`.

`PROMOTE_TO_DESIGN` only when every splitting-free shadow fixture **clears** 1% with a clean
instrument, the no-op control is equivalent and nothing regresses. That authorizes *building* the
sound partition. It is not a promotion to production, and it is not a licence to ship.

`INCOMPLETE` covers a blocked ambient gate, a missing matrix cell, provenance drift, a missing
report and an unparseable report. **Zero evidence can never read as a promising partition** — the
same rule the R9 self-null calibration follows, and the reason this lane keeps every raw sample
and deletes no outliers.

A rejection is a settled question. More replicates on a rejected partition are not a retry.

## Matrix and protocol

- Chromium 8 / Firefox 4 / WebKit 4 fresh hosted runners, concurrency capped at 8.
- Each runner: seven fixtures, N=24 acquisition blocks, batch=9, warmup=6, six layouts
  (effect AB, effect BA, base-state A/A both directions, candidate-state B/B both directions),
  Latin rotation so no arm owns "early" or "late" runner time, symmetric micro-interleaving.
- `option-pair` on ONE compiled bundle. Both arms are the released build; the only difference is
  `__styleShareShadowRootTwins`. Any difference is attributable to that option alone.
- Index-block bootstrap (12000 draws) of symmetric paired log ratios. Raw rows retained in
  `results/`, requests in `requests/`, verdicts in `decisions/`.
- Protocol machinery is imported unmodified from `lane6-scratch/r9/protocol.mjs`. R9's driver is
  NOT edited: its hash is pinned by the completed R9 calibration, which is why this lane carries
  its own `bench-f4.mjs` instead of adding a `--suite=shadow` branch to R9's.

Browser launch is refused outside GitHub Actions, in `bench-f4.mjs` itself.

## The fixtures are shared with the browser suite

`__tests__/helpers/shadowCards.js` is the single definition of the shadow-card family. The
hosted page imports it as a module and the bench serves it at `/shadowCards.js`, whose hash is
pinned in the policy. The same six shapes therefore back the vitest read census and the hosted
wall run, so a fixture cannot quietly mean one thing locally and another on the runner.

The census itself lives in `__tests__/module.styles.shadowReadCensus.test.js` and is
deterministic, so it needs no hosted runner. **It counts calls, not seconds.** See the R10 audit
note for why that distinction is load-bearing here.

## What F4 does NOT do

It does not build the partition. The sound per-root partition needs a per-root sheet scan, a
per-root property universe, per-root pseudo gates, per-root selector vectors, slot handling and
its own invalidation story. None of that is written here, on purpose: the preregistered rule
exists to decide whether any of it is worth writing.

The spike arm itself (`__styleShareShadowRootTwins`) is specified in the R10 audit note and is
also not written here. When it is written, it must be a throwaway counterfactual option, it must
default off, and it must land with the parity evidence above attached.