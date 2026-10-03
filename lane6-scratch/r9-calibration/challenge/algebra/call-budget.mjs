/**
 * Integer call-budget algebra and lane specification for the R9 hosted topology challenge.
 *
 * Pure data and pure arithmetic. No browser, no Playwright, no filesystem, no clock. Everything in
 * this file is a property of the acquisition schedule, so `node --test` can prove that the current
 * rig and the blocked rig are compared at exactly equal timed-call budget before a single hosted
 * runner is spent. That proof is the whole point of the challenge: the ledger (§8, §9) is explicit
 * that the blocked prototype was never run against a browser, and it is equally explicit that a
 * comparison at unequal timed-call budget proves nothing.
 *
 * THE BUDGET IDENTITY
 *
 * Both schedules spend exactly `2 * batch` timed calls per physical-page observation block:
 *
 *   - current rig (`lane6-scratch/r9/bench-r9-controlled.mjs`, `sample`):
 *         `batch` replicate-pairs of 2 calls                                  = 2 * batch
 *   - blocked rig (`lane6-scratch/r9-calibration/bench-r9-blocked.mjs`, `block`):
 *         `batch / 2` replicate-pairs of 4 calls                             = 2 * batch
 *
 * so for every lane, in both topologies,
 *
 *     timedCalls(lane) = pages(lane) * blocks(lane) * 2 * batch(lane)
 *
 * `test('per-page-block timed call count is exactly 2 * batch in BOTH schedules')` proves that
 * identity against the actually-executed control flow rather than trusting this comment.
 *
 * Warmup and oracle calls are untimed. They are computed and reported separately so an untimed
 * call can never be silently reclassified as budget.
 */

export const CURRENT_SIX_LAYOUTS = Object.freeze([
  'effectForward', 'effectReverse',
  'baseNullForward', 'baseNullReverse',
  'optNullForward', 'optNullReverse',
])

export const BLOCKED_THREE_LAYOUTS = Object.freeze(['effect', 'baseNull', 'optNull'])

/**
 * Two predeclared positive-control doses, 4x apart in work units. See POLICY.json
 * `positiveControl.doses`. A dose is a WORK COUNT, never a millisecond prediction.
 */
export const DOSES = Object.freeze(['low', 'high'])

const cap = (s) => s[0].toUpperCase() + s.slice(1)

/** Two crossover layouts (treatment + its own null) per dose = 8 layouts, 1 page each. */
export const TREATMENT_CURRENT_LAYOUTS = Object.freeze(
  DOSES.flatMap((d) => [
    `treatment${cap(d)}Forward`, `treatment${cap(d)}Reverse`,
    `treatmentNull${cap(d)}Forward`, `treatmentNull${cap(d)}Reverse`,
  ]))

/** One within-block layout (treatment) and one null layout per dose, 2 pages each = 8 pages. */
export const TREATMENT_BLOCKED_LAYOUTS = Object.freeze(
  DOSES.flatMap((d) => [`treatment${cap(d)}`, `treatmentNull${cap(d)}`]))

/**
 * The six preregistered lanes.
 *
 * `layouts` is the ONE canonical list. Page creation order, warm order and the Latin rotation base
 * are all derived from it, so `reversed: true` reverses all three together. There is deliberately
 * no second list and no per-knob ordering override in the harness: the ledger (§3, §9 item 4)
 * requires the reversal to be applied consistently across creation, warm and rotation, and the
 * only way to guarantee that is to have exactly one list to reverse.
 *
 * role:
 *   null-triplet  -> exports { candidate, baseNull, optNull } (blocked exports the same three cells)
 *   canary        -> identity canary, a same-module-record self-null. Provably ZERO treatment
 *                    sensitivity, therefore never used in any treatment comparison.
 *   recovery      -> positive treatment control plus its own same-topology null, per dose.
 */
