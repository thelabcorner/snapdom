/**
 * Pre-registered measurement-topology replacement rule.
 *
 * This module cannot promote snapDOM code. It decides only whether blocked6 has earned replacement
 * of current6 as the R9 measurement instrument.
 */

function nullCells(lane) {
  const cells = Object.values(lane?.controls || {})
  if (lane?.effectCell) cells.push(lane.effectCell)
  if (!cells.length) throw new Error(`lane ${lane?.lane || '<unknown>'} has no null cells`)
  return cells
}

export function nullSeverity(lane) {
  const cells = nullCells(lane)
  return {
    maxAbsMeanPct: Math.max(...cells.map((c) => Math.abs(c.meanPct ?? c.absMeanPct ?? 0))),
    maxAbsCiEndpointPct: Math.max(...cells.map((c) => c.maxAbsCiEndpointPct)),
    maxRunnerSdPp: Math.max(...cells.map((c) => c.runnerSdPp)),
  }
}

function finitePositiveRatio(numerator, denominator) {
  if (!(Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0)) return null
  return numerator / denominator
}

export function classifyTopology({ fixtures, policy }) {
  const rule = policy?.decision
  if (!rule || rule.schema !== 'snapdom-r9-topology-replacement-rule-v1') {
    throw new Error('topology replacement rule missing or unknown')
  }

  const hardFailures = []
  const inconclusive = []
  const rows = []
  let oldGlobalEndpoint = 0
  let newGlobalEndpoint = 0
  let oldGlobalSd = 0
  let newGlobalSd = 0

  for (const fixture of policy.fixtures) {
    const f = fixtures[fixture]
    if (!f) {
      inconclusive.push(`${fixture}: fixture summary missing`)
      continue
    }
    const oldLane = f.lanes?.[rule.incumbent]
    const newLane = f.lanes?.[rule.challenger]
    const canary = f.lanes?.identityCanary?.controls?.canary
    if (!oldLane || !newLane || !canary) {
      inconclusive.push(`${fixture}: incumbent/challenger/identity evidence missing`)
      continue
    }

    const oldNull = nullSeverity(oldLane)
    const newNull = nullSeverity(newLane)
    oldGlobalEndpoint = Math.max(oldGlobalEndpoint, oldNull.maxAbsCiEndpointPct)
    newGlobalEndpoint = Math.max(newGlobalEndpoint, newNull.maxAbsCiEndpointPct)
    oldGlobalSd = Math.max(oldGlobalSd, oldNull.maxRunnerSdPp)
    newGlobalSd = Math.max(newGlobalSd, newNull.maxRunnerSdPp)

    const endpointRegressionPp = newNull.maxAbsCiEndpointPct - oldNull.maxAbsCiEndpointPct
    const sdRatio = finitePositiveRatio(newNull.maxRunnerSdPp, oldNull.maxRunnerSdPp)
    const wallRatio = finitePositiveRatio(newLane.cost?.wallClockMsMedian, oldLane.cost?.wallClockMsMedian)

    if (newNull.maxAbsCiEndpointPct > rule.challengerMaxNullEndpointPct) {
      hardFailures.push(
        `${fixture}: challenger null endpoint ${newNull.maxAbsCiEndpointPct.toFixed(3)}% exceeds ${rule.challengerMaxNullEndpointPct}%`)
    }
    if (endpointRegressionPp > rule.maxPerFixtureNullEndpointRegressionPp) {
      hardFailures.push(
        `${fixture}: null endpoint regressed by ${endpointRegressionPp.toFixed(3)}pp (> ${rule.maxPerFixtureNullEndpointRegressionPp}pp)`)
    }
    if (sdRatio === null) {
      inconclusive.push(`${fixture}: runner-SD ratio is undefined`)
    } else if (sdRatio > rule.maxPerFixtureRunnerSdRatio) {
      hardFailures.push(
        `${fixture}: runner SD ratio ${sdRatio.toFixed(3)} exceeds ${rule.maxPerFixtureRunnerSdRatio}`)
    }
    if (wallRatio === null) {
      inconclusive.push(`${fixture}: wall-clock ratio is undefined`)
    } else if (wallRatio > rule.maxWallClockRatio) {
      hardFailures.push(
        `${fixture}: wall-clock ratio ${wallRatio.toFixed(3)} exceeds ${rule.maxWallClockRatio}`)
    }

    if (rule.requireIdentityCanaryIncludesZero && canary.excludesZero) {
      inconclusive.push(`${fixture}: identity canary excludes zero`)
    }
    if (canary.maxAbsCiEndpointPct > rule.identityCanaryMaxEndpointPct) {
      inconclusive.push(
        `${fixture}: identity canary endpoint ${canary.maxAbsCiEndpointPct.toFixed(3)}% exceeds ${rule.identityCanaryMaxEndpointPct}%`)
    }
    if (f.equalBudgetVerified !== true) {
      inconclusive.push(`${fixture}: equal timed-call budget not verified`)
    }

    const recovery = {}
    let resolvableDoses = 0
    for (const [dose, contrast] of Object.entries(f.comparison?.recoveries || {})) {
      const current = oldLane === f.lanes.current6
        ? f.lanes.treatmentCurrent?.doses?.[dose]?.recovery
        : null
      const blocked = newLane === f.lanes.blocked6
        ? f.lanes.treatmentBlocked?.doses?.[dose]?.recovery
        : null
      if (!current || !blocked) {
        inconclusive.push(`${fixture}/${dose}: treatment recovery missing`)
        continue
      }

      const currentResolved = current.ci95[0] > 0
      const blockedResolved = blocked.ci95[0] > 0
      const ratio = finitePositiveRatio(blocked.pct, current.pct)
      recovery[dose] = {
        currentPct: current.pct,
        blockedPct: blocked.pct,
        currentCi95: current.ci95,
        blockedCi95: blocked.ci95,
        ratio,
        currentResolved,
        blockedResolved,
        blockedStrictlyLower: !!contrast.blockedStrictlyLower,
      }

      // Only a dose that the incumbent itself resolves can adjudicate attenuation.
      if (!currentResolved) continue
      resolvableDoses += 1
      if (!blockedResolved) {
        hardFailures.push(`${fixture}/${dose}: incumbent resolves positive treatment but challenger does not`)
        continue
      }
      if (ratio === null || ratio < rule.recoveryRatioMin || ratio > rule.recoveryRatioMax) {
        hardFailures.push(
          `${fixture}/${dose}: recovery ratio ${ratio === null ? 'undefined' : ratio.toFixed(3)} outside [${rule.recoveryRatioMin}, ${rule.recoveryRatioMax}]`)
      }
      if (contrast.blockedStrictlyLower) {
        hardFailures.push(`${fixture}/${dose}: challenger recovery CI is strictly below incumbent`)
      }
    }

    if (resolvableDoses < rule.minResolvableDosesPerFixture) {
      inconclusive.push(
        `${fixture}: only ${resolvableDoses} incumbent treatment doses resolved; need ${rule.minResolvableDosesPerFixture}`)
    }

    rows.push({
      fixture,
      oldNull,
      newNull,
      endpointRegressionPp,
      sdRatio,
      wallRatio,
      identityCanary: {
        meanPct: canary.meanPct,
        ci95: canary.ci95,
        maxAbsCiEndpointPct: canary.maxAbsCiEndpointPct,
        excludesZero: canary.excludesZero,
      },
      recovery,
    })
  }

  const globalNullImprovementPp = oldGlobalEndpoint - newGlobalEndpoint
  const globalSdRatio = finitePositiveRatio(newGlobalSd, oldGlobalSd)
  const materialNullImprovement =
    globalNullImprovementPp >= rule.minGlobalNullEndpointImprovementPp
  const materialSdImprovement =
    globalSdRatio !== null &&
    globalSdRatio <= rule.maxGlobalRunnerSdRatioForMaterialImprovement
  const materialImprovement = materialNullImprovement || materialSdImprovement

  let verdict
  if (inconclusive.length) verdict = 'INCONCLUSIVE'
  else if (hardFailures.length) verdict = 'NO_GO'
  else if (materialImprovement) verdict = 'ACCEPT_NEW'
  else verdict = 'NO_GO'

  return {
    schema: 'snapdom-r9-topology-replacement-decision-v1',
    verdict,
    incumbent: rule.incumbent,
    challenger: rule.challenger,
    promotable: false,
    global: {
      oldMaxNullEndpointPct: oldGlobalEndpoint,
      newMaxNullEndpointPct: newGlobalEndpoint,
      nullEndpointImprovementPp: globalNullImprovementPp,
      oldMaxRunnerSdPp: oldGlobalSd,
      newMaxRunnerSdPp: newGlobalSd,
      runnerSdRatio: globalSdRatio,
      materialNullImprovement,
      materialSdImprovement,
      materialImprovement,
    },
    hardFailures,
    inconclusive,
    fixtures: rows,
    interpretation:
      verdict === 'ACCEPT_NEW'
        ? 'blocked6 earned replacement of current6 as the measurement topology only; this is not a snapDOM performance promotion'
        : verdict === 'NO_GO'
          ? 'blocked6 did not earn the added complexity; retain current6 as the measurement topology'
          : 'the challenge cannot adjudicate topology replacement from this evidence',
  }
}
