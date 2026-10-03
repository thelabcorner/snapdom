/**
 * Browser-free contract for the R9 hosted topology challenge.
 *
 * Run: node --test lane6-scratch/r9-calibration/challenge/algebra/topology-challenge.test.mjs
 *
 * Nothing here launches a browser or imports Playwright. Every assertion is a property of the
 * acquisition algebra, the call budget, the aggregation contract or the workflow contract, so a pass
 * or a fail is a statement about the instrument and not about any hosted runner.
 *
 * The tests are grouped the way the ledger's section 9 asks the challenge to be justified:
 *
 *   1. EQUAL COST.      the current and blocked comparisons spend exactly the same timed calls,
 *                       derived from the executed control flow and not from a declared constant;
 *   2. FIDELITY.        the challenge's current lane replays bench-r9-controlled.mjs's schedule
 *                       call for call, so "current rig" means what it says;
 *   3. TOPOLOGY.        what each lane actually does to a hostile nonstationary world, with noise
 *                       switched OFF so a bias is separable from sampling noise;
 *   4. SENSITIVITY.     the identity canary is provably blind to treatment, and the positive
 *                       control is provably NOT cancelled by the blocked schedule;
 *   5. AGGREGATION.     runner-level only, fail-closed, and no threshold anywhere;
 *   6. WORKFLOW.        the hosted plan still says what the policy says it says.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  DOSES,
  EQUAL_BUDGET_PAIRS,
  LANES,
  LANE_NAMES,
  armsFor,
  armsForLane,
  budgetPairReport,
  describeSamplingProfile,
  enumerateBalanced,
  injectedArmsFor,
  isTreatmentLayout,
  laneBudget,
  laneExecutionOrder,
  laneLayoutOrder,
  lanePages,
  laneSampling,
  samplingOnlyPointSd,
  totalTimedCalls,
} from './call-budget.mjs'
import {
  evaluateLane,
  hostileNonstationaryWorld,
  makeChallengeCall,
  measureLane,
  recordChannelWorld,
  runBlockedLane,
  runCrossoverLane,
  runLane,
} from './topology-model.mjs'
import { runCurrentLayout } from '../../algebra/schedule.mjs'
import {
  assertRunnerLevelOnly,
  completenessAudit,
  controlCell,
  mean,
  pairedRecovery,
  pctFromLog,
  primaryComparison,
  recoveryContrast,
  runnerAggregate,
  t975,
  variance,
} from './aggregate-contract.mjs'
import { auditPolicy, auditWorkflow } from './workflow-contract.mjs'

const ROOT = process.cwd()
const CHAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge')
const POLICY = JSON.parse(fs.readFileSync(path.join(CHAL, 'POLICY.json'), 'utf8'))
const CAL_POLICY = JSON.parse(fs.readFileSync(
  path.resolve(ROOT, 'lane6-scratch/r9-calibration/POLICY.json'), 'utf8'))
const WORKFLOW = fs.readFileSync(
  path.resolve(ROOT, '.github/workflows/r9-topology-challenge.yml'), 'utf8')

const PRIMARY = POLICY.sampling.primary
const REDUCED = POLICY.sampling.reduced
const pctOf = (logPoint) => (Math.exp(logPoint) - 1) * 100
const EPS = 1e-12
/** Bias assertions run on a NOISELESS world: sampling noise and systematic bias are different
 *  quantities and a test that cannot tell them apart cannot assert either. */
const SILENT = { noiseLog: 0 }

const cells = (lane, world, opts = {}) =>
  evaluateLane(lane, runLane(world, lane, PRIMARY, opts).data, { seed: 1, bootstrap: 2000 })

// ---------------------------------------------------------------------------
// 1. EQUAL COST
// ---------------------------------------------------------------------------

test('the policy declares exactly the six preregistered lanes and the algebra knows all of them', () => {
  assert.equal(LANE_NAMES.length, 6)
  assert.deepEqual([...POLICY.lanes].sort(), [...LANE_NAMES].sort())
  assert.deepEqual(POLICY.fixtures, ['light-20cards', 'cards400-safe', 'cards400-non-neutral'])
})

test('every preregistered compared pair spends EXACTLY equal timed calls, in both profiles', () => {
  for (const [name, sampling] of [['primary', PRIMARY], ['reduced', REDUCED]]) {
    const report = budgetPairReport(sampling)
    assert.equal(report.length, EQUAL_BUDGET_PAIRS.length)
    for (const row of report) {
      assert.equal(row.timedCalls[0], row.timedCalls[1],
        `${name}: ${row.pair.join(' vs ')} spends ${row.timedCalls.join(' / ')} timed calls`)
      assert.ok(row.samplingOnlyPointSdEqual,
        `${name}: ${row.pair.join(' vs ')} does not equalize the iid sampling channel`)
    }
  }
})

test('the timed-call budget equals the calls the schedules ACTUALLY execute', () => {
  // This is the load-bearing budget proof. `timedCalls` is not a declared constant: it is counted
  // from the executed control flow of every lane, warmup and oracle included in the untimed side.
  for (const [name, sampling] of [['primary', PRIMARY], ['reduced', REDUCED]]) {
    for (const lane of LANE_NAMES) {
      const run = runLane(hostileNonstationaryWorld({ seed: 5 }), lane, sampling, {})
      const declared = laneBudget(lane, sampling)
      assert.equal(run.counter.timed, declared.timedCalls,
        `${name}/${lane}: executed ${run.counter.timed}, declared ${declared.timedCalls}`)
      assert.equal(run.counter.untimed, declared.warmCalls + declared.oracleCalls,
        `${name}/${lane}: untimed calls ${run.counter.untimed}, declared ${declared.warmCalls + declared.oracleCalls}`)
    }
  }
})