export const LANES = Object.freeze({
  current6: {
    topology: 'current',
    role: 'null-triplet',
    layouts: CURRENT_SIX_LAYOUTS,
    pagesPerLayout: 1,
    reversed: false,
    identityCanary: false,
    treatmentSensitive: true,
  },
  blocked6: {
    topology: 'blocked',
    role: 'null-triplet',
    layouts: BLOCKED_THREE_LAYOUTS,
    pagesPerLayout: 2,
    reversed: false,
    identityCanary: false,
    treatmentSensitive: true,
  },
  identityCanary: {
    topology: 'current',
    role: 'canary',
    layouts: CURRENT_SIX_LAYOUTS,
    pagesPerLayout: 1,
    reversed: false,
    identityCanary: true,
    treatmentSensitive: false,
  },
  current6Reversed: {
    topology: 'current',
    role: 'null-triplet',
    layouts: CURRENT_SIX_LAYOUTS,
    pagesPerLayout: 1,
    reversed: true,
    identityCanary: false,
    treatmentSensitive: true,
  },
  treatmentCurrent: {
    topology: 'current',
    role: 'recovery',
    layouts: TREATMENT_CURRENT_LAYOUTS,
    pagesPerLayout: 1,
    reversed: false,
    identityCanary: false,
    treatmentSensitive: true,
  },
  treatmentBlocked: {
    topology: 'blocked',
    role: 'recovery',
    layouts: TREATMENT_BLOCKED_LAYOUTS,
    pagesPerLayout: 2,
    reversed: false,
    identityCanary: false,
    treatmentSensitive: true,
  },
})

export const LANE_NAMES = Object.freeze(Object.keys(LANES))

/**
 * The preregistered comparisons that MUST be made at exactly equal total timed calls.
 *
 * `current6-vs-blocked6` is the decisive one. `current6-vs-current6Reversed` and
 * `current6-vs-identityCanary` are single-variable changes off the same rig, so they must also be
 * budget-matched or the reversal/canary difference is confounded with a work difference.
 * `treatmentCurrent-vs-treatmentBlocked` is the attenuation test: if the blocked topology
 * "improves" the nulls by spending less work, it has bought nothing.
 */
export const EQUAL_BUDGET_PAIRS = Object.freeze([
  ['current6', 'blocked6'],
  ['current6', 'current6Reversed'],
  ['current6', 'identityCanary'],
  ['treatmentCurrent', 'treatmentBlocked'],
])

/** The one canonical order a lane is created, warmed and rotated in. */
export function laneLayoutOrder(lane) {
  const spec = LANES[lane]
  if (!spec) throw new Error(`unknown lane: ${lane}`)
  return spec.reversed ? spec.layouts.slice().reverse() : spec.layouts.slice()
}

export function lanePages(lane) {
  const spec = LANES[lane]
  if (!spec) throw new Error(`unknown lane: ${lane}`)
  return spec.layouts.length * spec.pagesPerLayout
}

/**
 * Which of the two arms each slot holds, per layout.
 *
 * The self-null layouts of the current rig are byte- and option-identical on both slots, exactly as
 * in `bench-r9-controlled.mjs` under `--mode=option-pair` with `moduleFor = { base:'candidate',
 * opt:'candidate' }` and `--base={} --opt={}`. That is what makes a non-zero result measurement
 * bias rather than a snapDOM effect.
 */
export function armsFor(layout) {
  if (layout === 'effectForward') return ['base', 'opt']
  if (layout === 'effectReverse') return ['opt', 'base']
  if (layout.startsWith('baseNull')) return ['base', 'base']
  if (layout.startsWith('optNull')) return ['opt', 'opt']
  if (layout === 'effect') return ['base', 'opt']
  if (layout.startsWith('treatmentNull')) return ['base', 'base']
  if (/^treatment(Low|High)(Forward|Reverse)?$/.test(layout)) {
    return layout.endsWith('Reverse') ? ['opt', 'base'] : ['base', 'opt']
  }
  throw new Error(`unknown layout: ${layout}`)
}

/** The identity canary collapses both slots onto the same module record AND the same options. */
export function armsForLane(lane, layout) {
  return LANES[lane].identityCanary ? ['base', 'base'] : armsFor(layout)
}

export function doseOf(layout) {
  const lower = layout.toLowerCase()
  for (const d of DOSES) if (lower.includes(d)) return d
  return null
}

export function isTreatmentLayout(layout) {
  return layout.toLowerCase().startsWith('treatment') && !layout.toLowerCase().startsWith('treatmentnull')
}

/**
 * Which slot carries the injected synthetic cost, per layout.
 *
 * The injection is keyed to the ARM (`opt`), not to a position, so it survives any schedule that
 * balances positions. On the blocked rig the opt arm is always slot2 by construction; on the
 * current rig it is slot2 on the `Forward` layout and slot1 on the `Reverse` layout, which is
 * what makes `crossoverEffect`'s sign flip land the recovery on the true effect instead of on its
 * negative.
 */
export function injectedArmsFor(layout) {
  if (!isTreatmentLayout(layout)) return [false, false]
  return armsFor(layout).map((arm) => arm === 'opt')
}

