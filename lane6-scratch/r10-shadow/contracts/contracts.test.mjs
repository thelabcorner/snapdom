// Browser-free contracts for F4 v2. No browser, no network, no runner: everything here is either
// pure arithmetic, a synthetic decision document, or the workflow's own text.
//
//   node --test lane6-scratch/r10-shadow/contracts/contracts.test.mjs
//
// Each group pins one thing the coordinator audit found inadmissible in v1, so a regression in the
// fix is as loud as the original defect was quiet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { runnerCi, heterogeneity, mean, sd, t975, pct, withinEnvelope, envelopeBreachesPct } from '../lib/stats.mjs'
import { auditCells, expectedCells, cellKey, USABLE_STATE } from '../lib/matrix.mjs'
import { decideStage, decideEngines, decideCloseout, STATES } from '../lib/decide.mjs'
import { preparedArtifact, cellArtifact, stageArtifact, mergeCells, duplicateRunIds } from '../lib/artifacts.mjs'
import { createSettlePlan, evaluateSettle, shouldStop } from '../lib/settle.mjs'
import { readWorkflow, jobs, stepNames, findStep, stepIndex, allText, declaredArtifactNames, artifactUses } from '../lib/workflow.mjs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'lane6-scratch/r10-shadow/F4_POLICY.json'), 'utf8'))
const FLOOR = policy.thresholds.practicalFloorPct
const ENVELOPE = policy.instrument.outerNullEnvelopePct

// ---------------------------------------------------------------------------------------------
// Aggregation: runner-level only, Student-t, no pooling across VMs
// ---------------------------------------------------------------------------------------------

test('runnerCi uses one point per runner and Student-t over n-1 degrees of freedom', () => {
  const points = [0.01, 0.02, 0.03, 0.04]
  const got = runnerCi(points)
  const m = mean(points)
  const s = sd(points)
  const h = t975(points.length - 1) * (s / Math.sqrt(points.length))
  assert.equal(got.n, 4)
  assert.ok(Math.abs(got.logPoint - m) < 1e-12)
  assert.ok(Math.abs(got.seLog - s / 2) < 1e-12)
  assert.ok(Math.abs(got.ci95[0] - pct(m - h)) < 1e-12)
  assert.ok(Math.abs(got.ci95[1] - pct(m + h)) < 1e-12)
})

test('runnerCi matches the R9 t-table values the calibration used', () => {
  assert.equal(t975(1), 12.706)
  assert.equal(t975(7), 2.365)
  assert.equal(t975(30), 2.042)
  // R9 clamps at df 30 rather than falling through to the normal approximation; matching that is
  // the whole point, so the same clamp is asserted rather than the more accurate 1.96.
  assert.equal(t975(999), 2.042)
})

test('runnerCi refuses fewer than two runners and refuses non-finite points', () => {
  assert.throws(() => runnerCi([0.01]), /at least two runner log points/)
  assert.throws(() => runnerCi([0.01, NaN]), /non-finite/)
})

test('the interval shrinks with the SQUARE ROOT of runner count, never with block count', () => {
  // Eight runners versus twenty-four. If any code path pooled per-call or per-block observations,
  // the 24-point interval would come out sqrt(3) tighter and a 1% claim would appear out of a 5%
  // instrument. The guard is that the interval tracks runner count only.
  // Half the points at +a and half at -a have sample sd a*sqrt(n/(n-1)), so a is scaled to hold the
  // sd fixed and isolate n as the only variable.
  const spread = (n) => Array.from({ length: n }, (_, i) => {
   const a = 0.01 * Math.sqrt((n - 1) / n)
   return i % 2 ? a : -a
 })
  const eight = runnerCi(spread(8))
  const twentyFour = runnerCi(spread(24))
  assert.ok(Math.abs(eight.runnerSdLog - twentyFour.runnerSdLog) < 1e-12, 'spread must be held fixed')
  const ratio = eight.seLog / twentyFour.seLog
  assert.ok(Math.abs(ratio - Math.sqrt(3)) < 1e-9)
  assert.equal(eight.n, policy.replicates.chromium)
})