test('warmup and oracle calls are never counted as budget', () => {
  const warm = laneBudget('current6', { ...PRIMARY, warmup: 0 })
  assert.equal(warm.warmCalls, 0)
  assert.equal(warm.timedCalls, laneBudget('current6', PRIMARY).timedCalls)
  assert.ok(laneBudget('current6', PRIMARY).warmCalls > 0)
  assert.ok(laneBudget('current6', PRIMARY).oracleCalls > 0)
})

test('both schedules spend exactly 2 * batch timed calls per physical-page observation block', () => {
  for (const lane of LANE_NAMES) {
    const batch = PRIMARY.batch[lane]
    const profile = { warmup: 0, blocks: { [lane]: 4 }, batch: { [lane]: batch } }
    const run = runLane({ baseMs: 10 }, lane, profile, {})
    const declared = laneBudget(lane, { ...PRIMARY, warmup: 0, blocks: { ...PRIMARY.blocks, [lane]: 4 } })
    assert.equal(run.counter.timed, declared.pages * 4 * 2 * batch)
    const rows = LANES[lane].topology === 'current'
      ? run.data.pages
      : Object.values(run.data.pageRows).flat()
    assert.equal(rows.length, 4 * declared.pages)
    for (const row of rows) assert.equal(row.callsPerPageBlock, 2 * batch)
  }
})

test('every lane completes its Latin rotation and every blocked lane can balance a block', () => {
  for (const [name, sampling] of [['primary', PRIMARY], ['reduced', REDUCED]]) {
    for (const lane of LANE_NAMES) {
      const b = laneBudget(lane, sampling)
      assert.ok(b.rotationComplete, `${name}/${lane}: ${b.blocks} blocks is not a multiple of ${b.layouts} layouts`)
      assert.ok(Number.isInteger(b.rotationRounds), `${name}/${lane}: incomplete Latin rounds`)
      if (LANES[lane].topology === 'blocked') {
        assert.ok(b.withinBlockBalanced, `${name}/${lane}: batch ${b.batch} is odd, so a block can only be alternated`)
        assert.ok(b.batch % 2 === 0)
      }
    }
  }
})

test('the chosen blocked counts are members of the enumerated equal-budget set, and the set is small', () => {
  const checks = [
    { lane: 'blocked6', match: 'blocked6', layouts: LANES.blocked6.layouts.length, sampling: PRIMARY },
    { lane: 'treatmentBlocked', match: 'treatmentBlocked', layouts: LANES.treatmentBlocked.layouts.length, sampling: PRIMARY },
    { lane: 'blocked6', match: 'blocked6', layouts: LANES.blocked6.layouts.length, sampling: REDUCED },
    { lane: 'treatmentBlocked', match: 'treatmentBlocked', layouts: LANES.treatmentBlocked.layouts.length, sampling: REDUCED },
  ]
  for (const c of checks) {
    const chosen = samplingOnlyPointSd(1, 1)
    assert.equal(chosen, 1)
    const target = c.sampling.blocks[c.match] * c.sampling.batch[c.match]
    const admissible = enumerateBalanced(target, { layouts: c.layouts, topology: 'blocked' })
    const hit = admissible.filter((o) => o.blocks === c.sampling.blocks[c.match] && o.batch === c.sampling.batch[c.match])
    assert.equal(hit.length, 1,
      `${c.lane}: (${c.sampling.blocks[c.match]}, ${c.sampling.batch[c.match]}) is not an admissible equal-budget choice of ${JSON.stringify(admissible.map((o) => [o.blocks, o.batch]))}`)
  }
  // Some targets admit NOTHING under the 4-layout blocked constraints. That is precisely why the
  // reduced profile was re-derived instead of halved: a naive halving makes the treatment
  // comparison unbalanceable and the run would silently stop being an equal-cost experiment.
  assert.equal(enumerateBalanced(108, { layouts: 4, topology: 'blocked' }).length, 0)
})

test('equal timed calls do equalize the iid sampling channel, which is why the blocked rig is not a variance win', () => {
  // Under the iid model the per-runner point sd depends only on blocks * batch. Equal budget is
  // therefore exactly equal iid precision, which is the ledger's section 8 conclusion restated as
  // an assertion: the blocked prototype buys a removed systematic, not less noise.
  assert.ok(Math.abs(samplingOnlyPointSd(24, 9) - samplingOnlyPointSd(18, 12)) < 1e-15)
  assert.ok(Math.abs(samplingOnlyPointSd(12, 9) - samplingOnlyPointSd(18, 6)) < 1e-15)
  assert.ok(Math.abs(samplingOnlyPointSd(16, 9) - samplingOnlyPointSd(12, 12)) < 1e-15)
  assert.ok(samplingOnlyPointSd(96, 9) < samplingOnlyPointSd(24, 9))
})

test('lane execution order is rotated by replicate so no lane owns early runner time', () => {
  const orders = [0, 1, 2, 3, 4, 5, 6].map((r) => laneExecutionOrder(POLICY.lanes, r))
  for (const o of orders) assert.deepEqual([...o].sort(), [...LANE_NAMES].sort())
  assert.equal(new Set(orders.map((o) => o[0])).size, LANE_NAMES.length)
  assert.equal(orders[LANE_NAMES.length].join('|'), orders[0].join('|'))
})

test('the budget report is internally consistent for both profiles', () => {
  for (const [name, sampling] of [['primary', PRIMARY], ['reduced', REDUCED]]) {
    const desc = describeSamplingProfile(name, sampling, POLICY.fixtures.length)
    const summed = LANE_NAMES.reduce((a, l) => a + laneBudget(l, sampling).timedCalls, 0)
    assert.equal(desc.timedCallsPerFixture, summed)
    assert.equal(desc.timedCallsTotal, summed * POLICY.fixtures.length)
    assert.equal(totalTimedCalls(sampling, POLICY.fixtures.length).total, summed * POLICY.fixtures.length)
    assert.ok(desc.untimedCallsPerFixture > 0)
    for (const lane of LANE_NAMES) assert.equal(desc.lanes[lane].pages, lanePages(lane))
  }
  // The reduced profile is an escape hatch, not a different experiment: it must be strictly cheaper
  // and must still satisfy every equality, which the pair report already proved.
  const p = totalTimedCalls(PRIMARY, POLICY.fixtures.length).total
  const r = totalTimedCalls(REDUCED, POLICY.fixtures.length).total
  assert.ok(r < p, 'the reduced profile must be strictly cheaper than the primary one')
  assert.equal(r % 1, 0)
})

