/**
 * Browser-free algebra ledger for the R9 self-null calibration.
 *
 * Run: node --test lane6-scratch/r9-calibration/algebra/selfnull-algebra.test.mjs
 *
 * Nothing here launches a browser or imports Playwright. Every assertion is a property of the
 * acquisition algebra in lane6-scratch/r9/protocol.mjs plus the schedule in ./schedule.mjs, so a
 * pass or fail is a statement about the rig, not about any hosted runner.
 *
 * The headline result is negative and is the reason this ledger exists: the shipped crossover
 * cancels every stationary per-page cost model exactly, so the +2.62% cards400-safe aggregate is
 * NOT explained by any stationary physical asymmetry. What is left is a bounded latent systematic
 * and a variance budget, and this file separates them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BLOCKED_LAYOUTS,
  aggregateRunnerPoints,
  blockedEffect,
  crossoverEffect,
  makeCall,
  runBlockedLayout,
  runCurrentLayout,
  selfNullAsPageDifference,
} from './schedule.mjs'

const N = 24
const BATCH = 9
const WARMUP = 6
const EPS = 1e-12

const pctOf = (logPoint) => (Math.exp(logPoint) - 1) * 100
const reported = [8.88, 5.21, 3.75, 3.09, 1.38, 0.85, -0.51, -1.34]
const REPORTED_RUNNER_SD_PP = 3.3
const T975 = { 3: 3.182, 4: 2.776, 5: 2.571, 7: 2.365, 9: 2.262, 11: 2.201, 15: 2.131, 23: 2.069 }
const tOf = (df) => T975[df] ?? 1.96

function current(world, overrides = {}) {
  const call = makeCall(world)
  const { rows } = runCurrentLayout(call, { n: N, batch: BATCH, warmup: WARMUP, ...overrides })
  return {
    rows,
    effect: crossoverEffect(rows.effectForward, rows.effectReverse, 1, 2000),
    baseNull: crossoverEffect(rows.baseNullForward, rows.baseNullReverse, 3, 2000),
    optNull: crossoverEffect(rows.optNullForward, rows.optNullReverse, 5, 2000),
  }
}

// ---------------------------------------------------------------------------
// 1. What the estimator actually is
// ---------------------------------------------------------------------------

test('the estimator is exactly half the difference between two pages mean slot2/slot1 ratios', () => {
  const world = { baseMs: 40, posLog: { first: 0, second: -0.03 }, noiseLog: 0.05, seed: 7 }
  const { rows, effect } = current(world)
  const { forward, reverse, estimator } = selfNullAsPageDifference(rows)
  assert.ok(Math.abs(effect.logPoint - estimator) < 1e-12, `${effect.logPoint} != ${estimator}`)
  assert.ok(Math.abs(forward) < 0.05 && Math.abs(reverse) < 0.05,
    `each page should read near zero in a self-null: ${forward} ${reverse}`)
})

test('the estimator is blind to a runner-wide page speed and to a runner-wide slot asymmetry', () => {
  // Both are common to slot1 and slot2 within a page, so they cannot move the page's slot2/slot1
  // ratio. This is why "the runner was slow today" cannot explain a between-runner spread in the
  // point estimate, and it bounds which variance channels are even admissible.
  const slow = current({ baseMs: 40, pageLog: 0.20, posLog: { first: 0, second: 0 }, seed: 11 })
  const skewed = current({ baseMs: 40, interactLog: -0.06, posLog: { first: 0, second: 0 }, seed: 13 })
  assert.ok(Math.abs(slow.effect.logPoint) < EPS, `runner speed leaked ${slow.effect.logPoint}`)
  assert.ok(Math.abs(skewed.effect.logPoint) < EPS, `uniform slot asymmetry leaked ${skewed.effect.logPoint}`)
})

// ---------------------------------------------------------------------------
// 2. The central negative result: stationary physical asymmetry cancels exactly
// ---------------------------------------------------------------------------

test('every stationary per-page cost cancels exactly, including page x position interaction', () => {
  // Hostile but STATIC: page 0 is 2% worse at holding the first slot of a pair, page 1 is 1% worse,
  // pages 2..5 carry their own arbitrary offsets and additive overheads. Nothing moves over time.
  const world = {
    baseMs: 40,
    pageLog: [0.01, -0.02, 0.03, 0.0, -0.01, 0.02],
    additiveMs: [3, 0, 7, 1, 5, 2],
    interactLog: [-0.02, -0.01, 0.03, 0.0, 0.01, -0.03],
    posLog: { first: 0, second: -0.04 },
    seed: 17,
  }
  const { effect, baseNull, optNull } = current(world)
  for (const [name, r] of [['effect', effect], ['baseNull', baseNull], ['optNull', optNull]]) {
    assert.ok(Math.abs(r.logPoint) < EPS, `${name} leaked ${r.logPoint}`)
  }
})

test('odd batch, the Latin rotation and additive overhead leak nothing on their own', () => {
  const world = {
    baseMs: 40,
    pageLog: [0.01, -0.02, 0.03, -0.03, 0.02, 0.0],
    additiveMs: [2, 5, 0, 8, 1, 4],
    posLog: { first: 0, second: -0.04 },
    seed: 19,
  }
  const { effect, baseNull, optNull } = current(world)
  for (const [name, r] of [['effect', effect], ['baseNull', baseNull], ['optNull', optNull]]) {
    assert.ok(Math.abs(r.logPoint) < EPS, `${name} leaked ${r.logPoint}`)
  }
})

test('a smooth wall-clock relaxation of the first-of-pair cost is also absorbed', () => {
  const world = {
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    interactLog: (_page, t) => -0.9 * Math.exp(-t / 3),
    seed: 23,
  }
  const pct = pctOf(current(world).effect.logPoint)
  assert.ok(Math.abs(pct) < 0.1, `smooth relaxation leaked ${pct.toFixed(4)}%, expected under 0.1%`)
})

// ---------------------------------------------------------------------------
// 3. The one real defect in the schedule, and its ceiling
// ---------------------------------------------------------------------------

test('the batch-order parity is locked to the Latin rotation parity', () => {
  // shift = index % 6 and parity(index) === parity(index % 6), so the layouts that go first in a
  // round are exactly the layouts whose batch hands slot1 the surplus first position. The harness
  // correlates "early in the round" with "first of the pair" on 16 of 24 blocks, against 12 of 24
  // expected if the correlation were chance.
  const pairs = []
  for (let i = 0; i < N; i++) {
    const shift = i % 6
    const order = [...Array(6).keys()].slice(shift).concat([...Array(6).keys()].slice(0, shift))
    const posF = order.indexOf(0)
    const posR = order.indexOf(1)
    const surplusToSlot1 = (i & 1) === 0
    pairs.push({ aligned: surplusToSlot1 ? posF < posR : posF > posR })
  }
  assert.equal(pairs.filter((p) => p.aligned).length, 16)
})

test('the locked parity yields a real but small systematic, bounded by step size over 2N', () => {
  // Each discontinuity of the page x position term contributes at most half its own size divided
  // by N, because the alternating block parity only ever sums to +/-1 over the affected window.
  const phase = [2.0, 0.0, 1.4, 0.3, 1.1, 0.6]
  const step = (t, thr, s) => (t > thr ? s : 0)
  const world = (scale) => ({
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    interactLog: (p, t) => -scale * step(t + phase[p], 8, 1.0) - scale * step(t + phase[p], 15, 0.4),
    seed: 29,
  })
  const at = (scale) => Math.abs(current(world(scale)).effect.logPoint)
  assert.ok(at(0.2) > 1e-4, 'the mechanism must produce a non-zero leak')
  const ratio = at(0.4) / at(0.2)
  assert.ok(ratio > 1.85 && ratio < 2.15, `leak should be linear in step size, got ${ratio.toFixed(2)}`)
  // A step of 1.6 means the first-of-pair call on one page costs exp(1.6) = 5x the other page.
  // Even then the leak is a small fraction of a percent, well under the 3.3pp noise floor.
  assert.ok(pctOf(at(1.6)) < 0.5, `leak at an absurd 5x first-position penalty is ${pctOf(at(1.6)).toFixed(3)}%`)
  assert.ok(pctOf(at(1.6)) < REPORTED_RUNNER_SD_PP / 5, 'and still an order of magnitude under the floor')
})

test('reversing the layout order flips the latent systematic sign', () => {
  // The harness keeps ONE list, LAYOUT_ORDER, that drives page creation, warm order and the Latin
  // rotation together. Reordering that single list is therefore the honest experiment. Reversing
  // creation alone is not enough: it swaps the page keys but leaves the rotation, and the leak
  // depends on the page-keyed term evaluated at each layout's within-round position.
  const phase = [2.0, 0.0, 1.4, 0.3, 1.1, 0.6]
  const step = (t, thr, s) => (t > thr ? s : 0)
  const world = {
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    interactLog: (p, t) => -step(t + phase[p], 8, 1.0) - step(t + phase[p], 15, 0.4),
    seed: 31,
  }
  const reversed = ['effectReverse', 'effectForward', 'baseNullReverse', 'baseNullForward', 'optNullReverse', 'optNullForward']
  const forward = current(world).effect.logPoint
  const flipped = current(world, { pageOrder: reversed, rotationBase: reversed }).effect.logPoint
  assert.ok(forward < 0 && flipped > 0, `expected a sign flip: ${forward} vs ${flipped}`)
  assert.ok(Math.abs(forward + flipped) / Math.abs(forward) < 0.05, 'and near-exact antisymmetry')
})

// ---------------------------------------------------------------------------
// 4. The experimental blocked layout: correct, but not measurably better
// ---------------------------------------------------------------------------

test('blocked layout removes the latent systematic entirely', () => {
  const phase = [2.0, 0.0, 1.4, 0.3, 1.1, 0.6]
  const step = (t, thr, s) => (t > thr ? s : 0)
  const world = {
    baseMs: 40,
    posLog: { first: 0, second: -0.05 },
    pageLog: [0.02, -0.01, 0.03, 0.0, -0.02, 0.01],
    additiveMs: [4, 0, 9, 1, 5, 2],
    interactLog: (p, t) => -step(t + phase[p], 8, 1.0) - step(t + phase[p], 15, 0.4),
    seed: 37,
  }
  const shipped = current(world).effect.logPoint
  const call = makeCall(world)
  const { blocks } = runBlockedLayout(call, { n: N, batch: 10, pagesPerLayout: 2, seed: 41 })
  const paired = blocks.effect.map((p) => p.reduce((a, b) => a + b, 0) / p.length)
  const design = blockedEffect(paired, 43, 2000).logPoint
  assert.ok(Math.abs(shipped) > 1e-4, 'the shipped design must be biased on this world')
  assert.ok(Math.abs(design) < 1e-9, `blocked residual ${design}`)
})

test('blocked layout lands on the true effect rather than a bias-corrected one', () => {
  const world = { baseMs: 40, armLog: 0.02, posLog: { first: 0, second: -0.05 }, seed: 47 }
  const call = makeCall(world)
  const { blocks } = runBlockedLayout(call, { n: N, batch: 10, pagesPerLayout: 2, seed: 53 })
  const paired = blocks.effect.map((p) => p.reduce((a, b) => a + b, 0) / p.length)
  assert.ok(Math.abs(blockedEffect(paired, 59, 2000).logPoint - 0.02) < 1e-9)
})

test('blocked layout is neither a variance win nor a cost win at equal page count', () => {
  // Why the prototype is experimental and not recommended for merge: at the same six pages and the
  // same timed-call count it extracts the same number of observation blocks, so its noise is the
  // same. It only removes a systematic that is already an order of magnitude under the floor.
  let calls = 0
  const counting = () => { calls += 1; return 40 }
  runBlockedLayout(counting, { n: N, batch: 10, pagesPerLayout: 2, seed: 61 })
  const blockedTimed = calls - 6 * WARMUP * 2
  const shippedTimed = 6 * N * BATCH * 2
  assert.equal(BLOCKED_LAYOUTS.length * 2, 6)
  assert.ok(Math.abs(blockedTimed - shippedTimed) / shippedTimed < 0.12,
    `blocked ${blockedTimed} vs shipped ${shippedTimed}`)
  assert.throws(() => runBlockedLayout(counting, { n: 4, batch: 9, seed: 67 }), /even batch/)
})

// ---------------------------------------------------------------------------
// 5. Defects in the published diagnostics
// ---------------------------------------------------------------------------

test('validate.mjs rawSlotBias averages both pages with the same sign', () => {
  // crossoverEffect flips the sign on the reverse page, so it reports 1/2 (mF - mR). validate.mjs
  // does not, so its baseSlotBias is 1/2 (mF + mR). The two differ by exactly mR, which is the
  // quantity the diagnostic is supposed to be excluding.
  const phase = [2.0, 0.0, 1.4, 0.3, 1.1, 0.6]
  const step = (t, thr, s) => (t > thr ? s : 0)
  const { rows } = current({
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    interactLog: (p, t) => -step(t + phase[p], 8, 1.0) - step(t + phase[p], 15, 0.4),
    seed: 71,
  })
  const mF = rows.baseNullForward.reduce((a, r) => a + Math.log(r.slot2 / r.slot1), 0) / N
  const mR = rows.baseNullReverse.reduce((a, r) => a + Math.log(r.slot2 / r.slot1), 0) / N
  const validateBaseSlotBias = (mF + mR) / 2
  const estimator = (mF - mR) / 2
  assert.ok(Math.abs(mR) > 1e-3, 'the reverse page ratio must be non-trivial for this to bite')
  assert.ok(Math.abs(validateBaseSlotBias - estimator - mR) < 1e-12)
})

test('the published slot-interaction column cannot see a slot effect at all', () => {
  const world = { baseMs: 40, interactLog: -0.08, seed: 73 }
  const { rows } = current(world)
  const bias = (a, b) => {
    const ra = rows[a].reduce((s, r) => s + Math.log(r.slot2 / r.slot1), 0) / N
    const rb = rows[b].reduce((s, r) => s + Math.log(r.slot2 / r.slot1), 0) / N
    return (ra + rb) / 2
  }
  const slotInteraction = bias('optNullForward', 'optNullReverse') - bias('baseNullForward', 'baseNullReverse')
  assert.ok(Math.abs(slotInteraction) < EPS, `slot-interaction read ${slotInteraction} for an 8% slot effect`)
})

test('within-runner variance is read off a page-difference series', () => {
  // validate.mjs reports withinBlockSd / withinSe from fx.candidate.logRatios.blocks, which in a
  // self-null is 1/2 (v_forward - v_reverse). Two pages that have drifted apart give that series a
  // different variance from either page's own ratio series, so the number fed to the I2 / tau2
  // heterogeneity estimator is not the variance of a single observation.
  const { rows, effect } = current({
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    interactLog: (p, t) => -0.9 * Math.exp(-t / 3),
    seed: 79,
  })
  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
  }
  const singlePage = rows.effectForward.map((r) => Math.log(r.slot2 / r.slot1))
  assert.ok(sd(effect.logRatios.blocks) < sd(singlePage),
    `page-difference sd ${sd(effect.logRatios.blocks).toFixed(4)} should sit below single-page sd ${sd(singlePage).toFixed(4)}`)
})

// ---------------------------------------------------------------------------
// 6. The variance budget and the R scaling that follows from the first result
// ---------------------------------------------------------------------------

test('the reported aggregate is a plain Student-t on eight runner points', () => {
  const points = reported.map((p) => Math.log(1 + p / 100))
  const agg = aggregateRunnerPoints(points, tOf)
  assert.ok(Math.abs(agg.pct - 2.62) < 0.12, `reproduced ${agg.pct.toFixed(2)}%`)
  assert.ok(Math.abs(agg.ci95[0] - -0.10) < 0.12, `lo ${agg.ci95[0].toFixed(2)}`)
  assert.ok(Math.abs(agg.ci95[1] - 5.41) < 0.12, `hi ${agg.ci95[1].toFixed(2)}`)
  assert.ok(Math.abs(agg.runnerSdLog * 100 - REPORTED_RUNNER_SD_PP) < 0.15)
})

test('the original between-runner spread is compatible with sampling variance', () => {
  // This is a compatibility calculation, NOT an exclusion of systematic error. The corrected
  // post-settle run later resolved non-zero base-null physical-pair offsets. Here we prove only
  // that the original 3.3pp runner spread did not, by itself, require a systematic term.
  // A block log-ratio sd of s over N blocks gives a per-runner point sd of s / sqrt(N).
  const impliedBlockSdPp = REPORTED_RUNNER_SD_PP * Math.sqrt(N)
  assert.ok(Math.abs(impliedBlockSdPp - 16.2) < 0.5, `implied block sd ${impliedBlockSdPp.toFixed(1)}pp`)
  assert.ok(impliedBlockSdPp / 100 < 0.50, 'and comfortably inside the 0.50 stability ceiling')
})

test('the original +2.62% candidate aggregate is statistically plausible under a zero-mean model', () => {
  const seOfMean = REPORTED_RUNNER_SD_PP / Math.sqrt(8)
  assert.ok(Math.abs(seOfMean - 1.18) < 0.02, `SE of the eight-runner mean is ${seOfMean.toFixed(2)}pp`)
  const z = 2.62 / seOfMean
  assert.ok(z > 2.0 && z < 2.5, `the point estimate sits at ${z.toFixed(2)} standard errors from zero`)
  // Two-sided normal tail at z = 2.2 is about 2.8%, so one in ~36 such calibrations looks this big.
  assert.ok(z < 2.6, 'the candidate point alone cannot distinguish null noise from a separate rig systematic')
})

test('runner count required for a five-percent equivalence gate', () => {
  const points = reported.map((p) => Math.log(1 + p / 100))
  const mean = points.reduce((a, b) => a + b, 0) / points.length
  const sdPp = Math.sqrt(points.reduce((a, b) => a + (b - mean) ** 2, 0) / 7) * 100
  assert.ok(Math.abs(sdPp - REPORTED_RUNNER_SD_PP) < 0.15, `log-space runner SD ${sdPp.toFixed(2)}pp`)

  const halfWidth = (reps, sigma) => tOf(reps - 1) * sigma / Math.sqrt(reps)
  // Point estimate of sigma.
  assert.ok(halfWidth(4, sdPp) > 5.0, `R=4 gives ${halfWidth(4, sdPp).toFixed(2)}pp`)
  assert.ok(halfWidth(6, sdPp) <= 5.0, `R=6 gives ${halfWidth(6, sdPp).toFixed(2)}pp`)
  // Upper 95% confidence limit on sigma from seven degrees of freedom.
  const sdHi = sdPp * Math.sqrt(7 / 2.167)
  assert.ok(halfWidth(8, sdHi) <= 5.0, `R=8 at the upper sigma limit gives ${halfWidth(8, sdHi).toFixed(2)}pp`)
  assert.ok(halfWidth(6, sdHi) > 5.0, `R=6 at the upper sigma limit gives ${halfWidth(6, sdHi).toFixed(2)}pp`)
  assert.ok(halfWidth(12, sdHi) <= 4.0, `R=12 at the upper sigma limit gives ${halfWidth(12, sdHi).toFixed(2)}pp`)
})

test('under the iid sampling model, N and batch are interchangeable per unit timed-call cost', () => {
  // This describes only the sampling component. The corrected AA controls prove the real rig also
  // has a topology/nonstationarity component, which increasing N or batch need not remove.
  const pointSd = (batch, n) => 1 / Math.sqrt(batch * n)
  assert.ok(Math.abs(pointSd(9, 24) - pointSd(24, 9)) < 1e-12, 'batch and N trade off one for one')
  assert.ok(Math.abs(pointSd(9, 96) / pointSd(9, 24) - 0.5) < 1e-12, 'quadrupling N halves the sd')
  assert.ok(pointSd(9, 96) < pointSd(9, 24))
})