test('heterogeneity reports between-runner variance left after within-run variance', () => {
  const points = [0.01, 0.02, 0.03, 0.04]
  const withinVars = [1e-6, 1e-6, 1e-6, 1e-6]
  const h = heterogeneity(points, withinVars)
  const runnerVar = sd(points) ** 2
  assert.ok(Math.abs(h.tau2 - Math.max(0, runnerVar - mean(withinVars))) < 1e-12)
  assert.equal(h.df, points.length - 1)
  assert.ok(h.I2 >= 0 && h.I2 <= 1)
  // Identical points carry no between-runner variance.
  assert.equal(heterogeneity([0.02, 0.02, 0.02, 0.02], withinVars).I2, 0)
})

test('heterogeneity rejects a within-variance list that does not match the runner list', () => {
  assert.throws(() => heterogeneity([0.1, 0.2], [1e-6]), /one within-run variance per runner/)
})

// ---------------------------------------------------------------------------------------------
// The outer envelope: nulls only, and never a substitute for a 1% answer
// ---------------------------------------------------------------------------------------------

test('the outer envelope is adopted from the completed calibration and cited as such', () => {
  assert.equal(ENVELOPE, 5.0)
  assert.match(policy.instrument.outerNullEnvelopeSource, /37097245291/)
  assert.match(policy.instrument.outerNullEnvelopeMeaning, /cannot establish, refute or bound a 1% effect/)
})

test('the envelope judges a null by its CI endpoints, not only its point estimate', () => {
  const centred = { pct: 0.1, ci95: [0.1, 0.2] }
  const inside = { pct: 0.1, ci95: [-4.9, 4.9] }
  const wide = { pct: 0.1, ci95: [-6, 6] }
  const endpointOut = { pct: 0.5, ci95: [0.2, 5.4] }
  assert.ok(withinEnvelope(centred, ENVELOPE))
  assert.ok(withinEnvelope(inside, ENVELOPE))
  assert.ok(!withinEnvelope(wide, ENVELOPE), 'a wide null interval must breach even when centred')
  assert.ok(!withinEnvelope(endpointOut, ENVELOPE), 'a point estimate inside the band is not enough')
  assert.ok(envelopeBreachesPct(wide, ENVELOPE) > 0)
})

test('the 20% bands from v1 are gone from the policy', () => {
  const text = JSON.stringify(policy)
  assert.ok(!/"controlBand"/.test(text))
  assert.ok(!/"equivalenceBand"/.test(text))
  assert.ok(!/"epsilon"/.test(text))
})

test('the practical floor is documented as a floor, not a significance threshold', () => {
  assert.equal(FLOOR, 1.0)
  assert.match(policy.thresholdMeaning.practicalFloorPct, /PREREGISTERED PRACTICAL FLOOR/)
  assert.match(policy.thresholdMeaning.practicalFloorPct, /NOT a significance threshold/)
})

// ---------------------------------------------------------------------------------------------
// Exact-matrix completeness
// ---------------------------------------------------------------------------------------------

const IDENTITY = { policySha256: 'P', candidateGitSha: 'C', bundleSha256: 'B' }
const doc = (engine, replicate, state = USABLE_STATE, overrides = {}) => ({
  browser: engine,
  replicate,
  state,
  policySha256: IDENTITY.policySha256,
  candidateGitSha: IDENTITY.candidateGitSha,
  bundleSha256: IDENTITY.bundleSha256,
  ...overrides,
})

test('the preregistered matrix is exactly the configured replicates', () => {
  assert.deepEqual(expectedCells(policy, ['chromium']), Array.from({ length: 8 }, (_, i) => 'chromium:' + i))
  assert.deepEqual(expectedCells(policy, ['firefox', 'webkit']), [
    'firefox:0', 'firefox:1', 'firefox:2', 'firefox:3',
    'webkit:0', 'webkit:1', 'webkit:2', 'webkit:3',
  ])
})