// ---------------------------------------------------------------------------
// 2. FIDELITY: the challenge's current lane IS the shipped schedule
// ---------------------------------------------------------------------------

test("the challenge's current lane replays bench-r9-controlled.mjs's schedule call for call", () => {
  // The challenge cannot reuse bench-r9-controlled.mjs itself, because that harness discards
  // per-call rows and this challenge is required to retain them. That makes fidelity a claim that
  // has to be PROVED rather than asserted, so the challenge's model is replayed against the
  // existing, independently written model of that harness over a shared random stream: with noise
  // switched ON, an agreement to floating-point exactness means the two control flows are identical.
  const world = { baseMs: 40, posLog: { first: 0, second: -0.04 }, noiseLog: 0.05, seed: 1234 }
  const n = 12
  const batch = 9
  const warmup = 6
  // Two INDEPENDENT call functions: a shared random stream would let the second run continue where
  // the first left off, and the comparison would be meaningless.
  const shippedCall = makeChallengeCall(world)
  const adapter = (page, slotStr, position, t) => shippedCall({
    page,
    record: page * 2 + (slotStr === 'slot2' ? 1 : 0),
    slot: slotStr === 'slot2' ? 1 : 0,
    arm: 'base',
    position,
    wall: t,
    inject: false,
  })
  const shipped = runCurrentLayout(adapter, { n, batch, warmup })
  const challenge = runCrossoverLane(makeChallengeCall(world), 'current6', { blocks: n, batch, warmup })
  for (const layout of LANES.current6.layouts) {
    assert.equal(challenge.rows[layout].length, shipped.rows[layout].length)
    for (let i = 0; i < shipped.rows[layout].length; i++) {
      assert.ok(Math.abs(challenge.rows[layout][i].slot1 - shipped.rows[layout][i].slot1) < 1e-9,
        `${layout} block ${i} slot1 ${challenge.rows[layout][i].slot1} vs ${shipped.rows[layout][i].slot1}`)
      assert.ok(Math.abs(challenge.rows[layout][i].slot2 - shipped.rows[layout][i].slot2) < 1e-9,
        `${layout} block ${i} slot2 ${challenge.rows[layout][i].slot2} vs ${shipped.rows[layout][i].slot2}`)
    }
  }
})

test('the reversed lane reverses the ONE canonical list, and that same list feeds creation, warm and rotation', () => {
  const forward = laneLayoutOrder('current6')
  const reversed = laneLayoutOrder('current6Reversed')
  assert.deepEqual(reversed, forward.slice().reverse())
  assert.equal(new Set(reversed).size, forward.length)
  // The model derives creation order, warm order and the rotation base from that one list.
  const { data } = runLane({ baseMs: 10 }, 'current6Reversed', PRIMARY, {})
  assert.deepEqual(data.orders.pageOrder, reversed)
  assert.deepEqual(data.orders.warmOrder, reversed)
  assert.deepEqual(data.orders.rotationBase, reversed)
})

test('reversing only the rotation is not a reversal, and the test can tell the difference', () => {
  const full = runLane(hostileNonstationaryWorld(SILENT), 'current6Reversed', PRIMARY, { reversalScope: 'all' }).data.orders
  const creationOnly = runLane(hostileNonstationaryWorld(SILENT), 'current6Reversed', PRIMARY, { reversalScope: 'creationOnly' }).data.orders
  const rotationOnly = runLane(hostileNonstationaryWorld(SILENT), 'current6Reversed', PRIMARY, { reversalScope: 'rotationOnly' }).data.orders
  const forward = laneLayoutOrder('current6')
  assert.deepEqual(full.pageOrder, full.rotationBase)
  assert.deepEqual(creationOnly.pageOrder.slice().reverse(), creationOnly.rotationBase)
  assert.deepEqual(rotationOnly.pageOrder, forward)
  assert.deepEqual(rotationOnly.rotationBase.slice().reverse(), forward)
  assert.throws(() => runLane({}, 'current6Reversed', PRIMARY, { reversalScope: 'nonsense' }), /unknown reversalScope/)
  assert.throws(() => runBlockedLane(() => 1, 'blocked6', { blocks: 4, batch: 9 }), /even batch/)
})

// ---------------------------------------------------------------------------
// 3. TOPOLOGY: what each lane does to a hostile nonstationary world
// ---------------------------------------------------------------------------

test('in a stationary world the shipped rig cancels every per-page term exactly (model sanity)', () => {
  const world = {
    baseMs: 40,
    pageLog: [0.01, -0.02, 0.03, 0.0, -0.01, 0.02],
    additiveMs: [3, 0, 7, 1, 5, 2],
    interactLog: [-0.02, -0.01, 0.03, 0.0, 0.01, -0.03],
    posLog: { first: 0, second: -0.04 },
    ...SILENT,
    seed: 17,
  }
  const c = cells('current6', world).cells
  for (const name of ['candidate', 'baseNull', 'optNull']) {
    assert.ok(Math.abs(c[name].logPoint) < EPS, `${name} leaked ${c[name].logPoint}`)
  }
})

