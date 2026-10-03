# snapDOM R9 hosted topology challenge

A decisive, **equal-cost** hosted A/A challenge of the R9 measurement *topology*.

This lane produces evidence about the measuring instrument. It is not a benchmark of snapDOM, it
cannot produce a performance claim, and it merges nothing. `CHALLENGE_COMPLETE` means the
preregistered matrix was collected — nothing more.

## Why this exists

`lane6-scratch/r9-calibration/DIAGNOSTIC-LEDGER.md` §10 ends with a deliberately narrow production
conclusion, and this lane is the experiment that conclusion asks for:

> **Do not freeze promotion thresholds against the current six-page schedule yet.** The candidate
> self-null is precise enough for ±5%, but the control topology itself has a resolved pair-specific
> offset. First challenge the topology with a physically matched design.

The corrected 8-runner hosted calibration (`37090104263`) resolved `baseNull` at
**+2.57% [+1.09, +4.08]** on `cards400-safe` and **+2.36% [+1.26, +3.48]** on
`cards400-non-neutral`, while the corresponding `optNull` pairs on the same fixture DOM, the same
bundle bytes and the same options did not exclude zero. **A pair-specific nonstationary systematic
exists in the current six-page control topology.** That conclusion is unchanged by anything in this
directory.

`bench-r9-blocked.mjs` is the proposed alternative. It has never been run against a browser, and the
ledger is explicit that it must not be adopted on the strength of its algebra alone.

## The six preregistered lanes

Each lane runs **sequentially** inside one fresh hosted Chromium runner, so at most eight pages are
ever live and a lane's pages sit inside a single settle-to-timing window.

| lane | topology | pages | role |
|---|---|---:|---|
| `current6` | current | 6 | the shipped six-page self-null rig, exact existing semantics |
| `blocked6` | blocked | 6 | blocked-within-page AB/BA, 3 layouts × 2 pages |
| `identityCanary` | current | 6 | both slots on ONE module URL / one physical module record |
| `current6Reversed` | current | 6 | the shipped rig with the one canonical layout list fully reversed |
| `treatmentCurrent` | current | 8 | positive treatment control + its own null, two predeclared doses |
| `treatmentBlocked` | blocked | 8 | the same two doses, blocked topology |

Lane **execution** order is rotated by replicate index so no lane systematically owns early or late
runner wall-clock time.

### One canonical layout list

`laneLayoutOrder(lane)` returns the single list that feeds **page creation, warm order and the Latin
rotation base together**. `current6Reversed` is that list reversed. There is no second list and no
per-knob ordering override anywhere in the harness. `validate.mjs` refuses an artifact whose reversed
lane is not the exact reverse of the unreversed lane's canonical list.

Note this is a *true* `.reverse()` of the canonical list. The existing ledger test named "reversing
the layout order flips the latent systematic sign" reverses **within** each pair
(`[effectReverse, effectForward, baseNullReverse, …]`), which is a different permutation. The
challenge runs the real reversal and predicts its consequences (see §11 of the ledger).

### The identity canary is not a treatment lane

Both slots resolve to the **byte-identical** module URL string, so they are one module record with
one options object, not two records of identical bytes. That is as close to exact-zero physical
identity as browser semantics allow.

It is also, provably, **blind to treatment**: a same-record self-null cannot respond to an
arm-keyed cost or an injected synthetic cost, because both are common to the two slots. The
browser-free tests assert exactly zero response to an 8% arm effect *and* a 3 ms injection while a
treatment-sensitive lane responds to both. The canary is therefore a **validity instrument**, never
a treatment comparator, and it is excluded from every treatment comparison by construction.

## Equal cost is derived, asserted, and re-checked on the artifact

Both schedules spend exactly `2 × batch` timed calls per physical-page observation block:

- current rig: `batch` replicate-pairs of 2 calls;
- blocked rig: `batch / 2` replicate-pairs of 4 calls.

so for every lane `timedCalls = pages × blocks × 2 × batch`. That is a *derived* identity, and:

1. `algebra/topology-challenge.test.mjs` counts the calls each lane **actually executes** and
   requires the count to equal the declared budget, for every lane, in both sampling profiles;
2. `bench-r9-topology.mjs` counts the timed calls its own artifact contains and **refuses to write a
   report** if they disagree with the frozen budget, per lane;
3. `validate.mjs` re-checks all four preregistered compared pairs and the runner total on the
   executed artifact, and marks the cell `CHALLENGE_INVALID` if any of them differ;
4. `aggregate.mjs` refuses to compare anything whose per-lane executed cost differs from the frozen
   budget.

Warmup and oracle calls are untimed, counted separately, and can never be reclassified as budget.

### The primary profile