test('a complete matrix passes the audit', () => {
  const expected = expectedCells(policy, ['chromium'])
  const docs = expected.map((k) => doc(k.split(':')[0], Number(k.split(':')[1])))
  const audit = auditCells({ docs, expected, identity: IDENTITY })
  assert.equal(audit.complete, true)
  assert.equal(audit.byKey.size, 8)
})

test('a missing cell makes the matrix incomplete', () => {
  const expected = expectedCells(policy, ['chromium'])
  const docs = expected.slice(0, 7).map((k) => doc(k.split(':')[0], Number(k.split(':')[1])))
  const audit = auditCells({ docs, expected, identity: IDENTITY })
  assert.equal(audit.complete, false)
  assert.deepEqual(audit.missing, ['chromium:7'])
})

test('a duplicate cell makes the matrix incomplete rather than resolved by iteration order', () => {
  const expected = expectedCells(policy, ['chromium'])
  const docs = expected.map((k) => doc(k.split(':')[0], Number(k.split(':')[1])))
  docs.push(doc('chromium', 3))
  const audit = auditCells({ docs, expected, identity: IDENTITY })
  assert.equal(audit.complete, false)
  assert.deepEqual(audit.duplicate, ['chromium:3'])
})

test('an inadmissible cell (INCOMPLETE or PROVENANCE) makes the matrix incomplete', () => {
  const expected = expectedCells(policy, ['chromium'])
  const docs = expected.map((k, i) => doc(k.split(':')[0], Number(k.split(':')[1]), i === 2 ? STATES.INCOMPLETE : USABLE_STATE))
  const audit = auditCells({ docs, expected, identity: IDENTITY })
  assert.equal(audit.complete, false)
  assert.deepEqual(audit.unusable, ['chromium:2'])
})

test('identity drift is provenance, not incompleteness', () => {
  const expected = expectedCells(policy, ['chromium'])
  const docs = expected.map((k, i) => doc(k.split(':')[0], Number(k.split(':')[1]), USABLE_STATE,
    i === 1 ? { bundleSha256: 'STALE' } : {}))
  const audit = auditCells({ docs, expected, identity: IDENTITY })
  assert.equal(audit.complete, false)
  assert.deepEqual(audit.wrongIdentity, ['chromium:1'])
})

test('a stray cell from another engine fails the chromium stage closed', () => {
  const expected = expectedCells(policy, ['chromium'])
  const docs = expected.map((k) => doc(k.split(':')[0], Number(k.split(':')[1])))
  docs.push(doc('webkit', 0))
  const audit = auditCells({ docs, expected, identity: IDENTITY })
  assert.equal(audit.complete, false)
  assert.deepEqual(audit.stray, ['webkit:0'])
})

test('cellKey is engine:replicate', () => {
  assert.equal(cellKey({ browser: 'webkit', replicate: 3 }), 'webkit:3')
})

// ---------------------------------------------------------------------------------------------
// Retry semantics: prior-good plus retried, fail-closed
// ---------------------------------------------------------------------------------------------

test('artifact names are keyed on run_id and never on run_attempt', () => {
  const runId = '12345'
  assert.equal(preparedArtifact(runId), 'r10-f4-prepared-12345')
  assert.equal(cellArtifact({ engine: 'chromium', replicate: 7, runId }), 'r10-f4-sample-chromium-r7-12345')
  assert.equal(stageArtifact({ stage: 'engines', runId }), 'r10-f4-stage-engines-12345')
  for (const name of [preparedArtifact(runId), cellArtifact({ engine: 'webkit', replicate: 0, runId }), stageArtifact({ stage: 'chromium', runId })]) {
    assert.ok(name.includes(runId))
    assert.ok(!/attempt/i.test(name))
  }
})

test('a retry keeps the same artifact name, so the retried cell overwrites in place', () => {
  const before = cellArtifact({ engine: 'firefox', replicate: 2, runId: '999' })
  const after = cellArtifact({ engine: 'firefox', replicate: 2, runId: '999' })
  assert.equal(before, after)
})