test('in the ledger section 4 hostile world the current rig leaks and the blocked rig is exactly zero', () => {
  const world = hostileNonstationaryWorld(SILENT)
  const cur = cells('current6', world).cells
  assert.ok(Math.abs(cur.candidate.logPoint) > 1e-4, 'the current rig must be biased on this world')
  assert.ok(Math.abs(cur.baseNull.logPoint) > 1e-4)
  const blocked = cells('blocked6', world).cells
  for (const name of ['effect', 'baseNull', 'optNull']) {
    assert.ok(Math.abs(blocked[name].logPoint) < 1e-12, `blocked ${name} residual ${blocked[name].logPoint}`)
  }
  assert.ok(Math.abs(blocked.effect.logPoint) < Math.abs(cur.candidate.logPoint))
})

test('a full canonical reversal flips the baseNull sign, and the magnitudes follow page creation index', () => {
  // Reversing the canonical list maps creation index i -> layouts-1-i. The baseNull pair therefore
  // swaps its two physical pages, which flips 1/2 (v_forward - v_reverse) exactly; and the candidate
  // pair and the optNull pair trade creation indices, so their magnitudes should exchange. If the
  // hosted run reproduces the offsets WITHOUT that exchange, the asymmetry is not creation-order
  // coupled and this challenge's premise is wrong. That is falsifier 3 in the policy.
  const world = hostileNonstationaryWorld(SILENT)
  const cur = cells('current6', world).cells
  const rev = cells('current6Reversed', world).cells
  assert.ok(Math.sign(cur.baseNull.logPoint) !== Math.sign(rev.baseNull.logPoint),
    `baseNull did not flip: ${pctOf(cur.baseNull.logPoint)} -> ${pctOf(rev.baseNull.logPoint)}`)
  const ratioA = Math.abs(rev.optNull.logPoint) / Math.abs(cur.candidate.logPoint)
  const ratioB = Math.abs(rev.candidate.logPoint) / (Math.abs(cur.optNull.logPoint) || 1)
  assert.ok(Math.abs(ratioA - 1) < 0.05, `reversed optNull should carry the current candidate magnitude, ratio ${ratioA.toFixed(4)}`)
  assert.ok(Math.abs(ratioB - 1) < 0.05, `reversed candidate should carry the current optNull magnitude, ratio ${ratioB.toFixed(4)}`)
  // Reversing only the rotation leaves creation indices alone, so it must NOT flip baseNull.
  const rotationOnly = cells('current6Reversed', world, { reversalScope: 'rotationOnly' }).cells
  assert.ok(Math.sign(rotationOnly.baseNull.logPoint) === Math.sign(cur.baseNull.logPoint),
    'reversing the rotation alone must not flip the baseNull cell')
})

test('the identity canary is exactly zero where a module-record channel makes the current rig non-zero', () => {
  const world = recordChannelWorld({ ...SILENT })
  const cur = cells('current6', world).cells
  const canary = cells('identityCanary', world).cells
  assert.ok(Math.abs(cur.candidate.logPoint) > 1e-3,
    `the record channel should reach the current rig, got ${pctOf(cur.candidate.logPoint)}%`)
  assert.ok(Math.abs(canary.canary.logPoint) < 1e-12,
    `the canary must be exactly zero by construction, got ${canary.canary.logPoint}`)
  // Physical identity means one URL and one options object on both slots.
  for (const layout of LANES.identityCanary.layouts) {
    assert.deepEqual(armsForLane('identityCanary', layout), ['base', 'base'])
  }
  assert.equal(LANES.identityCanary.treatmentSensitive, false)
})

test('the identity canary is provably blind to treatment, so it can never serve as a treatment lane', () => {
  const world = {
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    injectMs: 3,
    armLog: (arm) => (arm === 'opt' ? 0.08 : 0),
    ...SILENT,
  }
  const canary = cells('identityCanary', world).cells.canary
  assert.ok(Math.abs(canary.logPoint) < 1e-12,
    `a same-record canary cannot see an 8% arm effect or a 3ms injection, got ${canary.logPoint}`)
  // The same world must move a treatment-sensitive lane, or the canary's zero would be vacuous.
  // `Math.log(0.97)` is NOT the arm effect: a multiplicative arm cost inside a multiplicative
  // first/second position term recovers to exp(armLog + pos) averaged over positions, which is
  // exactly exp(armLog). Asserting log(1 + pct/100) here would assert an arithmetic error.
  const armLog = 0.08
  const positionBalanced = (arm) => Math.log(
    (Math.exp(armLog) * Math.exp(0) + Math.exp(armLog) * Math.exp(-0.04)) /
    (Math.exp(0) + Math.exp(-0.04)),
  )
  const current = cells('current6', world).cells.candidate
  const blocked = cells('blocked6', world).cells.effect
  assert.ok(Math.abs(current.logPoint - armLog) < 1e-9, `current rig: ${current.logPoint} != ${armLog}`)
  assert.ok(Math.abs(current.logPoint - positionBalanced('opt')) < 1e-9)
  assert.ok(Math.abs(blocked.logPoint - armLog) < 1e-9, `blocked rig: ${blocked.logPoint} != ${armLog}`)
})

// ---------------------------------------------------------------------------
// 4. SENSITIVITY: the positive control must survive both topologies
// ---------------------------------------------------------------------------

