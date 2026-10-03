# R10 F4 — hosted wall CEILING falsifier for the per-root identity partition

This lane answers one preregistered question, and it is built so that the answer can be **no**:

> Is a per-root identity partition for shadow content worth the architecture work it would take?

It is a falsifier. It can reject the partition, or authorise *designing* it. It can never promote
it to production, and `PROMISING_TO_DESIGN` is not a production claim.

## What the arm is, and why it is allowed to be wrong

A sound partition is expensive by necessity, not by accident. To share two shadow nodes from the
same root, the library has to know that root's own sheets, because `:nth-child(2)` written *inside*
a shadow root splits two structurally identical siblings exactly the way
`:host(:not(:first-child))` splits hosts in #488. The document scan cannot see those rules, so a
per-root scan is the correctness floor, not an optimisation.

That is the measurement trap. If the sound partition lands under 1%, nobody can tell whether 1.2%
was missed by a sloppy implementation or by the idea. So the opt arm is a **ceiling**: the
cheapest thing that could capture the whole win — a per-root identity token and nothing else, with
no per-root sheet scan. The sound build can only be **slower** than what F4 measures. A ceiling
that does not clear the floor therefore settles the question.

Two consequences are in the harness, not left to the reader:

- **Byte parity is required on every fixture** (`parityExemptFixtures` is empty). On this fixture
  set the ceiling arm is expected to agree byte-for-byte with released everywhere, so an empty
  exemption list is the strongest contract available. A future fixture that makes the ceiling arm
  legitimately unsound goes into that list with a written reason rather than silently widening the
  gate.
- **`host-split-shadow-cards` and `slotted-split-shadow-cards` are measured but cannot carry the
  promotion case** (`promotionExcludedFixtures`). A sound partition must keep `:host()` and
  `::slotted()` splitting intact while partitioning shadow *content*, and the ceiling arm does not
  model that at all. A regression in either still rejects the partition.

## The 1% floor is a practical floor, not a significance threshold

`thresholds.practicalFloorPct` is 1%. It is the smallest wall effect that would pay for a per-root
sheet scan, a per-root property universe, per-root pseudo gates, per-root selector vectors, slot
handling and their own invalidation story. It carries **no claim that 1% is detectable here**. If
the ceiling sits across 1% and the instrument cannot separate them, the answer is `INCONCLUSIVE`,
which is a real finding about the measuring instrument and not a licence to add replicates.

This is the same shape as the standing lesson in `lane6-scratch/r5/R5_ITERATION_LEDGER.md`: the
prior 47–80× shadow read-amplification figure is a **call-count ordering**, not a wall claim, and
neither is 1%. They are not comparable quantities and neither substitutes for the other.

## Where ±5% comes from, and what it is not

`instrument.outerNullEnvelopePct` is 5.0, taken from the **completed** R9 hosted self-null
calibration, run `37097245291`, as the maximum absolute self-null 95% CI bound over its whole
preregistered matrix.

It is an **outer envelope on NULL quantities only**: the two A/A null controls on every fixture, and
the no-op fixture's effect (whose two arms are the same code path, so its effect *is* a null). It
is adopted as-is rather than re-derived, so F4's control validity is anchored to an instrument that
was itself calibrated.

It is emphatically **not** a significance threshold for the effect arm. A ±5% envelope cannot
establish, refute or bound a 1% effect, and no fixture verdict is ever derived from it. It is kept
separate from the second, coarser instrument gate: `instrument.grossMaxPairLogSd`, a per-runner
paired-log-ratio SD ceiling that voids a runner's sample outright regardless of what its own
confidence interval says.

The 20% control and equivalence bands from v1 are gone. A 20% band cannot carry a 1% question.

## Staging, and why it saves public minutes

- **Stage 1, Chromium, 8 fresh runners.** Decides `REJECT_PARTITION`, `PROMISING` or `INCONCLUSIVE`.
- **Stage 2, cross-engine guard: Firefox 4 and WebKit 4 fresh runners.** Runs **only** when stage 1
  returned `PROMISING`. Aggregated per engine, independently, requiring direction consistency,
  non-regression and valid controls. Engines are never averaged together and never pooled with
  chromium.
- **Closeout** combines the two into one machine state.

If Chromium rejects or is inconclusive, the engine jobs are skipped and no public runner minutes are
spent on a question that is already answered.

## Per-cell vs aggregate: what each layer is allowed to decide

`validate.mjs` runs once per cell and may emit **only** `SAMPLE_VALID`, `INCOMPLETE_EVIDENCE` or
`PROVENANCE_FAILURE`. It has no code path that can answer the 1% question, and it emits no verdict
field. It enforces what makes an observation trustworthy at all: measurement hashes, bundle and
policy identity, fixture manifest and order, finite index-aligned blocks, positive timing rows, the
gross paired-log SD ceiling, the A/A raw controls **recomputed from the raw rows** (so a tampered
harness summary cannot hide a slot bias), the no-op raw envelope, and byte parity where the policy
requires it.