test('mergeCells combines prior-good with retried cells and reports which is which', () => {
  const runId = '999'
  const expected = expectedCells(policy, ['chromium'])
  const docs = [
    ...expected.slice(0, 5).map((k) => doc(k.split(':')[0], Number(k.split(':')[1]), USABLE_STATE, { runId, attemptIndex: 0 })),
    // Cells 5 and 6 failed first and were retried; the retry carries a higher attempt index.
    doc('chromium', 5, USABLE_STATE, { runId, attemptIndex: 1 }),
    doc('chromium', 6, USABLE_STATE, { runId, attemptIndex: 1 }),
    doc('chromium', 7, STATES.INCOMPLETE, { runId, attemptIndex: 1 }),
  ]
  const merged = mergeCells(expected, docs, runId)
  assert.deepEqual(merged.rejected, [])
  // Every cell is present; the retried one supersedes in place. Admissibility is auditCells' job,
  // not mergeCells', so the inadmissible cell survives merging and is caught there.
  assert.deepEqual(merged.missing, [])
  assert.deepEqual(merged.duplicated, [])
  assert.deepEqual(merged.cells.get('chromium:5').attemptIndex, 1)
  assert.equal(merged.cells.size, 8)
  const audit = auditCells({
    docs: [...merged.cells.values()],
    expected,
    identity: { policySha256: 'P', candidateGitSha: 'C', bundleSha256: 'B' },
  })
  assert.equal(audit.complete, false)
  assert.deepEqual(audit.unusable, ['chromium:7'])
})

test('mergeCells drops documents from another run instead of letting them in', () => {
  const runId = '999'
  const expected = expectedCells(policy, ['chromium'])
  const docs = [
    ...expected.map((k) => doc(k.split(':')[0], Number(k.split(':')[1]), USABLE_STATE, { runId })),
    doc('chromium', 0, USABLE_STATE, { runId: 'other' }),
  ]
  const merged = mergeCells(expected, docs, runId)
  assert.equal(merged.missing.length, 0)
  assert.deepEqual(merged.rejected, ['other|chromium:0'])
})

test('the highest attempt wins when both copies of a cell are present', () => {
  const runId = '999'
  const expected = ['chromium:0']
  const docs = [
    doc('chromium', 0, STATES.INCOMPLETE, { runId, attemptIndex: 0 }),
    doc('chromium', 0, USABLE_STATE, { runId, attemptIndex: 1 }),
  ]
  const merged = mergeCells(expected, docs, runId)
  assert.equal(merged.cells.get('chromium:0').state, USABLE_STATE)
})

test('duplicateRunIds catches a naming scheme that leaks attempt into a filename', () => {
  assert.deepEqual(duplicateRunIds([
    { runId: '1', browser: 'chromium', replicate: 0 },
    { runId: '1', browser: 'chromium', replicate: 0 },
  ]), ['1|chromium:0'])
  assert.deepEqual(duplicateRunIds([
    { runId: '1', browser: 'chromium', replicate: 0 },
    { runId: '2', browser: 'chromium', replicate: 0 },
  ]), [])
})

test('two copies of one cell at the SAME attempt are a conflict, not a retry', () => {
  const runId = '999'
  const merged = mergeCells(['chromium:0'], [
    doc('chromium', 0, USABLE_STATE, { runId, attemptIndex: 1 }),
    doc('chromium', 0, STATES.INCOMPLETE, { runId, attemptIndex: 1 }),
  ], runId)
  assert.deepEqual(merged.duplicated, ['chromium:0'])
  assert.equal(merged.cells.size, 1)
})

// ---------------------------------------------------------------------------------------------
// Decision boundaries around 1%
// ---------------------------------------------------------------------------------------------

