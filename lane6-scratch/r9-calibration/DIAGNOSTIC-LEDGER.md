# R9 hosted self-null calibration — diagnostic ledger

Status: **diagnostic only.** Nothing here is an optimization or non-regression claim, and nothing
here is promotable. This ledger now incorporates both the original 8-runner Chromium self-null and
the corrected post-settle 8-runner Chromium run from hosted calibration `37090104263`. The
post-settle controls materially change the diagnosis: stationary page costs still cancel by proof,
but the real six-page rig shows a pair-specific nonstationary AA offset and is **not ready to freeze
as the production promotion instrument**.

All algebra below is proved browser-free by
`node --test lane6-scratch/r9-calibration/algebra/selfnull-algebra.test.mjs` (19 assertions, no
Playwright import). The model in `algebra/schedule.mjs` replays the exact control flow of
`lane6-scratch/r9/bench-r9-controlled.mjs` over synthetic per-call latencies.

## 1. The measurement being interpreted

Same bundle on both arms (`--mode=option-pair`, `moduleFor = { base: 'candidate', opt: 'candidate' }`)
and identical options (`--base={}` `--opt={}`). So all six physical layouts are the *same*
configuration: same module bytes, same options object, same fixture DOM, same viewport. The only
thing that distinguishes them is the integer index they were created at.

### Original run (`37088609368`, before the post-install settle fix)

| fixture | self-null effect | runner 95% CI |
|---|---:|---:|
| light-20cards | −0.43% | [−0.92, +0.06] |
| cards400-safe | +2.62% | [−0.10, +5.41] |
| cards400-neutral-unsafe | +1.31% | [−1.19, +3.87] |
| cards400-non-neutral | +0.83% | [−1.46, +3.17] |

That run was useful for designing the instrument but its cross-engine phase became
`INCOMPLETE_EVIDENCE`: WebKit jobs sampled Playwright-install CPU tail before timing. Commit
`8c60647` added an adaptive settle phase and the run was repeated cleanly.

### Corrected post-settle run (`37090104263`)

Every completed Chromium runner reached timing after three quiet CPU windows and an ambient-gate
mean/median near zero. N=24, batch=9, 8 fresh runners:

| fixture | candidate self-null | candidate 95% CI | base-null | base-null 95% CI | opt-null | opt-null 95% CI |
|---|---:|---:|---:|---:|---:|---:|
| light-20cards | −0.27% | [−0.74, +0.20] | +0.03% | [−0.48, +0.54] | −0.09% | [−0.41, +0.24] |
| cards400-safe | +0.36% | [−1.64, +2.40] | **+2.57%** | **[+1.09, +4.08]** | +0.28% | [−1.71, +2.31] |
| cards400-neutral-unsafe | +1.40% | [+0.16, +2.65] | +0.70% | [−0.97, +2.40] | +0.83% | [−1.22, +2.92] |
| cards400-non-neutral | −0.81% | [−3.28, +1.74] | **+2.36%** | **[+1.26, +3.48]** | +0.33% | [−1.20, +1.89] |

The candidate self-null is inside ±5% on every fixture. The load-bearing result is instead the
control asymmetry: **the base-null physical pair excludes zero on safe and non-neutral while the
corresponding opt-null pair does not.** Because every arm is byte/option-identical in this
calibration, that is measurement-rig evidence, not treatment evidence.

## 2. What the estimator actually computes

Write `v_p(i) = log(mean slot2 / mean slot1)` for physical page `p` at block `i`. `crossoverEffect`
forms `forward_i = v_effectForward(i)` and `reverse_i = −v_effectReverse(i)`, so

```
blocks_i  = ½ [ v_{Pef}(i) − v_{Per}(i) ]
logPoint  = ½ [ mean_i v_{Pef} − mean_i v_{Per} ]
```

**The estimator is half the difference between two physical pages' mean slot2/slot1 ratios.**
Equivalently, and more usefully: with `BATCH = 9` odd, the `(index + b) & 1` rule hands slot1 the
surplus first position on even blocks and slot2 on odd ones, so every block's 17-call sequence is
an exact slot-mirror of the other parity, and `mean_i v_p` collapses to zero on its own.

Two consequences, both proved:

- **The estimator is blind to anything common to slot1 and slot2 within a page.** A runner-wide
  page-speed change and a runner-wide slot asymmetry both cancel exactly. A slow runner cannot
  move the point estimate.
