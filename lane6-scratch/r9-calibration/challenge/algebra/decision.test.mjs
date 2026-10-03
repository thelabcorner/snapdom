import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyTopology, nullSeverity } from './decision.mjs'

const ROOT = process.cwd()
const policy = JSON.parse(fs.readFileSync(
  path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge/POLICY.json'), 'utf8'))

function cell({ mean = 0, endpoint = 2, sd = 2, excludesZero = false } = {}) {
  return {
    meanPct: mean,
    absMeanPct: Math.abs(mean),
    ci95: excludesZero ? [0.2, endpoint] : [-endpoint, endpoint],
    maxAbsCiEndpointPct: endpoint,
    excludesZero,
    runnerSdPp: sd,
  }
}

function nullLane(name, { endpoint, sd, wall, effectEndpoint = endpoint } = {}) {
  return {
    lane: name,
    controls: {
      baseNull: cell({ endpoint, sd }),
      optNull: cell({ endpoint: Math.max(0.1, endpoint - 0.2), sd: Math.max(0.1, sd - 0.1) }),
    },
    effectCell: cell({ endpoint: effectEndpoint, sd }),
    cost: { timedCalls: 2592, wallClockMsMedian: wall },
  }
}

function recovery({ pct = 5, lo = 4, hi = 6 } = {}) {
  return { pct, ci95: [lo, hi] }
}

function fixture({
  oldEndpoint = 4.0,
  newEndpoint = 2.8,
  oldSd = 3.0,
  newSd = 2.3,
  oldWall = 1000,
  newWall = 1040,
  canaryEndpoint = 1.2,
  canaryExcludesZero = false,
  currentRecovery = 5,
  blockedRecovery = 5,
  currentRecoveryLo = 4,
  blockedRecoveryLo = 4,
  blockedStrictlyLower = false,
  equalBudgetVerified = true,
} = {}) {
  const doses = {}
  const blockedDoses = {}
  const comparisons = {}
  for (const dose of ['low', 'high']) {
    const c = recovery({ pct: currentRecovery, lo: currentRecoveryLo, hi: currentRecovery + 1 })
    const b = recovery({ pct: blockedRecovery, lo: blockedRecoveryLo, hi: blockedRecovery + 1 })
    doses[dose] = { recovery: c }
    blockedDoses[dose] = { recovery: b }
    comparisons[dose] = {
      currentPct: c.pct,
      blockedPct: b.pct,
      ratio: b.pct / c.pct,
      blockedStrictlyLower,
    }
  }
  return {
    lanes: {
      current6: nullLane('current6', { endpoint: oldEndpoint, sd: oldSd, wall: oldWall }),
      blocked6: nullLane('blocked6', { endpoint: newEndpoint, sd: newSd, wall: newWall }),
      identityCanary: {
        lane: 'identityCanary',
        controls: {
          canary: cell({
            endpoint: canaryEndpoint,
            sd: 0.5,
            excludesZero: canaryExcludesZero,
          }),
        },
        cost: { timedCalls: 2592, wallClockMsMedian: 1000 },
      },
      treatmentCurrent: { doses },
      treatmentBlocked: { doses: blockedDoses },
    },
    comparison: { recoveries: comparisons },
    equalBudgetVerified,
  }
}

function fixtures(overrides = {}) {
  return Object.fromEntries(policy.fixtures.map((name) => [name, fixture(overrides)]))
}

test('nullSeverity includes candidate/effect cell as well as AA/BB controls', () => {
  const lane = nullLane('x', { endpoint: 2, effectEndpoint: 4.2, sd: 3 })
  const got = nullSeverity(lane)
  assert.equal(got.maxAbsCiEndpointPct, 4.2)
  assert.equal(got.maxRunnerSdPp, 3)
})

test('ACCEPT_NEW requires hard gates plus a material precision improvement', () => {
  const got = classifyTopology({ fixtures: fixtures(), policy })
  assert.equal(got.verdict, 'ACCEPT_NEW')
  assert.equal(got.promotable, false)
  assert.equal(got.hardFailures.length, 0)
  assert.equal(got.inconclusive.length, 0)
  assert.equal(got.global.materialImprovement, true)
})

test('NO_GO retains the simpler incumbent when challenger is merely equal', () => {
  const got = classifyTopology({
    fixtures: fixtures({ oldEndpoint: 3, newEndpoint: 3, oldSd: 2, newSd: 2 }),
    policy,
  })
  assert.equal(got.verdict, 'NO_GO')
  assert.equal(got.global.materialImprovement, false)
})

test('NO_GO on endpoint/dispersion/cost regression even if another axis looks better', () => {
  const got = classifyTopology({
    fixtures: fixtures({
      oldEndpoint: 4,
      newEndpoint: 3,
      oldSd: 2,
      newSd: 2.3,
      oldWall: 1000,
      newWall: 1120,
    }),
    policy,
  })
  assert.equal(got.verdict, 'NO_GO')
  assert.ok(got.hardFailures.some((x) => x.includes('runner SD ratio')))
  assert.ok(got.hardFailures.some((x) => x.includes('wall-clock ratio')))
})

test('NO_GO when blocked topology attenuates a treatment the incumbent resolves', () => {
  const got = classifyTopology({
    fixtures: fixtures({
      currentRecovery: 5,
      blockedRecovery: 3.5,
      currentRecoveryLo: 4,
      blockedRecoveryLo: 3,
      blockedStrictlyLower: true,
    }),
    policy,
  })
  assert.equal(got.verdict, 'NO_GO')
  assert.ok(got.hardFailures.some((x) => x.includes('recovery ratio') || x.includes('strictly below')))
})

test('INCONCLUSIVE when identity floor is invalid', () => {
  const got = classifyTopology({
    fixtures: fixtures({ canaryEndpoint: 3, canaryExcludesZero: true }),
    policy,
  })
  assert.equal(got.verdict, 'INCONCLUSIVE')
  assert.ok(got.inconclusive.some((x) => x.includes('identity canary')))
})

test('INCONCLUSIVE when the positive control is not resolved by incumbent', () => {
  const got = classifyTopology({
    fixtures: fixtures({ currentRecoveryLo: -1, blockedRecoveryLo: -1 }),
    policy,
  })
  assert.equal(got.verdict, 'INCONCLUSIVE')
  assert.ok(got.inconclusive.some((x) => x.includes('treatment doses resolved')))
})

test('equal timed-call proof is mandatory', () => {
  const got = classifyTopology({
    fixtures: fixtures({ equalBudgetVerified: false }),
    policy,
  })
  assert.equal(got.verdict, 'INCONCLUSIVE')
  assert.ok(got.inconclusive.some((x) => x.includes('equal timed-call budget')))
})