// `map` values are [improvementLower, improvementUpper] in percent, POSITIVE meaning the ceiling arm
// was faster. The harness reports (slot2/slot1 - 1) * 100, so a win is a NEGATIVE percentage and these
// are converted back into that convention here. Writing the fixtures in improvement terms is what
// stops a win from reading as a regression — the mistake that made the first boundary draft reject
// every promising ceiling.
const agg = (map) => {
  const out = {}
  for (const [name, [lower, upper]] of Object.entries(map)) {
    out[name] = {
      effect: { ci95: [-upper, -lower], pct: -(lower + upper) / 2 },
      baseNull: { ci95: [-0.1, 0.1], pct: 0 },
      optNull: { ci95: [-0.1, 0.1], pct: 0 },
      nulls: { envelopePass: true, worstSlotBiasPct: 0.2 },
      noopEffectEnvelopePass: policy.noopFixtures.includes(name) ? true : null,
    }
  }
  return out
}
const SHADOW = policy.fixtures.filter((n) => !policy.noopFixtures.includes(n))
const SPLIT_FREE = SHADOW.filter((n) => !policy.promotionExcludedFixtures.includes(n))
const NOOP = policy.noopFixtures[0]

test('every splitting-free fixture under the floor rejects the partition', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  const verdict = decideStage(agg(map), policy)
  assert.equal(verdict.state, STATES.REJECT)
})

test('one splitting-free fixture clearing the floor is PROMISING', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[SPLIT_FREE[0]] = [1.2, 3.0]
  assert.equal(decideStage(agg(map), policy).state, STATES.PROMISING)
})

test('exactly at the floor on the lower bound is INCONCLUSIVE, not PROMISING', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[SPLIT_FREE[0]] = [FLOOR, 3.0]
  const verdict = decideStage(agg(map), policy)
  assert.equal(verdict.state, STATES.INCONCLUSIVE)
  assert.ok(verdict.reasons.some((r) => /replicates are not added automatically/.test(r)))
})

test('exactly at the floor on the upper bound is INCONCLUSIVE, not REJECT', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[SPLIT_FREE[0]] = [-1.0, FLOOR]
  assert.equal(decideStage(agg(map), policy).state, STATES.INCONCLUSIVE)
})

test('a hair over the floor on the lower bound is PROMISING', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[SPLIT_FREE[0]] = [FLOOR + 0.0001, 3.0]
  assert.equal(decideStage(agg(map), policy).state, STATES.PROMISING)
})

test('a hair under the floor on the upper bound rejects', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, FLOOR - 0.0001]
  assert.equal(decideStage(agg(map), policy).state, STATES.REJECT)
})

test('an interval straddling the floor is INCONCLUSIVE and never auto-retried', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[SPLIT_FREE[0]] = [-0.5, 2.0]
  const verdict = decideStage(agg(map), policy)
  assert.equal(verdict.state, STATES.INCONCLUSIVE)
  assert.match(verdict.reasons.join(' '), /cannot separate them/)
})

test('a material regression rejects even when another fixture clears the floor', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[SPLIT_FREE[0]] = [2.0, 4.0]
  map[SPLIT_FREE[1]] = [-3.0, -1.5]
  const verdict = decideStage(agg(map), policy)
  assert.equal(verdict.state, STATES.REJECT)
  assert.ok(verdict.reasons.some((r) => /material regression/.test(r)))
})

test('a promotion-excluded fixture cannot promote, but can reject', () => {
  const excluded = policy.promotionExcludedFixtures[0]
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[excluded] = [5.0, 8.0]
  assert.notEqual(decideStage(agg(map), policy).state, STATES.PROMISING)
  map[excluded] = [-4.0, -2.0]
  assert.equal(decideStage(agg(map), policy).state, STATES.REJECT)
})

test('invalid controls are INCOMPLETE whatever the effect looks like', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [5.0, 8.0]
  const fixtures = agg(map)
  fixtures[SPLIT_FREE[0]].nulls.envelopePass = false
  assert.equal(decideStage(fixtures, policy).state, STATES.INCOMPLETE)
  const noopBroken = agg(map)
  noopBroken[NOOP].noopEffectEnvelopePass = false
  assert.equal(decideStage(noopBroken, policy).state, STATES.INCOMPLETE)
})

