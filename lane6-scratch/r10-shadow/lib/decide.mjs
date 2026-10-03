// The F4 decision boundaries, as pure functions over the AGGREGATE. Nothing here looks at a
// single runner: the per-cell layer may not answer the 1% question, so every input to these
// functions is a runner-level Student-t interval over one log point per fresh VM.
//
// Boundary shape, stated once so the contracts can pin it:
//   - REJECT needs EVERY splitting-free shadow fixture's aggregate UPPER bound under the floor,
//     or any aggregate shadow fixture regressing beyond the tolerance.
//   - PROMISING needs AT LEAST ONE splitting-free shadow fixture's aggregate LOWER bound above the
//     floor.
//   - Anything between those two — a lower bound under the floor with an upper bound above it — is
//     INCONCLUSIVE, and it is not a licence to add replicates. It records that this instrument
//     cannot separate the ceiling from the floor.
//   Exactly-at-the-floor belongs to INCONCLUSIVE on both sides: `> floor` is required to promote
//   and `< floor` is required to reject, so a CI that touches 1.0% from either side settles
//   nothing.
//
// SIGN CONVENTION, and getting it wrong is how a win looks like a loss: the harness reports
// (slot2/slot1 - 1) * 100, so a NEGATIVE percentage means the ceiling arm was FASTER. Everything
// below is therefore phrased in IMPROVEMENT magnitudes — `improvement.lower` is how much faster the
// arm was at the optimistic end of its interval — and a "material regression" is a negative
// improvement beyond the tolerance.

export const STATES = {
  REJECT: 'REJECT_PARTITION',
  PROMISING: 'PROMISING',
  INCONCLUSIVE: 'INCONCLUSIVE',
  INCOMPLETE: 'INCOMPLETE_EVIDENCE',
  PROVENANCE: 'PROVENANCE_FAILURE',
  PROMISING_TO_DESIGN: 'PROMISING_TO_DESIGN',
}

/** Improvement in percent, positive meaning the ceiling arm beat released. */
export function improvementOf(fx) {
  return { lower: -fx.effect.ci95[1], upper: -fx.effect.ci95[0] }
}

function groups(policy) {
  const shadow = policy.fixtures.filter((name) => !policy.noopFixtures.includes(name))
  const splitFree = shadow.filter((name) => !policy.promotionExcludedFixtures.includes(name))
  return { shadow, splitFree, noop: policy.noopFixtures.slice() }
}

/** Whether every NULL quantity and every no-op-fixture effect stayed inside the outer envelope. */
export function controlsValid(fixtures, policy) {
  const band = policy.instrument.outerNullEnvelopePct
  for (const [name, fx] of Object.entries(fixtures)) {
    if (fx.nulls && !fx.nulls.envelopePass) return { valid: false, fixture: name, reason: 'null control outside the outer envelope' }
    if (policy.noopFixtures.includes(name) && fx.noopEffectEnvelopePass === false) {
      return { valid: false, fixture: name, reason: 'no-op fixture effect outside the outer envelope' }
    }
    if (typeof band !== 'number') return { valid: false, fixture: name, reason: 'policy has no outer envelope' }
  }
  return { valid: true, fixture: null, reason: null }
}

/**
 * @param {Record<string, object>} fixtures aggregate per fixture
 * @param {object} policy
 * @returns {{state: string, reasons: string[], detail: object}}
 */