`aggregate.mjs` is the only place the 1% question is answered. The unit of observation is **one log
point per fresh runner**, with a Student-t 95% interval over those points using the same table and
the same semantics as the calibrated R9 self-null. Per-call and per-block rows are never pooled
across VMs: doing so would treat one runner's 24 blocks as 24 independent observations and shrink
the interval by `sqrt(replicates)`, which is the cheapest available way to manufacture a 1% claim
out of a 5% instrument.

Heterogeneity is reported per fixture as `Q`, `df`, `I²`, `tau²` and `tau(log)`, plus the median
within-run block SD. Raw per-runner points are preserved verbatim in the closeout artifact.

## The decision, verbatim from the policy

| state | condition |
|---|---|
| `REJECT_PARTITION` | every splitting-free shadow fixture's aggregate 95% CI **upper** bound is below 1.0%, **or** any aggregate shadow fixture regresses beyond 1.0%, with controls valid |
| `PROMISING` (`CONTINUE_TO_ENGINES`) | at least one splitting-free shadow fixture's aggregate 95% CI **lower** bound is above 1.0%, controls valid, no material regression |
| `INCONCLUSIVE` | neither of the above — the present instrument cannot separate the ceiling from the floor. Replicates are **not** added automatically |
| `INCOMPLETE_EVIDENCE` | blocked settle or ambient gate, missing matrix cell, inadmissible cell, absent report |
| `PROVENANCE_FAILURE` | policy, bundle, measurement-hash, fixture-identity or runner-identity drift |

Exactly-at-the-floor is `INCONCLUSIVE` from both sides: promotion needs `> 1.0%` and rejection needs
`< 1.0%`, so an interval that touches 1.0% settles nothing. **Zero evidence is never green** —
`INCOMPLETE_EVIDENCE` and `PROVENANCE_FAILURE` both exit non-zero and both make the closeout red.

A rejection is a settled question, not a reason for more replicates.

**Sign convention.** The harness reports `(slot2/slot1 - 1) * 100`, so a **negative** percentage
means the ceiling arm was faster. All three thresholds are read as *improvement magnitudes*:
`improvement.lower = -ci95[1]`, `improvement.upper = -ci95[0]`. Promotion needs
`improvement.lower > 1.0%`; rejection needs every splitting-free fixture's `improvement.upper <
1.0%`; a material regression is `improvement.upper < -1.0%`. Reading the raw CI directly is how a
win gets mistaken for a regression, so `lib/decide.mjs` exposes `improvementOf()` and the contracts
pin the sign.

## Settle, then gate

`settle.mjs` runs after `playwright install --with-deps` and before the ambient CPU gate. Install
spikes CPU and disk, and a gate that samples immediately blocks for a reason unrelated to the
machine being busy — burning a cell of public minutes and recording `INCOMPLETE` in a way that is
indistinguishable from a genuinely busy machine. The settle is adaptive and preregistered: three
consecutive samples one second apart, each at or under 20% utilisation, 30 second ceiling, returning
as soon as the window is clean. Utilisation is measured the same way
`lane6-scratch/r5/run-with-timing-gate.mjs` measures it, so the two agree about what quiet means.

## Artifacts and retries

Artifact names are keyed on `run_id` alone — never on `run_attempt` — and a cell's artifact is
overwritten in place on retry. A rerun of failed jobs re-executes only the failed cells, keeps the
prepared artifact from the earlier attempt, and the closeout combines prior-good and retried cells
through `mergeCells`, which fails closed on anything genuinely absent or duplicated. Attempt
travels inside each payload, never in a filename, and `duplicateRunIds` exists to catch any scheme
that leaks it back out.

## Fixtures are shared with the browser suite

`__tests__/helpers/shadowCards.js` is the single definition of the shadow-card family. The hosted
page imports it as a module, the bench serves it at `/shadowCards.js`, and its hash is pinned by
`prepare.mjs`. A fixture therefore cannot quietly mean one thing locally and another on the runner.
The deterministic read census lives in `__tests__/module.styles.shadowReadCensus.test.js` and needs
no hosted runner — but it counts calls, not seconds.

## Browser-free contracts

`node --test lane6-scratch/r10-shadow/contracts/contracts.test.mjs` pins the aggregation arithmetic,
the exact-matrix completeness rules, the staged workflow shape, the retry semantics and the decision
boundaries around 1%. It runs no browser and needs no runner.

## What F4 still does not do

It does not build the partition, and it does not build the ceiling spike either. Both are specified
in the R10 audit note and neither is written here, on purpose: the preregistered rule exists to
decide whether any of that is worth writing. When the spike lands it must be a throwaway
counterfactual option, default off, with the parity evidence attached.