test('the injected positive control is recovered by BOTH topologies, with no attenuation', () => {
  // An additive synthetic cost keyed to the ARM, not to a position. The blocked schedule balances
  // positions inside each replicate-pair, so if the injection were position-bound it would cancel
  // and the challenge would read a false negative. It is arm-bound, and this asserts it.
  const injectMs = 1.6
  const world = { baseMs: 40, posLog: { first: 0, second: -0.05 }, injectMs, ...SILENT }
  const cur = cells('treatmentCurrent', world)
  const blocked = cells('treatmentBlocked', world)
  for (const dose of DOSES) {
    const a = cur.doses[dose]
    const b = blocked.doses[dose]
    assert.ok(a.recovery.logPoint > 0, `${dose}: preregistered sign is positive, got ${a.recovery.pct}`)
    assert.ok(b.recovery.logPoint > 0, `${dose}: blocked recovery sign must be positive, got ${b.recovery.pct}`)
    assert.ok(Math.abs(a.recovery.logPoint - b.recovery.logPoint) < 1e-4,
      `${dose}: blocked attenuated the recovery by ${(a.recovery.pct - b.recovery.pct).toFixed(4)}pp`)
    // The recovery is not the naive multiplicative value: an ADDITIVE cost inside a multiplicative
    // position term recovers to the position-weighted mean. Asserting the naive value would be
    // asserting an arithmetic error.
    const expected = Math.log(
      ((40 + injectMs) + (40 * Math.exp(-0.05) + injectMs)) /
      ((40) + (40 * Math.exp(-0.05))),
    )
    assert.ok(Math.abs(a.recovery.logPoint - expected) < 1e-4,
      `${dose}: recovery ${a.recovery.pct.toFixed(4)}% is not the additive truth ${(pctOf(expected)).toFixed(4)}%`)
    assert.ok(Math.abs(Math.log(1.04) - expected) > 5e-4, 'the additive truth must differ from the naive multiplicative value')
    // Its own same-topology null must be zero, so the recovery is not absorbing a null bias.
    assert.ok(Math.abs(a.treatmentNull.logPoint) < 1e-9)
    assert.ok(Math.abs(b.treatmentNull.logPoint) < 1e-9)
  }
  // Both doses inject, and neither is the control arm.
  for (const lane of ['treatmentCurrent', 'treatmentBlocked']) {
    for (const layout of LANES[lane].layouts) {
      const injected = injectedArmsFor(layout)
      if (isTreatmentLayout(layout)) assert.ok(injected.some(Boolean), `${lane}/${layout} injects nothing`)
      else assert.deepEqual(injected, [false, false], `${lane}/${layout} is a null but injects`)
    }
  }
})

test('a real multiplicative arm treatment is recovered identically by both topologies', () => {
  // As above: the recovered value is exp(armLog) - 1 in percentage, i.e. a log point of armLog.
  // Math.log(1 + 0.97) - 1 would be the wrong expectation.
  const armLog = -0.03
  const world = {
    baseMs: 40,
    posLog: { first: 0, second: -0.04 },
    armLog: (arm) => (arm === 'opt' ? armLog : 0),
    ...SILENT,
  }
  const cur = cells('current6', world).cells.candidate.logPoint
  const blocked = cells('blocked6', world).cells.effect.logPoint
  assert.ok(Math.abs(cur - armLog) < 1e-9, `current rig: ${cur} != ${armLog}`)
  assert.ok(Math.abs(blocked - armLog) < 1e-9, `blocked rig: ${blocked} != ${armLog}`)
  assert.ok(Math.abs(cur - blocked) < 1e-9)
  assert.ok(Math.abs(pctOf(cur) - (-2.955447)) < 1e-5, `in percent that is ${pctOf(cur)}%`)
})

test('recovery is the treatment minus its OWN same-topology null, never a foreign null', () => {
  const world = { baseMs: 40, posLog: { first: 0, second: -0.05 }, injectMs: 1.6, ...SILENT }
  const blockedOnly = cells('treatmentBlocked', world).doses.low
  assert.ok(Math.abs(blockedOnly.recovery.logPoint - (blockedOnly.treatment.logPoint - blockedOnly.treatmentNull.logPoint)) < 1e-15)
  const currentOnly = cells('treatmentCurrent', world).doses.low
  assert.ok(Math.abs(currentOnly.recovery.logPoint - (currentOnly.treatment.logPoint - currentOnly.treatmentNull.logPoint)) < 1e-15)
})

test('the crossover orientation puts the injected arm on the correct side of the estimator', () => {
  // On the current rig the treated arm is slot2 on the Forward layout and slot1 on the Reverse one.
  // If that were ever changed, the estimator would report the NEGATIVE of the treatment and every
  // recovery number would silently flip sign.
  assert.deepEqual(armsFor('treatmentLowForward'), ['base', 'opt'])
  assert.deepEqual(armsFor('treatmentLowReverse'), ['opt', 'base'])
  assert.deepEqual(injectedArmsFor('treatmentLowForward'), [false, true])
  assert.deepEqual(injectedArmsFor('treatmentLowReverse'), [true, false])
  const world = { baseMs: 40, posLog: { first: 0, second: -0.05 }, injectMs: 1.6, ...SILENT }
  assert.ok(cells('treatmentCurrent', world).doses.low.recovery.logPoint > 0)
})

test('measureLane and runLane agree, so the harness entry point and the model are one thing', () => {
  const world = hostileNonstationaryWorld(SILENT)
  const viaMeasure = measureLane(world, 'blocked6', PRIMARY, { seed: 1, bootstrap: 500 })
  const viaRun = cells('blocked6', world)
  assert.equal(viaMeasure.cells.baseNull.logPoint, viaRun.cells.baseNull.logPoint)
})

// ---------------------------------------------------------------------------
// 5. AGGREGATION: runner level, fail closed, no thresholds
// ---------------------------------------------------------------------------

test('the runner-level aggregate reproduces the published eight-runner self-null aggregate', () => {
  // Anchors the new contract to the numbers the ledger already published, so the closeout cannot
  // quietly change what the corrected run said.
  const reported = [8.88, 5.21, 3.75, 3.09, 1.38, 0.85, -0.51, -1.34]
  const agg = runnerAggregate(reported.map((p) => Math.log(1 + p / 100)))
  assert.ok(Math.abs(agg.pct - 2.62) < 0.12, `reproduced ${agg.pct.toFixed(2)}%`)
  assert.ok(Math.abs(agg.runnerSdPp - 3.3) < 0.15, `runner SD(log) ${agg.runnerSdPp.toFixed(2)}pp`)
  assert.equal(agg.n, 8)
  const h = t975(7) * agg.seLog
  assert.ok(Math.abs(agg.ci95[1] - pctOf(agg.logPoint + h)) < 1e-9)
  assert.throws(() => runnerAggregate([Math.log(1.01)]), /at least two/)
  assert.throws(() => runnerAggregate([NaN, 1]), /non-finite/)
  assert.throws(() => t975(0), /degrees of freedom/)
})