// ---------------------------------------------------------------------------------------------
// Staging and closeout
// ---------------------------------------------------------------------------------------------

test('the engine guard is skipped unless chromium returned PROMISING', () => {
  const perEngine = {}
  for (const name of policy.fixtures) perEngine[name] = [1.2, 3.0]
  const engines = { firefox: agg(perEngine), webkit: agg(perEngine) }
  const promoting = decideStage(agg(perEngine), policy)
  assert.equal(promoting.state, STATES.PROMISING)
  assert.equal(decideEngines(engines, policy).state, STATES.PROMISING)
  assert.equal(decideCloseout({ chromium: promoting, engines, policy }).state, STATES.PROMISING_TO_DESIGN)
})

test('a chromium REJECT skips the guard and closes as REJECT', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.1, 0.5]
  const rejecting = decideStage(agg(map), policy)
  assert.equal(rejecting.state, STATES.REJECT)
  const closeout = decideCloseout({ chromium: rejecting, engines: null, policy })
  assert.equal(closeout.state, STATES.REJECT)
  assert.ok(closeout.reasons.some((r) => /skipped/.test(r)))
})

test('a chromium INCONCLUSIVE skips the guard and never reports PROMISING_TO_DESIGN', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [0.2, 0.9]
  map[SPLIT_FREE[0]] = [-0.5, 2.0]
  const inconclusive = decideStage(agg(map), policy)
  assert.equal(inconclusive.state, STATES.INCONCLUSIVE)
  assert.equal(decideCloseout({ chromium: inconclusive, engines: null, policy }).state, STATES.INCONCLUSIVE)
})

test('engines are judged independently and never averaged together', () => {
  const good = {}
  for (const name of policy.fixtures) good[name] = [1.2, 3.0]
  const bad = {}
  for (const name of policy.fixtures) bad[name] = [-3.0, -1.0]
  const verdict = decideEngines({ firefox: agg(good), webkit: agg(bad) }, policy)
  assert.equal(verdict.state, STATES.REJECT)
  assert.equal(verdict.perEngine.firefox.state, STATES.PROMISING)
  assert.equal(verdict.perEngine.webkit.state, STATES.REJECT)
})

test('one inconclusive engine degrades the guard rather than being averaged away', () => {
  const good = {}
  const straddling = {}
  for (const name of policy.fixtures) { good[name] = [1.2, 3.0]; straddling[name] = [-0.5, 2.0] }
  const verdict = decideEngines({ firefox: agg(good), webkit: agg(straddling) }, policy)
  assert.equal(verdict.state, STATES.INCONCLUSIVE)
})

test('a missing engine guard after a PROMISING chromium is INCOMPLETE, never green', () => {
  const map = {}
  for (const name of policy.fixtures) map[name] = [1.2, 3.0]
  const promoting = decideStage(agg(map), policy)
  assert.equal(decideCloseout({ chromium: promoting, engines: null, policy }).state, STATES.INCOMPLETE)
})

test('an incomplete chromium stage propagates and can never become a win', () => {
  for (const state of [STATES.INCOMPLETE, STATES.PROVENANCE]) {
    const closeout = decideCloseout({ chromium: { state, reasons: [] }, engines: null, policy })
    assert.equal(closeout.state, state)
  }
})

test('no chromium result at all is INCOMPLETE', () => {
  assert.equal(decideCloseout({ chromium: null, engines: null, policy }).state, STATES.INCOMPLETE)
})

test('all five closeout states are declared in the policy', () => {
  for (const state of ['REJECT_PARTITION', 'PROMISING', 'INCONCLUSIVE', 'INCOMPLETE_EVIDENCE', 'PROVENANCE_FAILURE']) {
    assert.ok(policy.decision[state], 'missing decision state ' + state)
  }
  assert.ok(/never promote/i.test(policy.purpose))
})

// ---------------------------------------------------------------------------------------------
// Settle, before the ambient gate
// ---------------------------------------------------------------------------------------------