/** Every timed call a lane spends per fixture. The unit the challenge is balanced in. */
export function laneBudget(lane, sampling) {
  const spec = LANES[lane]
  if (!spec) throw new Error(`unknown lane: ${lane}`)
  const blocks = sampling.blocks[lane]
  const batch = sampling.batch[lane]
  if (!Number.isInteger(blocks) || !Number.isInteger(batch) || blocks < 1 || batch < 1) {
    throw new Error(`invalid sampling for ${lane}: blocks=${blocks} batch=${batch}`)
  }
  if (!Number.isInteger(sampling.warmup) || sampling.warmup < 0) {
    throw new Error(`invalid sampling.warmup: ${sampling.warmup}`)
  }
  const pages = lanePages(lane)
  const layouts = spec.layouts.length
  const callsPerPageBlock = 2 * batch
  return {
    lane,
    topology: spec.topology,
    role: spec.role,
    layouts,
    pagesPerLayout: spec.pagesPerLayout,
    pages,
    blocks,
    batch,
    callsPerPageBlock,
    timedCalls: pages * blocks * callsPerPageBlock,
    warmCalls: pages * sampling.warmup * 2,
    oracleCalls: pages * 2,
    rotationUnits: layouts,
    rotationRounds: blocks / layouts,
    rotationComplete: blocks % layouts === 0,
    // A blocked block can only be balanced, not alternated, when batch is even.
    withinBlockBalanced: spec.topology === 'current' ? true : batch % 2 === 0,
  }
}

/** iid sampling-only point-estimate sd, relative to a one-call-per-block reference. */
export function samplingOnlyPointSd(blocks, batch) {
  return 1 / Math.sqrt(blocks * batch)
}

export function laneSampling(sampling) {
  return Object.fromEntries(LANE_NAMES.map((l) => [l, laneBudget(l, sampling)]))
}

export function totalTimedCalls(sampling, fixtureCount = 1) {
  const perFixture = LANE_NAMES.reduce((a, l) => a + laneBudget(l, sampling).timedCalls, 0)
  return { perFixture, total: perFixture * fixtureCount }
}

export function budgetPairReport(sampling) {
  return EQUAL_BUDGET_PAIRS.map(([a, b]) => {
    const x = laneBudget(a, sampling)
    const y = laneBudget(b, sampling)
    return {
      pair: [a, b],
      timedCalls: [x.timedCalls, y.timedCalls],
      equal: x.timedCalls === y.timedCalls,
      delta: y.timedCalls - x.timedCalls,
      layouts: [x.layouts, y.layouts],
      pages: [x.pages, y.pages],
      blocks: [x.blocks, y.blocks],
      batch: [x.batch, y.batch],
      // Equal timed calls does equalize the iid sampling channel, which is the only channel a
      // work difference could have been quietly improving.
      samplingOnlyPointSdEqual: samplingOnlyPointSd(x.blocks, x.batch) === samplingOnlyPointSd(y.blocks, y.batch),
    }
  })
}

/**
 * Every (blocks, batch) that spends exactly `target` timed calls PER PAGE and satisfies the lane's
 * structural constraints. `target` is `blocks * batch` of the lane it is being matched against.
 *
 * Enumerating instead of asserting is deliberate: it shows the chosen counts are one of a small
 * admissible set, and it makes the rejected alternatives (and why) checkable rather than asserted
 * in prose.
 */
export function enumerateBalanced(target, { layouts, topology, maxBatch = 512 }) {
  const out = []
  for (let batch = 1; batch <= maxBatch; batch++) {
    if (topology === 'blocked' && batch % 2) continue
    if (target % batch) continue
    const blocks = target / batch
    if (blocks < 1) continue
    if (blocks % layouts !== 0) continue
    out.push({
      blocks,
      batch,
      replicatePairsPerBlock: batch / 2,
      latinRounds: blocks / layouts,
      pageBlocks: blocks,
    })
  }
  return out
}

/** Lane order actually executed by a runner, rotated by replicate so no lane owns early runner time. */
export function laneExecutionOrder(laneNames, replicate) {
  const n = laneNames.length
  if (!Number.isInteger(replicate) || replicate < 0) throw new Error(`invalid replicate ${replicate}`)
  const shift = replicate % n
  return laneNames.slice(shift).concat(laneNames.slice(0, shift))
}

export function describeSamplingProfile(name, sampling, fixtureCount) {
  const lanes = laneSampling(sampling)
  const totals = totalTimedCalls(sampling, fixtureCount)
  return {
    profile: name,
    lanes,
    pairs: budgetPairReport(sampling),
    timedCallsPerFixture: totals.perFixture,
    timedCallsTotal: totals.total,
    untimedCallsPerFixture: LANE_NAMES.reduce(
      (a, l) => a + lanes[l].warmCalls + lanes[l].oracleCalls, 0),
  }
}