- **The estimator cancels every stationary per-page cost exactly**, including a page×position
  interaction (`interactLog`), a per-page additive overhead, and a per-page level offset. Tested
  with all six pages carrying different arbitrary values: residual `< 1e-12`.

## 3. What this rules out

| candidate cause | verdict |
|---|---|
| module import order, URL/module-record identity | cancels — both slots are separate records of identical bytes, and the record only reaches the estimate through position |
| warm / oracle order | cancels — untimed, and no residual stationary page term survives |
| odd-batch first-position imbalance | cancels — 108 first-positions per arm over 24 blocks, and parity-mirrored |
| Latin rotation order | cancels on its own — mean within-round position is 2.5 for every layout |
| page creation order as a *stationary* offset | cancels exactly |
| page identity as a *uniform* runner effect | blind to it entirely |
| page creation order as a *non-stationary* term | **not excluded; now observed indirectly by pair-specific AA offsets** |
| GC / JIT / scheduler state | admissible only when it changes the slot differential over block time; corrected AA controls show that some such channel survives |
| per-layout scheduler state | collapses into a time-varying page×position term and can differ by physical page pair |

## 4. The surviving mechanism: nonstationary page × slot-position state

The stationary proof in §2 remains valid. Therefore a non-zero AA control requires a term that
changes **during acquisition**. The minimum model is:

```
v_p(i) = (-1)^i · a_p(i) + ε_p(i)
```

where `(-1)^i` is the odd-batch surplus-first-position sign and `a_p(i)` is the physical page's
time-varying sensitivity to that position. If `a_p(i)` is constant, the 12 even and 12 odd blocks
cancel exactly. If it changes with JIT tiering, GC/decode pressure, renderer scheduling, thermal/VM
state, or another page-specific phase transition, cancellation is no longer exact.

The current schedule makes this channel easier to leak: `shift = index % 6`, and because 6 is even,
`parity(index) === parity(index % 6)`. Batch-order parity is therefore locked to Latin-rotation
parity. Physical page pairs are also not exchangeable in wall-clock history:

- candidate uses pages 0/1,
- base-null uses pages 2/3,
- opt-null uses pages 4/5,
- all six are created, warmed and oracle-probed in a deterministic order before acquisition.

A phase transition experienced differently by pages 2/3 can therefore move base-null while pages
0/1 and 4/5 remain near zero. The corrected safe/non-neutral base-null results are direct evidence
that **some pair-specific nonstationary differential exists**.

The earlier browser-free synthetic test remains useful but its old interpretation was too strong.
A single step/relaxation model leaked ≤0.5%; that is a bound on **that synthetic model only**, not
on hosted Chromium. The corrected control means the real machine contains either repeated events,
a different time-varying shape, or another nonstationary interaction not represented by that toy
model. The hosted data falsifies using 0.5% as a real-world ceiling.

This still does **not** justify subtracting base-null from the candidate. The three pair estimates
come from different physical pages and need not share the same latent term; subtraction would
replace one unidentified bias with another.

## 5. What the corrected 8-runner result actually shows

The original run established that the 400-card cells are noisy. The corrected post-settle run adds
the missing distinction between **precision** and **control validity**:

1. **Precision:** candidate self-null runner CIs are now inside ±5% on all four Chromium fixtures.
   R=8 is therefore adequate for a ±5% *candidate-effect* equivalence statement on this sample.
2. **Control validity:** two base-null CIs exclude zero by ~1–4%, while their opt-null counterparts
   do not. This is statistically resolved physical-pair asymmetry under a true self-null.
3. **Ambient-host contamination is not the cause:** the corrected runners entered timing at roughly
   0–0.3% ambient CPU after the adaptive settle phase.
4. **A global bias is also not the cause:** signs and magnitudes differ across candidate/base/opt
   pairs and fixtures. The surviving term is pair/fixture/time specific.

Accordingly, the old statement that ordinary sampling noise "accounts for the entire observed
dispersion" is **retracted**. Sampling variance is substantial, but it is not the whole instrument:
the corrected AA controls prove a systematic nonstationary component exists.

The production conclusion is deliberately narrower:

> **Do not freeze promotion thresholds against the current six-page schedule yet.** The candidate
> self-null is precise enough for ±5%, but the control topology itself has a resolved pair-specific
> offset. First challenge the topology with a physically matched design.

