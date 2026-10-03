/**
 * Runner-level aggregation contract for the R9 hosted topology challenge.
 *
 * Pure arithmetic on ONE SCALAR PER FRESH RUNNER. There is deliberately no code path in this file
 * that can accept per-call rows, per-page rows or per-block rows, because the ledger (§7) is
 * explicit that pooling raw observations across fresh VMs is what turns a runner-level dispersion
 * measurement into an uninterpretable soup. `assertRunnerLevelOnly` enforces that on the documents
 * the closeout actually reads.
 *
 * Every metric named here is one the challenge preregisters in advance. This file only computes
 * runner-level evidence. The separate decision.mjs applies the preregistered topology-replacement
 * rule; neither module can promote snapDOM code.
 */

const T975 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262,
  10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110,
  18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
  26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
}

export function t975(df) {
  if (!Number.isInteger(df) || df < 1) throw new Error(`invalid degrees of freedom: ${df}`)
  return T975[Math.min(30, df)] ?? 1.96
}

export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
export const pctFromLog = x => (Math.exp(x) - 1) * 100
export const logFromPct = p => Math.log(1 + p / 100)

export function variance(xs) {
  if (xs.length < 2) throw new Error(`need >= 2 runner points, got ${xs.length}`)
  const m = mean(xs)
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
}

/** Runner-level aggregate: mean of the per-runner log point estimates plus a Student-t interval. */
export function runnerAggregate(pointsLog) {
  if (!Array.isArray(pointsLog) || pointsLog.length < 2) {
    throw new Error('runner aggregate needs at least two per-runner points')
  }
  for (const x of pointsLog) {
    if (!Number.isFinite(x)) throw new Error('runner aggregate received a non-finite point')
  }
  const m = mean(pointsLog)
  const sd = Math.sqrt(variance(pointsLog))
  const se = sd / Math.sqrt(pointsLog.length)
  const h = t975(pointsLog.length - 1) * se
  return {
    n: pointsLog.length,
    logPoint: m,
    pct: pctFromLog(m),
    runnerSdLog: sd,
    runnerSdPp: sd * 100,
    seLog: se,
    logCi95: [m - h, m + h],
    ci95: [pctFromLog(m - h), pctFromLog(m + h)],
    runnerPointsPct: pointsLog.map(pctFromLog),
  }
}

/**
 * One AA/BB control cell (baseNull, optNull, or the blocked rig's equivalents), aggregated across
 * fresh runners.
 *
 * `absMeanPct` and `maxAbsCiEndpointPct` are the two numbers the challenge is actually about: how
 * far the control mean sits from zero, and how far the worst CI endpoint sits from zero. The
 * corrected hosted run put baseNull at +2.57% [+1.09, +4.08] on cards400-safe while optNull on the
 * same pages read +0.28% [-1.71, +2.31]; `maxAbsCiEndpointPct` is what makes that asymmetry
 * legible without a threshold.
 */
export function controlCell(pointsLog, { label = null } = {}) {
  const agg = runnerAggregate(pointsLog)
  return {
    label,
    n: agg.n,
    meanPct: agg.pct,
    absMeanPct: Math.abs(agg.pct),
    ci95: agg.ci95,
    maxAbsCiEndpointPct: Math.max(Math.abs(agg.ci95[0]), Math.abs(agg.ci95[1])),
    excludesZero: agg.ci95[0] > 0 || agg.ci95[1] < 0,
    runnerSdLog: agg.runnerSdLog,
    runnerSdPp: agg.runnerSdPp,
    runnerPointsPct: agg.runnerPointsPct,
  }
}

/**
 * Treatment-control recovery, differenced WITHIN each runner before averaging.
 *
 * The treatment lane and its own same-topology null are acquired in the same runner session, so
 * differencing per runner keeps the runner-wide page speed and the runner-wide state common-mode.
 * Differencing after aggregation across runners would throw that pairing away.
 */