test('the settle plan matches its preregistered shape', () => {
  const plan = createSettlePlan(policy)
  assert.deepEqual(plan, { window: 3, intervalMs: 1000, cap: 20, maxWaitMs: 30000, maxSamples: 30 })
})

test('settle waits for three consecutive samples under the cap', () => {
  const plan = createSettlePlan(policy)
  assert.equal(evaluateSettle([1, 2], plan).settled, false)
  assert.equal(evaluateSettle([1, 2, 3], plan).settled, true)
  // Only the most recent window counts: an old spike does not veto a machine that has since gone
  // quiet, which is the whole reason the check is a sliding window rather than a running maximum.
  assert.equal(evaluateSettle([25, 1, 1, 1], plan).settled, true)
  assert.equal(evaluateSettle([1, 1, 1, 25], plan).settled, false)
  assert.equal(evaluateSettle([25, 1, 1, 1], plan).settled, true)
  assert.equal(evaluateSettle([1, 1, 20], plan).settled, true)
  assert.equal(evaluateSettle([1, 1, 20.5], plan).settled, false)
})

test('settle returns as soon as the window is clean and stops at the ceiling', () => {
  const plan = createSettlePlan(policy)
  assert.equal(shouldStop({ elapsedMs: 3000, samples: [1, 1, 1], plan }).reason, 'SETTLED')
  const capped = shouldStop({ elapsedMs: 30000, samples: [5, 5, 5], plan })
  assert.equal(capped.reason, 'MAX_WAIT_REACHED')
  assert.equal(capped.settled, false)
  assert.equal(shouldStop({ elapsedMs: 1000, samples: [1, 1, 1], plan }).reason, 'SETTLED')
  assert.equal(shouldStop({ elapsedMs: 1000, samples: [40], plan }).stop, false)
})

test('a settle plan shorter than one window is refused rather than silently widened', () => {
  assert.throws(() => createSettlePlan({ settle: { samples: 3, intervalMs: 1000, maxUtilizationPct: 20, maxWaitMs: 2000 } }),
    /cannot be shorter than one window/)
})

// ---------------------------------------------------------------------------------------------
// The workflow itself is the protocol, so its shape is asserted
// ---------------------------------------------------------------------------------------------

const workflow = readWorkflow(ROOT)

test('the workflow parses and declares the staged jobs', () => {
  const j = jobs(workflow)
  for (const name of ['prepare', 'chromium', 'stage_chromium', 'engines', 'closeout']) {
    assert.ok(j[name], 'missing job ' + name)
  }
})

test('the cross-engine guard is gated on the chromium stage machine state', () => {
  const engines = jobs(workflow).engines
  assert.match(String(engines.if), /needs\.stage_chromium\.outputs\.state\s*==\s*'PROMISING'/)
  assert.match(String(engines.needs), /stage_chromium/)
})

test('the chromium stage exposes its machine state to the guard', () => {
  const stage = jobs(workflow).stage_chromium
  assert.equal(stage.outputs.state, '${{ steps.aggregate.outputs.state }}')
  assert.ok(stepNames(stage).some((n) => /Aggregate the chromium stage/.test(n)))
})

test('every timed cell settles before the ambient gate runs', () => {
  for (const name of ['chromium', 'engines']) {
    const names = stepNames(jobs(workflow)[name])
    const settleAt = stepIndex(jobs(workflow)[name], 'Adaptive post-install settle')
    const gateAt = names.findIndex((n) => /Run hosted F4 ceiling measurement/.test(n))
    assert.ok(settleAt >= 0, name + ' has no settle step')
    assert.ok(gateAt >= 0, name + ' has no measurement step')
    assert.ok(settleAt < gateAt, name + ' must settle before measuring')
    assert.ok(names.some((n) => /Install pinned/.test(n)))
    assert.ok(settleAt > names.findIndex((n) => /Install pinned/.test(n)), name + ' must settle after install')
  }
  assert.ok(/run-with-timing-gate/.test(allText(workflow)))
})