### What is needed, and is not currently possible from this artifact

The decisive observation is **absent from the retained data**, because `bench-r9-controlled.mjs`
discards per-call rows and returns only batch means:

- whether `v_{Pef}` and `v_{Per}` share a *common* non-zero level across all three nulls
  (page-differential systematic) or drift independently (sampling noise);
- the position-conditional cost, and hence the size of the §4 term on real hardware;
- the sign agreement of `{candidate, baseNull, optNull}` within a runner.

## 6. Defects in the published diagnostics

Both are independent of the bias question and both are cheap to fix.

1. **`validate.mjs:21` `rawSlotBias` uses the same sign on both pages.** `crossoverEffect` flips the
   sign on the reverse page, so it reports `½(mF − mR)`; `baseSlotBias` is `½(mF + mR)`. The two
   differ by exactly `mR` — the reverse page's own slot2/slot1 ratio, which is the quantity the
   diagnostic exists to exclude.
2. **`slotInteraction` is structurally blind.** It is a difference of same-sign page averages, so a
   pure slot preference cancels out of it identically. Test: an 8% slot effect on every page yields
   `slotInteraction = 0` to `< 1e-12`. The README and `aggregate.mjs` both publish this column as a
   slot-interaction diagnostic.
3. **`withinBlockSd` / `withinSe` are read off a page-difference series.** `fx.candidate.logRatios.blocks`
   in a self-null is `½(v_Pef − v_Per)`, which is not the variance of either observation. That value
   feeds the `tau2` / `I²` heterogeneity estimator in `aggregate.mjs`.

## 7. Variance channels and the R scaling that follows

Point-estimate uncertainty has at least four channels:

| channel | scale | reducible by |
|---|---|---|
| per-call variance inside a block | `∝ 1/BATCH` under iid sampling | larger `--batch` |
| block-level sampling | `∝ 1/sqrt(BATCH·N)` under iid sampling | larger `--batch` or `--n` |
| between-runner dispersion | measured directly across fresh VMs | more runners |
| physical-page / nonstationary topology | **not iid and now empirically resolved in AA controls** | change/block/randomize the topology; more N is not guaranteed to help |

`BATCH` and `N` are interchangeable per unit cost only for the iid sampling component. The
corrected base-null offsets prove that increasing either cannot, by itself, certify this instrument.
Runner count narrows runner-level uncertainty; topology must be challenged separately.

For a ±5% equivalence gate, `halfWidth = t(R−1) · σ / √R ≤ 5.0pp`, with `σ = 3.21pp` (log-space,
from the 8 reported points) and `σ_hi = σ·√(7/χ²₀.₀₅,₇) = 5.77pp`:

| R | σ = 3.21pp (point est.) | σ = 5.77pp (upper 95% limit, 7 df) |
|---:|---:|---:|
| 4 | 5.11 ✗ | 9.18 ✗ |
| 6 | 3.37 ✓ | 6.06 ✗ |
| 8 | 2.69 ✓ | 4.83 ✓ |
| 12 | 2.04 ✓ | 3.67 ✓ |

**R = 8 already clears ±5% at the point estimate of σ, and still clears it at the upper confidence
limit, though with almost no margin. R = 6 does not survive the upper limit. R = 12 gives ~3.7pp and
is the number to fix if the gate has to be robust.** Note this is a *dispersion* budget: it says
nothing about whether a real 2% effect is detectable, which needs the systematic removed and
`BATCH·N` raised.

## 8. The blocked-layout prototype — experimental, not recommended for merge

`bench-r9-blocked.mjs` moves AB/BA inside the block: each block runs `batch/2` adjacent
replicate-pairs on one page, each pair executing the two arms in opposite orders with a seeded coin
choosing which order leads, decoupled from the block parity that causes the §4 defect.

Proved browser-free:

- it drives the §4 hostile world to **exactly zero** (`< 1e-9`);
- it lands on the **true** effect (0.0200 → 0.0200), not a bias-corrected one;
- it is **neither a variance win nor a cost win** at equal page count and equal timed-call count.

Because it extracts the same number of observation blocks for the same work, its noise is the same.
What it buys is removal of a systematic already ~10× under the floor. **There is no evidence-backed
case for merging it, and it must not be merged on the strength of the algebra alone.** It has never
been run against a browser.