export function pairedRecovery(treatmentLogByRunner, controlLogByRunner) {
  if (treatmentLogByRunner.length !== controlLogByRunner.length) {
    throw new Error('recovery needs one treatment and one control point per runner')
  }
  const perRunner = treatmentLogByRunner.map((t, i) => t - controlLogByRunner[i])
  const agg = runnerAggregate(perRunner)
  return {
    ...agg,
    perRunnerPct: perRunner.map(pctFromLog),
    positive: agg.ci95[0] > 0,
    negative: agg.ci95[1] < 0,
  }
}

/** Ratio of two recoveries with the CI overlap that a reader needs to judge it. */
export function recoveryContrast(currentRecovery, blockedRecovery) {
  const overlap = !(
    currentRecovery.ci95[1] < blockedRecovery.ci95[0] ||
    blockedRecovery.ci95[1] < currentRecovery.ci95[0]
  )
  return {
    currentPct: currentRecovery.pct,
    blockedPct: blockedRecovery.pct,
    differencePp: blockedRecovery.pct - currentRecovery.pct,
    ratio: currentRecovery.pct === 0 ? null : blockedRecovery.pct / currentRecovery.pct,
    ciOverlap: overlap,
    // NOT a threshold: a flag a human reads. A topology that recovers a smaller effect has its CI
    // strictly below the other's, and that is the attenuation the challenge must not accept.
    blockedStrictlyLower: blockedRecovery.ci95[1] < currentRecovery.ci95[0],
  }
}

export function ciOverlap(a, b) {
  return !(a[1] < b[0] || b[1] < a[0])
}

/** The preregistered metric list. Order matters: it is the order of the closeout table. */
export const PREREGISTERED_METRICS = Object.freeze([
  'absControlMeanPct',
  'maxAbsControlCiEndpointPct',
  'runnerSdPp',
  'recoveryPct',
  'recoveryCi95',
  'timedCalls',
  'wallClockMsMedian',
])

/**
 * Fail-closed completeness audit.
 *
 * The ledger's README rule: a blocked ambient gate, a missing report, a provenance drift or a
 * missing matrix cell must make the closeout INCOMPLETE_EVIDENCE. Zero evidence must never look
 * like a successful benchmark, and a partially-collected matrix must never be silently averaged over
 * the runners that did answer.
 */
export function completenessAudit(expectedKeys, docs, { identityOf = () => ({}), requiredIdentity = {} } = {}) {
  const byKey = new Map()
  const duplicates = []
  for (const doc of docs) {
    const key = `${doc.browser}:${doc.replicate}`
    if (byKey.has(key)) duplicates.push(key)
    else byKey.set(key, doc)
  }
  const missing = expectedKeys.filter(k => !byKey.has(k))
  const unusable = expectedKeys.filter(k => {
    const d = byKey.get(k)
    return d && (d.state !== 'CHALLENGE_SAMPLE' || d.usable !== true)
  })
  const wrongIdentity = expectedKeys.filter(k => {
    const d = byKey.get(k)
    if (!d) return false
    const got = identityOf(d)
    return Object.entries(requiredIdentity).some(([field, want]) => got[field] !== want)
  })
  return {
    expected: expectedKeys.length,
    discovered: docs.length,
    missing,
    unusable,
    duplicates,
    wrongIdentity,
    ok: !missing.length && !unusable.length && !duplicates.length && !wrongIdentity.length,
  }
}

/** Keys that would mean raw observation rows leaked into a runner-level document. */
const RAW_ROW_KEYS = new Set([
  'calls', 'rows', 'pageRows', 'perCall', 'blocks', 'logRatios', 'slots', 'heapSeries',
])

/**
 * Reject any decision document that carries observation rows.
 *
 * Runner-level aggregation only. A document that smuggles per-call rows back in would let a future
 * edit pool them across fresh VMs, which is exactly the mistake the ledger warns about. The bound
 * is generous because a legitimate runner-level field is a short array (e.g. per-runner wall
 * clock); anything longer than `maxArrayLength` is an observation series.
 */