test('no artifact name is keyed on run_attempt', () => {
  const names = declaredArtifactNames(workflow)
  assert.ok(names.length >= 4)
  for (const name of names) {
    assert.ok(!/github\.run_attempt/i.test(name), 'attempt leaked into artifact name: ' + name)
    assert.ok(/github\.run_id/.test(name), 'artifact not keyed on run_id: ' + name)
  }
})

test('cell artifacts overwrite in place so a retry replaces rather than duplicates', () => {
  const uploads = artifactUses(workflow).filter((s) => String(s.uses).startsWith('actions/upload-artifact'))
  const cellUploads = uploads.filter((s) => String(s.with?.name || '').includes('r10-f4-sample-'))
  assert.ok(cellUploads.length >= 2)
  for (const step of cellUploads) assert.equal(step.with.overwrite, true)
  const prepared = uploads.find((s) => String(s.with?.name || '').includes('r10-f4-prepared-'))
  assert.equal(prepared.with.overwrite, true)
})

test('the closeout collects every cell from every attempt and tolerates an absent one', () => {
  const closeout = jobs(workflow).closeout
  assert.match(String(closeout.if), /always\(\)/)
  const collect = findStep(closeout, 'Collect every cell from every attempt')
  assert.ok(collect)
  assert.equal(collect['continue-on-error'], true)
  assert.match(collect.run, /gh run download/)
  assert.match(collect.run, /GITHUB_RUN_ID/)
})

test('the closeout runs the aggregation and propagates its non-zero exit', () => {
  const closeout = jobs(workflow).closeout
  const step = findStep(closeout, 'Combine prior-good and retried cells')
  assert.ok(step)
  assert.match(step.run, /--stage=closeout/)
  assert.match(step.run, /exit \$code/)
})

test('a cell that admits nothing still uploads, so the closeout can see the failure', () => {
  for (const name of ['chromium', 'engines']) {
    const upload = findStep(jobs(workflow)[name], 'Upload raw F4 evidence')
    assert.equal(upload.if, 'always()')
  }
})

test('the workflow triggers only on this lane and its measurement files', () => {
  const paths = workflow.on.push.paths
  assert.ok(paths.includes('.github/workflows/r10-f4-wall.yml'))
  assert.ok(paths.includes('lane6-scratch/r10-shadow/**'))
  assert.ok(paths.includes('__tests__/helpers/shadowCards.js'))
  assert.deepEqual(workflow.on.push.branches, ['perf/v3-r10-*'])
})

test('every lane script the workflow runs is syntactically loadable', async () => {
  const scripts = [
    'prepare.mjs', 'run.mjs', 'bench-f4.mjs', 'validate.mjs', 'aggregate.mjs', 'settle.mjs',
    'lib/stats.mjs', 'lib/matrix.mjs', 'lib/decide.mjs', 'lib/artifacts.mjs', 'lib/settle.mjs', 'lib/workflow.mjs',
  ]
  for (const rel of scripts) {
    const abs = path.join(ROOT, 'lane6-scratch/r10-shadow', rel)
    assert.ok(fs.existsSync(abs), 'missing ' + rel)
// `node --check` rather than an import: five of these scripts execute on load by design (the
    // hosted-only guards, the browser launch), and importing them would run a refusal path or
    // process.exit inside the test runner.
    const checked = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
    assert.equal(checked.status, 0, rel + ' does not parse:\n' + checked.stderr)
  }
})
test('the pure libraries import on their own, with no side effects', async () => {
  for (const rel of ['lib/stats.mjs', 'lib/matrix.mjs', 'lib/decide.mjs', 'lib/artifacts.mjs', 'lib/settle.mjs', 'lib/workflow.mjs']) {
    const abs = path.join(ROOT, 'lane6-scratch/r10-shadow', rel)
    const mod = await import(pathToFileURL(abs).href)
    assert.ok(Object.keys(mod).length > 0, rel + ' exports nothing')
  }
})