`--identity-canary` (both slots loaded from one module URL) is the separate lever worth keeping: it
makes the two arms a single module record with identical physical identity, so a self-null is
exactly zero by construction rather than by argument.

## 9. Recommended next hosted experiment

**A controlled A/A challenge of the measurement topology, at equal timed-call budget.**

Run the current six-page rig and `bench-r9-blocked.mjs` side-by-side on the same fresh Chromium
runner matrix. Use `light-20cards`, `cards400-safe` and `cards400-non-neutral`; keep the same
total timed calls per fixture and at least R=8 fresh runners.

Each runner should collect four preregistered lanes:

1. **current-six-page self-null** — exact existing semantics;
2. **blocked-within-page self-null** — AB/BA paired inside the physical page, with even batch;
3. **identity-canary** — both arms share the same module URL/physical identity, giving the
   achievable exact-zero floor;
4. **reversed `LAYOUT_ORDER` current rig** — creation/warm/rotation order all reversed together,
   to expose order-coupled nonstationarity.

Add a **positive treatment control** with a known synthetic cost inserted in one arm. The alternative
rig is acceptable only if it preserves that known effect; a design that "fixes" nulls by attenuating
real treatment sensitivity is rejected.

Primary comparison metrics are runner-level and preregistered:

- absolute mean of each AA/BB control;
- maximum absolute control CI endpoint;
- between-runner SD(log) of the self-null;
- recovery of the injected positive-control effect and its CI;
- timed calls / wall-clock cost.

**Success criterion:** the blocked/matched design materially lowers the resolved base-null offsets
and between-runner dispersion **without attenuating the positive control** and without increasing
timed-call budget. If it does not, merge nothing.

An `N=96` variance-decomposition run is still useful, but it is now secondary. The corrected
base-null offsets already establish that sampling variance is not the only channel; increasing N
alone cannot certify the topology.

### Measurement changes needed before the next calibration

1. Return per-call rows (`slot`, `lead`, `ms`) alongside batch means, and retain them in the
   artifact. Everything in §5 is currently unrecoverable.
2. Record, per page: creation index, warm order index, and the warm→first-sample gap.
3. Record `performance.memory.usedJSHeapSize` per block. Heap growth is the cheapest available proxy
   for whether a GC landed inside a timed region.
4. Fix `rawSlotBias` to flip the sign on the reverse page, or rename it to what it actually measures.
5. Stop publishing `slotInteraction` as a slot diagnostic, or fix its sign convention.
6. Compute `withinSe` from a single page's ratio series, not from the page-difference blocks.
7. Export the per-runner null triplet (`candidate`, `baseNull`, `optNull`) as a first-class
   aggregate field.

## 10. Bottom line

The corrected hosted data changes the verdict:

- the candidate self-null is precise enough to fit inside ±5% with R=8;
- **the current six-page control topology is demonstrably asymmetric** on at least two 400-card
  base-null pairs;
- stationary page costs still cancel exactly, so the asymmetry must enter through nonstationary
  page × slot-position state or an equivalent time-dependent physical-page interaction;
- the old synthetic ≤0.5% bound is not a hosted-hardware ceiling;
- no null subtraction is justified;
- **the promotion policy stays unfrozen** until the current rig loses a controlled A/A challenge or
  survives it.

Do not merge `bench-r9-blocked.mjs` on algebra alone. Run it against the current rig with equal
work, identity and reversed-order canaries, and a positive treatment control. Freeze the production
instrument only after one topology shows lower null/control bias without losing treatment
sensitivity.

## 11. The equal-cost topology challenge — preregistration

Status: **the experiment is designed, proved browser-free, and NOT YET RUN.** Nothing in this
section is a result. The corrected conclusion of §10 stands unchanged: **a pair-specific
nonstationary systematic exists in the current six-page control topology, and the promotion policy
stays unfrozen until one topology wins a controlled A/A at equal cost.**

Implementation: `lane6-scratch/r9-calibration/challenge/`. Hosted workflow:
`.github/workflows/r9-topology-challenge.yml`. Browser-free contracts:
`node --test lane6-scratch/r9-calibration/challenge/algebra/topology-challenge.test.mjs`
(39 assertions; no Playwright import).

### 11.1 The equal-cost algebra