test('a control cell reports absolute mean and the worst absolute CI endpoint', () => {
  const points = [0.0257, 0.0210, 0.0330, 0.0110, 0.0280, 0.0190, 0.0300, 0.0240]
  const cell = controlCell(points, { label: 'baseNull' })
  assert.equal(cell.n, 8)
  assert.ok(Math.abs(cell.meanPct - 2.57) < 0.35, `mean ${cell.meanPct.toFixed(2)}%`)
  assert.ok(Math.abs(cell.absMeanPct - Math.abs(cell.meanPct)) < 1e-12)
  assert.equal(cell.maxAbsCiEndpointPct, Math.max(Math.abs(cell.ci95[0]), Math.abs(cell.ci95[1])))
  // A control whose CI excludes zero is a resolved control asymmetry, which is exactly the
  // corrected run's load-bearing result and the reason the promotion policy is unfrozen.
  assert.equal(cell.excludesZero, cell.ci95[0] > 0 || cell.ci95[1] < 0)
  const nullCell = controlCell([-0.002, 0.003, 0.001, -0.004, 0.002, 0.0, 0.001, -0.001])
  assert.equal(nullCell.excludesZero, false)
})

test('recovery is paired WITHIN a runner, which narrows the interval without changing the mean', () => {
  // Treatment and its null share a runner-wide component (the [0.30, -0.20, 0.10, 0.00] common
  // effect). Differencing inside the runner removes it; differencing after aggregating across
  // runners leaves it in, which is why the paired interval is an order of magnitude narrower.
  const common = [0.30, -0.20, 0.10, 0.00]
  const treatment = [0.32, -0.18, 0.12, 0.02]
  const control = [0.31, -0.22, 0.09, 0.01]
  const paired = pairedRecovery(treatment, control)
  assert.ok(common.every((c, i) => Math.abs(treatment[i] - control[i] - 0.01 - (i === 1 ? 0.03 : i === 2 ? 0.02 : 0)) < 1e-12))
  // The paired mean is the difference of means: 0.07 - 0.0475 = 0.0225.
  assert.ok(Math.abs(paired.logPoint - 0.0225) < 1e-15, `paired mean ${paired.logPoint}`)
  assert.ok(Math.abs(runnerAggregate(treatment).logPoint - runnerAggregate(control).logPoint - 0.0225) < 1e-15)
  // The counterfactual: two INDEPENDENT means, so var(treatment)/n + var(control)/n.
  const indepSd = Math.sqrt(variance(treatment) / treatment.length + variance(control) / control.length)
  const indepHalf = t975(treatment.length - 1) * indepSd / Math.sqrt(treatment.length)
  const indepWidth = pctFromLog(mean(treatment) + indepHalf) - pctFromLog(mean(treatment) - indepHalf)
  const pairedWidth = paired.ci95[1] - paired.ci95[0]
  assert.ok(pairedWidth < indepWidth,
    `paired width ${pairedWidth.toFixed(4)}pp vs unpaired ${indepWidth.toFixed(4)}pp`)
  assert.equal(paired.perRunnerPct.length, 4)
  assert.throws(() => pairedRecovery([0.1], [0.1, 0.2]), /one treatment and one control/)
})

test('recoveryContrast flags attenuation only when the intervals actually separate', () => {
  const overlapping = recoveryContrast(
    { pct: 4.10, ci95: [3.4, 4.8] },
    { pct: 3.90, ci95: [3.1, 4.7] },
  )
  assert.equal(overlapping.ciOverlap, true)
  assert.equal(overlapping.blockedStrictlyLower, false)
  const attenuated = recoveryContrast(
    { pct: 4.10, ci95: [3.9, 4.3] },
    { pct: 2.10, ci95: [1.9, 2.3] },
  )
  assert.equal(attenuated.ciOverlap, false)
  assert.equal(attenuated.blockedStrictlyLower, true)
  assert.ok(Math.abs(attenuated.differencePp + 2) < 1e-9)
})

test('the primary comparison reports signed differences and never decides', () => {
  const lane = (bias, sd, cost) => ({
    absControlMeanPct: bias, maxAbsControlCiEndpointPct: bias + 1, runnerSdPp: sd,
    cost: { timedCalls: cost },
  })
  const compare = primaryComparison({
    current: lane(2.57, 3.21, 2592),
    blocked: lane(0.80, 2.90, 2592),
    currentTreatments: { low: { pct: 4.1, ci95: [3.9, 4.3] } },
    blockedTreatments: { low: { pct: 4.0, ci95: [3.7, 4.3] } },
    doses: ['low'],
  })
  assert.equal(compare.rows.length, 4)
  assert.equal(compare.rows[0].metric, 'absControlMeanPct')
  assert.equal(compare.rows[0].blockedLower, true)
  assert.equal(compare.timedCallsEqual, true)
  assert.equal(compare.attenuation, false)
  assert.equal(compare.verdict, 'evidence-only')
  const attenuated = primaryComparison({
    current: lane(2.57, 3.21, 2592),
    blocked: lane(0.80, 2.90, 3456),
    currentTreatments: { low: { pct: 4.1, ci95: [3.9, 4.3] } },
    blockedTreatments: { low: { pct: 1.2, ci95: [1.0, 1.4] } },
    doses: ['low'],
  })
  assert.equal(attenuated.attenuation, true)
  assert.equal(attenuated.timedCallsEqual, false)
})

