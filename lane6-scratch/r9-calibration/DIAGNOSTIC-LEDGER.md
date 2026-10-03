# R9 hosted self-null calibration — diagnostic ledger

Status: **diagnostic only.** Nothing here is an optimization or non-regression claim, and nothing
here is promotable. This ledger records what the first 8-runner Chromium self-null does and does
not establish, and what has to be measured next.

All algebra below is proved browser-free by
`node --test lane6-scratch/r9-calibration/algebra/selfnull-algebra.test.mjs` (19 assertions, no
Playwright import). The model in `algebra/schedule.mjs` replays the exact control flow of
`lane6-scratch/r9/bench-r9-controlled.mjs` over synthetic per-call latencies.

## 1. The measurement being interpreted

Same bundle on both arms (`--mode=option-pair`, `moduleFor = { base: 'candidate', opt: 'candidate' }`)
and identical options (`--base={}` `--opt={}`). So all six physical layouts are the *same*
configuration: same module bytes, same options object, same fixture DOM, same viewport. The only
thing that distinguishes them is the integer index they were created at.

Observed, `chromium`, N=24, batch=9, 8 fresh runners:

| fixture | self-null effect | runner 95% CI |
|---|---:|---:|
| light-20cards | −0.43% | [−0.92, +0.06] |
| cards400-safe | +2.62% | [−0.10, +5.41] |
| cards400-neutral-unsafe | +1.31% | [−1.19, +3.87] |
| cards400-non-neutral | +0.83% | [−1.46, +3.17] |

Individual `cards400-safe` runners: +8.88, +5.21, +3.75, +3.09, +1.38, +0.85, −0.51, −1.34.

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
| page creation order as a *non-stationary* term | **not excluded** — see §4, but bounded at ≲0.5% |
| GC / JIT / scheduler state | only admissible via the non-stationary term of §4, or via block-level variance |
| per-layout scheduler state | collapses into the same page×position term |

## 4. The one real defect, and its ceiling

`shift = index % 6`, and `parity(index) === parity(index % 6)` because 6 is even. The batch-order
parity `(index + b) & 1` is therefore locked to the Latin-rotation parity: **16 of every 24 blocks
align "this layout was sampled early in the round" with "this layout's slot1 held the surplus first
position"**, against 12 of 24 if the correlation were chance.

That makes any *time-varying* page×position term leak. Each discontinuity contributes at most half
its own size divided by `N`, because the alternating block parity only sums to ±1 over the affected
window. With a discontinuity large enough to be physical — a first-of-pair interrupt at `exp(1.6) ≈ 5×`
the other page's call — the leak is **−0.31%**, well under the 3.3pp noise floor. Reversing
`LAYOUT_ORDER` flips its sign to +0.22%, near-exactly antisymmetric.

**A smooth wall-clock relaxation of the same term leaks < 0.1%.** So:

> The locked parity is a genuine correctness defect, but it is an order of magnitude too small to
> have produced +2.62% on `cards400-safe`. It must be fixed eventually; it does not explain this result.

## 5. What the 8-runner result actually shows

Reconstructing the closeout aggregate exactly (Student-t on 8 log-point estimates, `t₇ = 2.365`)
reproduces +2.62% and [−0.10, +5.41] to within rounding, and gives **runner SD(log) ≈ 3.3pp**.

The harness already names this quantity: `maxPairLogSd` is the SD of the per-block log-ratio, and
`POLICY.json` caps it at `0.50`. A per-runner point estimate is the mean of `N = 24` blocks, so

```
SD(runner point) = blockSd / sqrt(N)
SD = 3.3pp  =>  blockSd = 3.3 * sqrt(24) = 16.2pp
```

**The rig ran at 16.2pp against its own 50pp preregistered ceiling — about a third of it.** Ordinary
sampling noise at the harness's own stability threshold accounts for the entire observed dispersion.
No systematic term is required.

Consequences for reading the table in §1:

- The +2.62% is **2.2 standard errors** of an 8-sample mean whose expected SD is `3.3/√8 = 1.18pp`.
  A two-sided normal tail at 2.2σ is ≈2.8%, so roughly one null calibration in 36 looks this large.
- **7 of 8 runners positive** is a sign test at `p ≈ 0.035` one-sided. Suggestive, not conclusive,
  and *inconsistent with a purely global systematic*, because `light-20cards` aggregates to −0.43%.
- **The result does not establish a bias.** It establishes that the rig's noise floor is ~3.3pp of
  between-runner dispersion at N=24, which makes a ±2% epsilon unresolvable by construction.
- **The result also does not certify the rig.** A single underpowered run cannot distinguish "no
  systematic" from "a systematic smaller than the floor". Both readings are consistent with the data.

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

Point-estimate variance decomposes into three channels:

| channel | scale | reducible by |
|---|---|---|
| per-call variance inside a block | `∝ 1/BATCH` | larger `--batch` |
| block-level sampling | `∝ 1/sqrt(BATCH·N)` | larger `--batch` or `--n` |
| between-runner dispersion | the 3.3pp observed | more runners only |

`BATCH` and `N` are **interchangeable per unit cost** — both are linear in the timed-call count and
the point SD is `∝ 1/sqrt(BATCH·N)`, so doubling `N` buys exactly what halving `BATCH` buys. Neither is
a free lever. The only lever that is not paid for in wall clock is runner count, and it buys only the
channel that dominates here.

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

**One run, unchanged measurement, `N` raised — the variance decomposition experiment.**

Run `bench-r9-controlled.mjs` exactly as the calibration does, but with `--n=96` instead of 24, on
`cards400-safe` and `light-20cards` only, 8 Chromium runners, then read the runner SD of the
per-runner point estimates.

- **σ(N=96) ≈ 1.65pp** → the 3.3pp is within-runner sampling noise. The rig is unbiased at this
  scale; the fix is `BATCH·N` and runner count, nothing else. Merge nothing.
- **σ(N=96) ≈ 3.3pp (flat)** → there is a runner- or fixture-level systematic that no amount of
  blocking has touched, and the §4 hypothesis is dead. Go look for a channel that survives at
  constant page count.

This is decisive because it is the one measurement that separates the two surviving explanations, and
it needs no change to the measurement semantics, so it is comparable against the existing artifacts.

Run alongside it, at zero marginal cost on the same runners:

- **per-runner sign agreement across `{candidate, baseNull, optNull}`** — three independent
  estimates of the same null quantity. A shared non-zero mean is the page-differential systematic;
  independent scatter is noise. This is the single most informative quantity in the existing
  artifacts and it is already in hand — it only needs `validate.mjs` to stop discarding it.
- **`--reverse-layout-order`**, for a direct read on the §4 term. Expect ≤0.5%; anything larger
  means the §4 ceiling derivation is wrong and needs revisiting.
- **`--identity-canary`**, as the exact-zero floor the pipeline can produce when physical identity
  is matched.

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

The rig is **not** demonstrably biased. It is **demonstrably underpowered** at 8 runners for a ±2%
epsilon, and it has one real scheduling defect whose magnitude is an order of magnitude below the
noise it already has. Fix the diagnostics, run the `N=96` decomposition, and choose the next step
from that. Do not merge the blocked layout until a hosted A/A shows it lowers runner-level
dispersion.