Both schedules spend exactly `2 x batch` timed calls per physical-page observation block — the
current rig runs `batch` replicate-pairs of 2 calls, the blocked rig runs `batch/2` replicate-pairs
of 4 calls — so `timedCalls = pages x blocks x 2 x batch` in both. Primary profile:

| lane | topology | pages | blocks | batch | timed calls/fixture |
|---|---|---:|---:|---:|---:|
| `current6` | current | 6 | 24 | 9 | 2592 |
| `blocked6` | blocked | 6 | 18 | 12 | 2592 |
| `identityCanary` | current | 6 | 24 | 9 | 2592 |
| `current6Reversed` | current | 6 | 24 | 9 | 2592 |
| `treatmentCurrent` | current | 8 | 24 | 9 | 3456 |
| `treatmentBlocked` | blocked | 8 | 12 | 18 | 3456 |
| per fixture | | | | | 17280 |
| per runner, 3 focus fixtures | | | | | 51840 |

Four preregistered pairs must balance **exactly**: `current6 vs blocked6`, `current6 vs
current6Reversed`, `current6 vs identityCanary`, `treatmentCurrent vs treatmentBlocked`. Equality is
not asserted from a declared constant: the tests count the calls each lane actually executes and
require the count to equal the budget, the harness re-counts its own artifact and refuses to write a
report otherwise, and `validate.mjs` re-checks all four pairs plus the runner total on the executed
artifact.

`blocks = 24, batch = 9` on the current rig is the **shipped calibration configuration**, kept on
purpose so the new dispersion numbers are comparable with §7's budget and with the corrected run.
The blocked rig matches it per page at `18 x 12 = 216 = 24 x 9`, with 18 a multiple of the 3-layout
rotation and an even batch so a block can be balanced rather than alternated. Admissible
alternatives are enumerated and asserted rather than asserted-and-hoped: `(12,18)`, `(36,6)`, `(9,24)`
and others also balance, and are rejected in `POLICY.json` for trading away temporal resolution or
within-block pairing depth.

### 11.2 Two corrections to this ledger, found while building the challenge