test('completenessAudit fails closed on missing, unusable, duplicate and mis-identified cells', () => {
  const ok = [0, 1, 2, 3].map((r) => ({ browser: 'chromium', replicate: r, state: 'CHALLENGE_SAMPLE', usable: true, policySha256: 'P', profile: 'primary' }))
  const identity = { identityOf: (d) => ({ policySha256: d.policySha256, profile: d.profile }), requiredIdentity: { policySha256: 'P', profile: 'primary' } }
  const expected = ['chromium:0', 'chromium:1', 'chromium:2', 'chromium:3']
  assert.equal(completenessAudit(expected, ok, identity).ok, true)
  assert.deepEqual(completenessAudit(expected, ok.slice(0, 3), identity).missing, ['chromium:3'])
  assert.equal(completenessAudit(expected, ok.slice(0, 3), identity).ok, false)
  const blocked = ok.map((d, i) => (i === 2 ? { ...d, state: 'INCOMPLETE_EVIDENCE', usable: false, reason: 'AMBIENT_BLOCKED' } : d))
  assert.deepEqual(completenessAudit(expected, blocked, identity).unusable, ['chromium:2'])
  const drifted = ok.map((d, i) => (i === 1 ? { ...d, policySha256: 'OTHER' } : d))
  assert.deepEqual(completenessAudit(expected, drifted, identity).wrongIdentity, ['chromium:1'])
  assert.deepEqual(completenessAudit(expected, [...ok, ok[0]], identity).duplicates, ['chromium:0'])
})

test('a decision document may not carry observation rows', () => {
  const doc = {
    fixtures: {
      'cards400-safe': {
        lanes: {
          current6: {
            cells: { baseNull: { logPoint: 0.02, pct: 2.0, ci95: [1, 3] } },
            positionPremiumLog: 0.01,
            runnerPointsPct: [1, 2, 3, 4, 5, 6, 7, 8],
          },
        },
      },
    },
  }
  assert.equal(assertRunnerLevelOnly(doc), true)
  assert.throws(() => assertRunnerLevelOnly({
    fixtures: { 'cards400-safe': { lanes: { current6: { pageRows: new Array(500).fill([1, 2, 3]) } } } },
  }), /raw rows/)
  assert.throws(() => assertRunnerLevelOnly({
    fixtures: { 'cards400-safe': { lanes: { current6: { calls: [[0, 1, 2, 3, 0, 0, 12, 11, 0]] } } } },
  }), /raw rows/)
  assert.throws(() => assertRunnerLevelOnly({
    fixtures: { 'cards400-safe': { lanes: { current6: { logRatios: { blocks: [0.1, 0.2] } } } } },
  }), /raw rows/)
  // A long series under an innocuous name is still a series.
  assert.throws(() => assertRunnerLevelOnly({
    fixtures: { 'cards400-safe': { lanes: { current6: { anything: new Array(200).fill(1) } } } },
  }), /observation series/)
})

test('lane budget inputs are validated rather than trusted', () => {
  assert.throws(() => laneBudget('nope', PRIMARY), /unknown lane/)
  assert.throws(() => laneBudget('blocked6', { ...PRIMARY, blocks: { ...PRIMARY.blocks, blocked6: 0 } }), /invalid sampling/)
  assert.throws(() => laneBudget('blocked6', { ...PRIMARY, batch: { ...PRIMARY.batch, blocked6: 9.5 } }), /invalid sampling/)
  assert.throws(() => laneSampling({ ...PRIMARY, warmup: -1 }), /invalid sampling.warmup/)
  assert.throws(() => laneExecutionOrder(POLICY.lanes, -1), /invalid replicate/)
  assert.throws(() => armsFor('not-a-layout'), /unknown layout/)
  assert.throws(() => laneLayoutOrder('not-a-lane'), /unknown lane/)
})

test('lane summaries expose the same page counts and layout counts the harness will open', () => {
  const lanes = laneSampling(PRIMARY)
  assert.equal(lanes.current6.pages, 6)
  assert.equal(lanes.blocked6.pages, 6)
  assert.equal(lanes.identityCanary.pages, 6)
  assert.equal(lanes.current6Reversed.pages, 6)
  assert.equal(lanes.treatmentCurrent.pages, 8)
  assert.equal(lanes.treatmentBlocked.pages, 8)
  // Lanes run SEQUENTIALLY, so the live-page ceiling is the widest single lane, not their sum.
  // Holding all 40 pages in one browser would be its own confound.
  const widest = Math.max(...LANE_NAMES.map((l) => lanes[l].pages))
  assert.equal(widest, 8)
  assert.ok(LANE_NAMES.reduce((a, l) => a + lanes[l].pages, 0) > 3 * widest)
})

// ---------------------------------------------------------------------------
// 6. WORKFLOW AND POLICY CONTRACTS
// ---------------------------------------------------------------------------

test('the hosted workflow passes its own structural audit', () => {
  const audit = auditWorkflow(WORKFLOW)
  assert.deepEqual(audit.problems, [])
})