export function decideStage(fixtures, policy) {
  const floor = policy.thresholds.practicalFloorPct
  const regression = policy.thresholds.materialRegressionPct
  const { shadow, splitFree, noop } = groups(policy)

  const controls = controlsValid(fixtures, policy)
  if (!controls.valid) {
    return {
      state: STATES.INCOMPLETE,
      reasons: [`instrument controls invalid: ${controls.fixture} — ${controls.reason}`],
      detail: { controlsValid: false },
    }
  }

  const improvements = Object.fromEntries(Object.entries(fixtures).map(([name, fx]) => [name, improvementOf(fx)]))
  const regressed = shadow.filter((name) => improvements[name].upper < -regression)
  const belowFloor = splitFree.filter((name) => improvements[name].upper < floor)
  const aboveFloor = splitFree.filter((name) => improvements[name].lower > floor)

  const detail = {
    controlsValid: true,
    floorPct: floor,
    regressionPct: regression,
    shadowFixtures: shadow,
    splittingFreeFixtures: splitFree,
    noopFixtures: noop,
    regressed,
    belowFloor,
    aboveFloor,
    improvements,
  }

  const reasons = []
  if (regressed.length) reasons.push('material regression: ' + regressed.join(', '))
  if (!regressed.length && belowFloor.length === splitFree.length) {
    reasons.push('every splitting-free shadow fixture has an aggregate upper bound below ' + floor + '%')
  }
  if (aboveFloor.length) reasons.push('aggregate lower bound above the floor: ' + aboveFloor.join(', '))

  let state
  if (regressed.length) state = STATES.REJECT
  else if (belowFloor.length === splitFree.length) state = STATES.REJECT
  else if (aboveFloor.length) state = STATES.PROMISING
  else state = STATES.INCONCLUSIVE

  if (state === STATES.INCONCLUSIVE) {
    reasons.push('the ceiling sits across the floor and this instrument cannot separate them; '
      + 'replicates are not added automatically')
  }
  return { state, reasons, detail }
}

/** Cross-engine guard. Each engine is judged on its own runner-level aggregate; engines are never
 *  averaged together and never pooled with chromium. */
export function decideEngines(perEngine, policy) {
  const perEngineStates = {}
  const reasons = []
  for (const [engine, fixtures] of Object.entries(perEngine)) {
    const verdict = decideStage(fixtures, policy)
    perEngineStates[engine] = { state: verdict.state, reasons: verdict.reasons }
    for (const reason of verdict.reasons) reasons.push(engine + ': ' + reason)
  }
  const engines = Object.keys(perEngine)
  let state
  if (!engines.length) state = STATES.INCOMPLETE
  else if (engines.some((e) => perEngineStates[e].state === STATES.INCOMPLETE)) state = STATES.INCOMPLETE
  else if (engines.some((e) => perEngineStates[e].state === STATES.REJECT)) state = STATES.REJECT
  else if (engines.some((e) => perEngineStates[e].state === STATES.INCONCLUSIVE)) state = STATES.INCONCLUSIVE
  else state = STATES.PROMISING
  return { state, perEngine: perEngineStates, reasons }
}

/** Machine closeout state. Zero evidence is never green, and a skipped stage is INCOMPLETE rather
 *  than a pass. */
export function decideCloseout({ chromium, engines, policy }) {
  if (!chromium) {
    return { state: STATES.INCOMPLETE, reasons: ['no chromium stage result'], engineStates: {} }
  }
  const reasons = [...(chromium.reasons || []).map((r) => 'chromium: ' + r)]
  if (chromium.state === STATES.INCOMPLETE || chromium.state === STATES.PROVENANCE) {
    return { state: chromium.state, reasons, engineStates: engines?.perEngine || {} }
  }
  if (chromium.state === STATES.REJECT) {
    reasons.push('chromium rejected the partition; cross-engine guard skipped')
    return { state: STATES.REJECT, reasons, engineStates: {} }
  }
  if (chromium.state === STATES.INCONCLUSIVE) {
    reasons.push('chromium was inconclusive; cross-engine guard skipped and no replicates were added')
    return { state: STATES.INCONCLUSIVE, reasons, engineStates: {} }
  }
  // chromium PROMISING
  if (!engines) {
    reasons.push('chromium promised but no cross-engine guard result exists')
    return { state: STATES.INCOMPLETE, reasons, engineStates: {} }
  }
  reasons.push(...(engines.reasons || []))
  let state
  if (engines.state === STATES.INCOMPLETE) state = STATES.INCOMPLETE
  else if (engines.state === STATES.REJECT) state = STATES.REJECT
  else if (engines.state === STATES.INCONCLUSIVE) state = STATES.INCONCLUSIVE
  else state = STATES.PROMISING_TO_DESIGN
  return { state, reasons, engineStates: engines.perEngine || {} }
}