1. **§3's "reversing the layout order" row is not a reversal of the canonical list.** The assertion in
   `algebra/selfnull-algebra.test.mjs` uses
   `[effectReverse, effectForward, baseNullReverse, baseNullForward, optNullReverse, optNullForward]`,
   which reverses **within** each pair. A true `.reverse()` of `LAYOUT_ORDER` is
   `[optNullReverse, optNullForward, baseNullReverse, baseNullForward, effectReverse, effectForward]`,
   and it is a materially different experiment, because reversing the canonical list maps creation
   index `i -> 5 - i` and therefore **exchanges the candidate pair with the optNull pair**. The
   challenge runs the real reversal and preregisters its algebraic consequence: `baseNull` flips sign
   (the pair's two physical pages swap, and the estimator is `1/2 (v_F - v_R)`), while the candidate
   and optNull **magnitudes** should exchange. Proved browser-free at ratios 0.9998 and 1.0019. If
   the hosted run reproduces the corrected offsets WITHOUT that exchange, the asymmetry is not
   creation-order coupled and §4's mechanism is incomplete. That is falsifier 3.
2. **§8's "neither a cost win" check was loose.** It compared 2880 blocked calls against 2592 shipped
   calls and accepted anything within 12%. At equal work the two are equal **to the call**, and the
   challenge asserts exact integer equality instead.

### 11.3 The six lanes

`current6` (shipped semantics), `blocked6`, `identityCanary`, `current6Reversed`, and the positive
treatment control measured under **both** topologies at two predeclared doses. Lanes run
sequentially inside one fresh Chromium runner with execution order rotated by replicate index, so at
most eight pages are ever live and no lane systematically owns early or late runner time.

`current6Reversed` reverses the **one** canonical layout list that feeds page creation, warm order and
the Latin rotation base together. There is no second list and no per-knob ordering override, and
`validate.mjs` refuses an artifact whose reversed lane is not the exact reverse of the unreversed
lane's list.

### 11.4 What the canary is and is not

`identityCanary` loads both slots from the byte-identical module URL string, so they are one module
record with one options object: the tightest exact-zero floor browser semantics allow. It is also
**provably blind to treatment** — proved browser-free at exactly zero response to an 8% arm-keyed
effect *and* a 3 ms injected cost, while a treatment-sensitive lane responds to both. It is therefore
a validity instrument for the harness and the estimator, never a treatment comparator, and it is
excluded from every treatment comparison by construction rather than by convention.

### 11.5 The positive control

A fixed-iteration xorshift stream inside the timed region, **after** the identical `toRaw` call has
returned, on the candidate arm only, keyed to the arm and never to a position, with the accumulator
published to a page global so it cannot be elided. No production source is touched.

Preregistered: sign `positive`; effect class *additive positive shift in log(slot2/slot1),
deterministic in work units, not in milliseconds*; `predictedMagnitudePct: null`; two work counts a
fixed 4x apart so that at least one dose is expected to land in a detectable class on at least one
fixture without anyone predicting which. Realised `injectMs` is recorded per call, so the effect
class is measured rather than assumed, and `captureMs` is recorded separately on every call to prove
the injection did not perturb snapDOM's own work.

Proved browser-free: both topologies recover the injected cost to within `1e-4` log of each other,
i.e. **the blocked schedule cannot structurally attenuate an arm-bound treatment**. The hosted run
then measures whether the real machine agrees.

### 11.6 Primary comparison and success criterion

Runner-level only; `assertRunnerLevelOnly` runs on every decision document before it is written and
again on every document the closeout reads, so no per-call or per-page row can ever be pooled across
fresh VMs. Per fixture: absolute mean of each AA/BB control; maximum absolute control CI endpoint;
between-runner SD(log); treatment-control recovery and CI, differenced **within** each runner; timed
calls and wall-clock. Plus the reversal diagnostic and the canary floor.

Success stays qualitative and evidence-gated — lower null/control bias **and** lower dispersion
**and** no attenuation or sign loss of the positive control **and** no higher timed-call budget.
`attenuation` is a flag, not a gate. No automatic merge, no promotion, and no threshold is invented
here.

### 11.7 Hosted protocol

GitHub Actions only, `ubuntu-24.04`, exact measured SHA asserted after checkout, every action pinned
to a 40-hex commit. `algebra` (browser-free contracts) gates `prepare` (compile, freeze, audit both
sampling profiles for balance, emit the matrix) which gates 8 fresh `challenge` runners, then
`closeout`. Each cell: adaptive post-install settle (reused from `r9-calibration/settle.mjs`, with
`prepare.mjs` refusing to emit a plan unless the challenge's settle block is deep-equal to the
calibration's) -> ambient CPU gate wrapping the benchmark -> harness -> validator. Cell evidence is
keyed on `github.run_id` with `overwrite: true`, so a cell retry overwrites its own evidence instead
of creating a second, competing copy of the same matrix cell. `aggregate.mjs` exits non-zero on any
missing, unusable, duplicated or mis-identified cell.

### 11.8 Falsifiers, preregistered

1. the identity canary reads materially non-zero: the rig or the estimator is wrong and every lane
   is void;
2. blocked lowers control bias but its recovery CI sits strictly below the current rig's: it
   attenuates real treatment sensitivity and is rejected;
3. the corrected base-null offsets do not move when the canonical `LAYOUT_ORDER` is fully reversed:
   the asymmetry is not creation-order coupled and §4's mechanism is incomplete;
4. the asymmetry reproduces identically under both the canonical and the reversed order on every
   runner: it is a runner-wide property, not a pair-specific one, and this challenge's premise is
   wrong;
5. realised `injectMs` is small enough on a fixture that recovery is unresolvable there: that
   fixture's positive-control cell is INCONCLUSIVE and must be reported as such, not as a null.

### 11.9 What the browser-free pass has and has not established

Established, in 39 assertions: the six lanes execute the call counts they declare; every compared
pair balances exactly in both sampling profiles; the current lane reproduces
`bench-r9-controlled.mjs`'s schedule call for call against the existing independent model of it; a
full canonical reversal flips `baseNull` and exchanges the candidate/optNull magnitudes while
reversing only the rotation does not; the canary is exactly zero against a module-record channel and
provably blind to treatment; the blocked schedule drives the §4 hostile world to `< 1e-12` while the
current rig leaks, at identical total timed calls; both topologies recover the injected control; the
aggregation is runner-level, fail-closed and threshold-free; and the hosted plan still says what the
policy says it says.

Not established, and not establishable without hosted runners: which topology has lower real null
bias, what the position-conditional cost actually is on a hosted VM, whether the corrected offsets
are creation-order coupled, and whether the injected control is detectable at these doses.