export function assertRunnerLevelOnly(doc, { maxArrayLength = 64, trail = 'fixtures' } = {}) {
  const walk = (node, pointer) => {
    if (Array.isArray(node)) {
      if (node.length > maxArrayLength) {
        throw new Error(`runner-level document carries an observation series at ${pointer} (${node.length} entries)`)
      }
      node.forEach((v, i) => walk(v, `${pointer}[${i}]`))
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (RAW_ROW_KEYS.has(key)) {
        throw new Error(`runner-level document carries raw rows: ${pointer}.${key}`)
      }
      walk(value, `${pointer}.${key}`)
    }
  }
  walk(doc[trail], trail)
  return true
}

/** One lane's runner-level summary, assembled from per-runner cell points. */
export function laneSummary({
  lane, topology, role, treatmentSensitive = null, controls, effectCell = null, doses = null, cost = null,
}) {
  const controlEntries = Object.entries(controls).map(([name, pointsLog]) => [name, controlCell(pointsLog, { label: name })])
  const absControlMeanPct = controlEntries.length
    ? Math.max(...controlEntries.map(([, c]) => c.absMeanPct))
    : null
  const maxAbsControlCiEndpointPct = controlEntries.length
    ? Math.max(...controlEntries.map(([, c]) => c.maxAbsCiEndpointPct))
    : null
  const runnerSdPp = controlEntries.length
    ? Math.max(...controlEntries.map(([, c]) => c.runnerSdPp))
    : null
  return {
    lane,
    topology,
    role,
    // The identity canary is false BY CONSTRUCTION, not by measurement. Carrying it explicitly keeps
    // the closeout from ever presenting the canary as a treatment comparator.
    treatmentSensitive,
    controls: Object.fromEntries(controlEntries),
    absControlMeanPct,
    maxAbsControlCiEndpointPct,
    runnerSdPp,
    effectCell: effectCell ? controlCell(effectCell, { label: lane }) : null,
    doses: doses ?? null,
    cost: cost ?? null,
  }
}

/**
 * The primary comparison table reports signed differences and CI overlaps without mutating them.
 * decision.mjs consumes these raw runner-level summaries under the preregistered replacement rule.
 * `attenuation` remains explicit because a topology that lowers null noise by attenuating treatment
 * sensitivity must never be selected.
 */
export function primaryComparison({
  current, blocked, currentTreatments, blockedTreatments, doses = ['low', 'high'],
}) {
  const rows = []
  const metric = (name, key) => {
    const a = current[key]
    const b = blocked[key]
    if (a === null || a === undefined || b === null || b === undefined) return
    rows.push({ metric: name, current: a, blocked: b, blockedLower: b < a, deltaPp: b - a })
  }
  metric('absControlMeanPct', 'absControlMeanPct')
  metric('maxAbsControlCiEndpointPct', 'maxAbsControlCiEndpointPct')
  metric('runnerSdPp', 'runnerSdPp')
  const recoveries = {}
  for (const dose of doses) {
    const c = currentTreatments?.[dose]
    const b = blockedTreatments?.[dose]
    if (!c || !b) continue
    recoveries[dose] = recoveryContrast(c, b)
    rows.push({
      metric: `recoveryPct:${dose}`,
      current: c.pct,
      blocked: b.pct,
      blockedLower: b.pct < c.pct,
      deltaPp: b.pct - c.pct,
      ci95: { current: c.ci95, blocked: b.ci95 },
    })
  }
  const costEqual = current.cost && blocked.cost ? current.cost.timedCalls === blocked.cost.timedCalls : null
  return {
    rows,
    recoveries,
    timedCallsEqual: costEqual,
    attenuation: doses.some((d) => recoveries[d]?.blockedStrictlyLower),
    verdict: 'evidence-only',
  }
}
