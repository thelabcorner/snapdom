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