| lane | pages | blocks | batch | timed calls/fixture |
|---|---:|---:|---:|---:|
| `current6` | 6 | 24 | 9 | 2592 |
| `blocked6` | 6 | 18 | 12 | 2592 |
| `identityCanary` | 6 | 24 | 9 | 2592 |
| `current6Reversed` | 6 | 24 | 9 | 2592 |
| `treatmentCurrent` | 8 | 24 | 9 | 3456 |
| `treatmentBlocked` | 8 | 12 | 18 | 3456 |
| **per fixture** | | | | **17280** |
| **per runner (3 fixtures)** | | | | **51840** |

`blocks = 24, batch = 9` on the current rig is the **shipped calibration configuration**, kept
deliberately: the ledger's runner-dispersion budget (§7) and every reported self-null were measured
there, so changing it would make the new numbers incomparable. 24 is also a multiple of the 6-layout
Latin rotation, so the rotation completes exactly four rounds.

`blocked6` spends `18 × 12 = 216 = 24 × 9` units **per page**, so its total matches the current rig
to the call. 18 is a multiple of the 3-layout rotation and batch 12 is even, so a block can be
*balanced* rather than merely alternated. `enumerateBalanced` lists every admissible alternative and
the tests require the chosen one to be in it — for example `(12, 18)`, `(36, 6)` and `(9, 24)` are
also admissible, and are rejected in `POLICY.json`'s `samplingRationale` for trading away temporal
resolution or within-block pairing.

### The reduced profile, and its power tradeoff

`reduced` is an escape hatch for when runner wall-clock makes the primary profile unaffordable. It
preserves **every** equality (same total timed calls per compared pair, complete Latin rotations,
even blocked batches) at about 57% of the primary work. It is `workflow_dispatch`-selectable.

Stated rather than hidden:

- **Not degraded:** the between-runner dispersion the challenge turns on. Runner SD(log) is a
  between-runner quantity, and under the iid model it is independent of `blocks × batch` at fixed
  product.
- **Degraded:** the precision of each individual runner's point estimate, and the number of complete
  Latin rounds over which minute-scale runner drift is balanced. Null CIs get wider and drift
  common-modelling gets weaker.

It is not a substitute for the primary profile and must not be presented as one.

**Runner count is never reduced to buy wall-clock.** If the matrix does not fit, the profile is
reduced; the number of fresh Chromium runners is not. `minimumFreshRunners: 8` is enforced by the
policy audit, which `prepare.mjs` runs before emitting any matrix.

## Positive treatment control

A fixed-iteration xorshift stream runs **inside** the timed region but strictly **after** the
identical `snapdom.toRaw` call has returned, on the candidate (`opt`) arm only. It is keyed to the
**arm**, never to a position, so no position-balancing schedule can cancel it by construction. The
accumulator is published to a page global each call so the engine cannot elide it. **No production
source is touched.**

**Preregistered:** sign `positive`; effect class *an additive positive shift in log(slot2/slot1),
deterministic in work units, not in milliseconds*; `predictedMagnitudePct: null`. Two work counts a
fixed 4× apart (250000 and 1000000 iterations) are declared so that at least one dose is expected to
land in a detectable class on at least one fixture **without anyone predicting which**.