test('the workflow audit actually catches the regressions it claims to catch', () => {
  // An audit that cannot fail is decoration. Each mutation below is a specific rule.
  const cases = [
    ['cell evidence keyed on the retry counter',
      WORKFLOW.replace('r9-tc-sample-chromium-r${{ matrix.replicate }}-${{ github.run_id }}',
        'r9-tc-sample-chromium-r${{ matrix.replicate }}-${{ github.run_attempt }}'),
      /run_attempt/],
    ['a cell retry that cannot overwrite its own evidence',
      WORKFLOW.replaceAll('overwrite: true', 'overwrite: false'), /overwrite: true/],
    ['a self-hosted runner', WORKFLOW.replace('runs-on: ubuntu-24.04', 'runs-on: [self-hosted, linux]'), /non-pinned runner label/],
    ['an unpinned action', WORKFLOW.replace('actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/checkout@v4'), /40-hex/],
    ['a repository write', WORKFLOW.replace('npm run compile', 'git push origin HEAD'), /repository write command/],
    ['fail-fast across fresh runners', WORKFLOW.replace('fail-fast: false', 'fail-fast: true'), /fail-fast/],
    ['a cancelled cell treated as collected evidence', WORKFLOW.replace('cancel-in-progress: false', 'cancel-in-progress: true'), /cancel in progress/],
    ['the challenge algebra job removed',
      WORKFLOW.replace('node --test lane6-scratch/r9-calibration/challenge/algebra/topology-challenge.test.mjs', 'true'),
      /challenge-specific browser-free contract test/],
    ['the ambient settle phase removed',
      WORKFLOW.replace(/node lane6-scratch\/r9-calibration\/settle\.mjs/g, 'true')
        .replace(/lane6-scratch\/r9-calibration\/settle\.mjs/g, 'settle.mjs'),
      /settle phase is missing/],
    ['an extra engine outside the preregistration',
      WORKFLOW.replace('npx playwright install --with-deps chromium', 'npx playwright install --with-deps chromium firefox'),
      /chromium-only/],
    ['a closeout that downloads every run',
      WORKFLOW.replace('pattern: r9-tc-sample-*-${{ github.run_id }}', 'pattern: r9-tc-sample-*'),
      /run_id-keyed pattern/],
    ['a closeout that does not aggregate',
      WORKFLOW.replace('node lane6-scratch/r9-calibration/challenge/aggregate.mjs', 'true'), /must run the challenge aggregate/],
    ['a job too short to finish a runner cell', WORKFLOW.replace('timeout-minutes: 150', 'timeout-minutes: 10'), /timeout too small/],
    ['write permissions', WORKFLOW.replace('contents: read', 'contents: write'), /write permissions/],
  ]
  for (const [label, text, pattern] of cases) {
    const problems = auditWorkflow(text).problems.join(' | ')
    assert.match(problems, pattern, `${label} was not caught`)
  }
})

test('the ambient gate must wrap the benchmark, not merely appear somewhere', () => {
  const runStep = WORKFLOW.slice(WORKFLOW.indexOf('- name: Settle, ambient-gate and run the challenge'))
  const commandLines = [...runStep.matchAll(/^[^\n]*node[^\n]*\.(?:mjs)[^\n]*$/gm)].map((m) => m[0])
  assert.ok(commandLines.length >= 3, `expected settle, gate+runner and validate commands, got ${JSON.stringify(commandLines)}`)
  const settleLine = commandLines.findIndex((l) => /^\s*node\s+\S*r9-calibration\/settle\.mjs/.test(l))
  const gateLine = commandLines.findIndex((l) => /run-with-timing-gate\.mjs/.test(l))
  assert.ok(settleLine >= 0, 'the settle phase must actually execute')
  assert.ok(gateLine >= 0, 'the ambient gate must actually execute')
  assert.ok(gateLine > settleLine, 'settle must precede the gate')
  // The gate WRAPS the benchmark: one command line, gate then `--` then the runner. A gate that only
  // ran afterwards would sample an idle machine and pass every time.
  assert.ok(/run-with-timing-gate\.mjs\s+--\s+node\s+\S*challenge\/run\.mjs/.test(commandLines[gateLine]),
    `the gate and the benchmark must share one command line, got ${JSON.stringify(commandLines[gateLine])}`)
  assert.ok(commandLines.some((l) => /^\s*node\s+\S*challenge\/validate\.mjs/.test(l)),
    'the validator must run after the gate exit code is known')
})

test('the policy passes its own audit and keeps the positive control uncalibrated', () => {
  assert.deepEqual(auditPolicy(POLICY).problems, [])
  assert.equal(POLICY.positiveControl.predictedMagnitudePct, null)
  assert.equal(POLICY.positiveControl.expectedSign, 'positive')
  assert.equal(POLICY.positiveControl.doses[1].iterations, POLICY.positiveControl.doses[0].iterations * 4)
  assert.equal(POLICY.replicates.chromium, 8)
  assert.ok(POLICY.replicates.chromium >= POLICY.minimumFreshRunners)
  // No threshold anywhere in the challenge's own policy: the promotion policy stays unfrozen.
  const text = JSON.stringify(POLICY)
  assert.ok(!/"(pass|fail)Threshold"|"epsilon"|"controlBand"|"equivalenceBand"|"maxPairLogSd"/.test(text),
    'the challenge policy must not carry promotion thresholds')
})

test('the challenge settles on exactly the calibration settle configuration', () => {
  assert.deepEqual(POLICY.settle, CAL_POLICY.settle)
})

test('the challenge marks itself non-promotable and cannot emit a performance claim', () => {
  const harness = fs.readFileSync(path.join(CHAL, 'bench-r9-topology.mjs'), 'utf8')
  assert.match(harness, /promotable: false/)
  assert.match(harness, /performanceClaim: false/)
  assert.match(harness, /assertHostedBrowser\(\)/)
  const validator = fs.readFileSync(path.join(CHAL, 'validate.mjs'), 'utf8')
  assert.match(validator, /assertRunnerLevelOnly/)
  const aggregate = fs.readFileSync(path.join(CHAL, 'aggregate.mjs'), 'utf8')
  assert.match(aggregate, /INCOMPLETE_EVIDENCE/)
  assert.match(aggregate, /process\.exit\(1\)/)
})

test('no production source is touched by the challenge', () => {
  // The positive control must be harness-side. If a future edit reached into src/ the preregistered
  // treatment would no longer be a property of the instrument.
  const harness = fs.readFileSync(path.join(CHAL, 'bench-r9-topology.mjs'), 'utf8')
  assert.ok(!/from '.*\bsrc\//.test(harness) && !/require\(.*\bsrc\//.test(harness))
  assert.ok(!/\bfs\.(writeFileSync|appendFileSync)\(.*\bsrc\//.test(harness))
  assert.match(harness, /injectWork\(\)/)
  // Product entry points must not import the challenge either.
  assert.ok(!/r9-calibration\/challenge/.test(fs.readFileSync(path.resolve(ROOT, 'package.json'), 'utf8')))
})