The harness records realised `injectMs` for every timed call, so the effect class is **measured, not
assumed**, and a reader can distinguish a real non-detection from a too-small injection. It also
records `captureMs` (snapDOM's own work) separately on every call, which is what proves the injection
did not perturb the library.

`validate.mjs` marks the cell invalid if the injected arm's mean `injectMs` is zero or if the control
arm's maximum `injectMs` is non-zero.

### Why attenuation is the thing to check

The ledger rejects any design that "fixes" nulls by attenuating real treatment sensitivity. The
browser-free tests prove the blocked schedule **cannot** structurally cancel an arm-bound cost —
both topologies recover it to within 1e-4 log — and the hosted run then measures whether the real
machine agrees. `aggregate.mjs` raises `attenuation` when a blocked recovery CI sits strictly below
the current rig's, and the closeout summary puts the recovery columns above the bias columns.

## Diagnostics the first calibration could not produce

The ledger's §5 records that `bench-r9-controlled.mjs` discards per-call rows, which is why the
first calibration could not tell a page-differential systematic from sampling noise. This harness
retains, per timed call:

```
[block, page, slot, position, seq, injected, ms, captureMs, injectMs]
```

plus, per physical-page observation block: `slot1`, `slot2`, `logRatio`, `callsPerPageBlock`,
`heapUsedJsHeapSize`, `meanCaptureMs`, `injectedCalls`, `meanInjectMs`, `maxControlInjectMs`; plus,
per page: `creationIndex`, `warmIndex`, `moduleUrls`, `physicalIdentityShared`, `oracle`,
`warmToFirstSampleGapMs`.

Page-specific nonstationarity is therefore directly diagnosable from the artifact.

### The ledger's §6 defects are not reproduced

| published defect | what this lane publishes instead |
|---|---|
| `rawSlotBias` averaged both pages with the same sign, so it reported ½(mF + mR) where the estimator computes ½(mF − mR) | `crossoverSlotBias` uses the estimator's own sign convention; `pageRatios` publishes **both** pages' own ratios; `legacySameSignSlotBias` is retained only so the discrepancy stays visible |
| `slotInteraction` was structurally blind to any pure slot effect | not published at all. Replaced by `positionPremiumLog` / `positionPremiumPct`, measured from the retained per-call rows as mean(log ms at first of pair) − mean(log ms at second of pair): the position-conditional cost whose size the §4 mechanism needs |
| `withinSe` was read off the page-difference block series | `withinSeLog` comes from **one** page's own per-block ratio series |

## Preregistered metrics, all runner-level

Aggregation is runner-level only. There is no code path that can accept per-call or per-page rows:
`assertRunnerLevelOnly` runs on every decision document before it is written and again on every
document the closeout reads.

Primary comparison, per fixture:

1. absolute mean of each AA/BB control;
2. maximum absolute control CI endpoint;
3. between-runner SD(log);
4. treatment-control recovery and its CI, differenced **within** each runner;
5. timed calls and wall-clock.

Plus the reversal diagnostic (does `baseNull` flip sign; do the candidate and optNull magnitudes
exchange creation index) and the canary floor.

**No threshold appears anywhere.** The success criterion stays qualitative and evidence-gated: lower
null/control bias **and** lower dispersion **and** no attenuation or sign loss of the positive control
**and** no higher timed-call budget. Nothing is merged or promoted automatically.

## Hosted execution

`.github/workflows/r9-topology-challenge.yml`, GitHub Actions only, `ubuntu-24.04`, exact measured
SHA asserted after checkout, every action pinned to a 40-hex commit.

Jobs: `algebra` (browser-free contracts, before any runner is spent) → `prepare` (compile, freeze
policy + bundle + 21 measurement-file hashes, audit policy and workflow, verify both sampling
profiles balance, emit the matrix) → `challenge` (8 fresh Chromium runners) → `closeout`.

Per runner cell: adaptive post-install settle (reused from `r9-calibration/settle.mjs`, and
`prepare.mjs` refuses to emit a plan unless the challenge's settle block is deep-equal to the
calibration's) → ambient CPU gate wrapping the benchmark → challenge → validator.

Cell evidence is keyed on **`github.run_id`**, never the retry counter, and every upload sets
`overwrite: true`. A cell retry therefore **overwrites its own evidence** instead of producing a
second, competing copy of the same matrix cell — which is what makes the closeout's fail-closed
completeness audit meaningful.

`aggregate.mjs` exits non-zero on a missing, unusable, duplicated or mis-identified cell. Zero
evidence never looks like a successful benchmark.

Chromium-only by preregistration: the ledger's resolved problem is in hosted Chromium, and widening
the matrix to other engines without a preregistered question would only cost runner minutes.

## Local commands

```bash
# browser-free: the acquisition algebra, the call budget, the aggregation and workflow contracts
node --test lane6-scratch/r9-calibration/algebra/selfnull-algebra.test.mjs
node --test lane6-scratch/r9-calibration/challenge/algebra/topology-challenge.test.mjs

# everything the browser does is refused outside GitHub Actions, on purpose
node lane6-scratch/r9-calibration/challenge/bench-r9-topology.mjs
# Error: R9 browser benchmarks are GitHub-Actions-only. ...
```

There is no local browser path and there must not be one.

## Files

| path | role |
|---|---|
| `POLICY.json` | the preregistration: lanes, both sampling profiles, doses, success criterion, falsifiers |
| `bench-r9-topology.mjs` | the hosted harness; all six lanes, per-call retention, budget enforcement |
| `prepare.mjs` | GitHub-only provenance freeze + policy/workflow audit + matrix emission |
| `run.mjs` | per-cell provenance re-verification, then spawns the harness |
| `validate.mjs` | artifact → one runner-level decision document; corrected §6 diagnostics |
| `aggregate.mjs` | runner-level closeout; fail-closed; never decides |
| `algebra/call-budget.mjs` | lane table, arm table, budget algebra, admissible-count enumeration |
| `algebra/topology-model.mjs` | browser-free replay of all six lanes over synthetic per-call latencies |
| `algebra/aggregate-contract.mjs` | runner-level statistics, fail-closed completeness, no-raw-pooling guard |
| `algebra/workflow-contract.mjs` | structural audit of the workflow and the policy |
| `algebra/topology-challenge.test.mjs` | 39 browser-free assertions over all of the above |
