#!/usr/bin/env node
/**
 * Runner-level closeout for the R9 hosted topology challenge.
 *
 * Reads only the decision documents, each of which carries ONE SCALAR PER RUNNER and no observation
 * rows, and produces the preregistered comparison table. It fails closed: a missing runner, an
 * unusable runner, a duplicate cell or a provenance mismatch is `INCOMPLETE_EVIDENCE` and a non-zero
 * exit, never a quiet average over whoever answered.
 *
 * It also NEVER decides. `attenuation` is a flag a human must read, not a gate: the ledger keeps the
 * promotion policy unfrozen, and the only legitimate outcome of this workflow is evidence.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  completenessAudit,
  controlCell,
  laneSummary,
  pairedRecovery,
  primaryComparison,
  PREREGISTERED_METRICS,
  assertRunnerLevelOnly,
} from './algebra/aggregate-contract.mjs'
import { EQUAL_BUDGET_PAIRS, DOSES, laneBudget } from './algebra/call-budget.mjs'
import { classifyTopology } from './algebra/decision.mjs'

const ROOT = process.cwd()
const CHAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge')
const PREP = path.join(CHAL, 'prepared.json')
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const INPUT = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r9-calibration/challenge/aggregate-input'))
const OUT = path.resolve(ROOT, arg('out', 'lane6-scratch/r9-calibration/challenge/topology-summary.json'))
const appendSummary = (s) => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, s) }
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return null
  return s.length & 1 ? s[s.length >> 1] : (s[s.length - 1] + s[s.length >> 1]) / 2
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.isFile() && /^topology-(chromium)-r\d+\.json$/.test(ent.name) && p.includes('decisions')) out.push(p)
  }
  return out
}

if (!fs.existsSync(PREP)) throw new Error('prepared.json missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
const profile = arg('profile', 'primary')
if (!policy.sampling[profile]) throw new Error(`unknown sampling profile: ${profile}`)
const sampling = policy.sampling[profile]

const files = walk(INPUT)
const docs = []
for (const file of files) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (d.schema !== 'snapdom-r9-hosted-topology-challenge-decision-v1') continue
    if (d.profile !== profile) continue
    assertRunnerLevelOnly(d)
    docs.push(d)
  } catch (error) {
    console.error(`rejected ${path.basename(file)}: ${error.message}`)
  }
}

const expected = Array.from({ length: policy.replicates.chromium }, (_, r) => `chromium:${r}`)
const audit = completenessAudit(expected, docs, {
  identityOf: (d) => ({ policySha256: d.policySha256, candidateGitSha: d.candidateGitSha, bundleSha256: d.bundleSha256, profile: d.profile }),
  requiredIdentity: {
    policySha256: prepared.policySha256,
    candidateGitSha: prepared.candidateGitSha,
    bundleSha256: prepared.bundle.sha256,
    profile,
  },
})

const incomplete = {
  schema: 'snapdom-r9-hosted-topology-challenge-summary-v1',
  state: 'INCOMPLETE_EVIDENCE',
  complete: false,
  performanceClaim: false,
  promotable: false,
  generatedAt: new Date().toISOString(),
  profile,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
  expectedRunners: expected.length,
  discoveredRunners: docs.length,
  ...audit,
  rejected: files.length - docs.length,
}
if (!audit.ok) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(incomplete, null, 2) + '\n')
  appendSummary([
    '### snapDOM R9 hosted topology challenge',
    '',
    '**INCOMPLETE_EVIDENCE** — no comparison is possible and **no performance claim** exists.',
    '',
    `- expected fresh Chromium runners: ${expected.length}`,
    `- discovered: ${docs.length} (rejected ${incomplete.rejected})`,
    `- missing: ${audit.missing.join(', ') || 'none'}`,
    `- unusable: ${audit.unusable.join(', ') || 'none'}`,
    `- duplicates: ${audit.duplicates.join(', ') || 'none'}`,
    `- wrong identity: ${audit.wrongIdentity.join(', ') || 'none'}`,
    '',
    'The equal-cost topology comparison is refused rather than computed over a partial matrix.',
    '',
  ].join('\n'))
  console.error(JSON.stringify(incomplete, null, 2))
  process.exit(1)
}

const byKey = new Map(docs.map((d) => [`${d.browser}:${d.replicate}`, d]))
const ordered = expected.map((k) => byKey.get(k))

const fixtures = {}
for (const fixture of policy.fixtures) {
  const lanes = {}
  for (const lane of policy.lanes) {
    const points = ordered.map((d) => d.fixtures[fixture].lanes[lane])
    const spec = laneBudget(lane, sampling)
    const cost = {
      timedCalls: points[0].executedTimedCalls,
      wallClockMsMedian: median(points.map((p) => p.wallClockMs)),
      acquireMsMedian: median(points.map((p) => p.acquireMs)),
    }
    if (cost.timedCalls !== spec.timedCalls) {
      throw new Error(`${fixture}/${lane}: executed timed calls disagree with the frozen budget`)
    }
    const role = points[0].role
    if (role === 'recovery') {
      const doses = {}
      for (const dose of DOSES) {
        const t = points.map((p) => p.doses[dose].treatment.logPoint)
        const c = points.map((p) => p.doses[dose].treatmentNull.logPoint)
        doses[dose] = {
          iterations: points[0].doses[dose].iterations,
          treatment: controlCell(t, { label: `treatment:${dose}` }),
          treatmentNull: controlCell(c, { label: `treatmentNull:${dose}` }),
          recovery: pairedRecovery(t, c),
          realisedInjectedArmMsMean: median(points.map((p) => p.injectedArmMsMean)),
          captureMsArmDeltaMsMax: Math.max(...points.map((p) => Math.abs(p.captureMsArmDeltaMs))),
        }
      }
      lanes[lane] = { ...laneSummary({ lane, topology: points[0].topology, role, treatmentSensitive: points[0].treatmentSensitive, controls: {}, cost }), doses }
      continue
    }
    const controls = {}
    const cellNames = role === 'canary' ? ['canary'] : ['baseNull', 'optNull']
    for (const name of cellNames) controls[name] = points.map((p) => p.cells[name].logPoint)
    const effectName = role === 'canary' ? null : points[0].cells.candidate ? 'candidate' : 'effect'
    lanes[lane] = laneSummary({
      lane,
      topology: points[0].topology,
      role,
      treatmentSensitive: points[0].treatmentSensitive,
      controls,
      effectCell: effectName ? points.map((p) => p.cells[effectName].logPoint) : null,
      cost,
    })
    lanes[lane].positionPremiumPp = {
      median: median(points.map((p) => p.positionPremiumLog)) * 100,
      max: Math.max(...points.map((p) => p.positionPremiumLog)) * 100,
    }
    lanes[lane].warmToFirstSampleGapMsMedian = median(points.map((p) => p.warmToFirstSampleGapMsMedian))
    lanes[lane].maxAbsBlockLogRatio = Math.max(...points.map((p) => p.maxAbsBlockLogRatio))
    lanes[lane].identityCanaryCanExcludeZero = lanes[lane].controls.canary
      ? lanes[lane].controls.canary.excludesZero
      : null
  }

  const comparison = primaryComparison({
    current: lanes.current6,
    blocked: lanes.blocked6,
    currentTreatments: Object.fromEntries(DOSES.map((d) => [d, lanes.treatmentCurrent.doses[d].recovery])),
    blockedTreatments: Object.fromEntries(DOSES.map((d) => [d, lanes.treatmentBlocked.doses[d].recovery])),
    doses: [...DOSES],
  })
  const reversal = {
    baseNullSignFlipped: Math.sign(lanes.current6.controls.baseNull.meanPct) !== Math.sign(lanes.current6Reversed.controls.baseNull.meanPct),
    currentBaseNullAbsMeanPct: lanes.current6.controls.baseNull.absMeanPct,
    reversedBaseNullAbsMeanPct: lanes.current6Reversed.controls.baseNull.absMeanPct,
    // A full reversal of the canonical list maps creation index i -> layouts-1-i, which EXCHANGES
    // the candidate pair with the optNull pair. Magnitudes should follow; if they do not, the
    // mechanism in ledger section 4 is not creation-order coupled and this premise is wrong.
    currentCandidateAbsMeanPct: lanes.current6.effectCell.absMeanPct,
    reversedOptNullAbsMeanPct: lanes.current6Reversed.controls.optNull.absMeanPct,
    currentOptNullAbsMeanPct: lanes.current6.controls.optNull.absMeanPct,
    reversedCandidateAbsMeanPct: lanes.current6Reversed.effectCell.absMeanPct,
    canaryAbsMeanPct: lanes.identityCanary.controls.canary.absMeanPct,
    canaryMaxAbsCiEndpointPct: lanes.identityCanary.controls.canary.maxAbsCiEndpointPct,
    canaryExcludesZero: lanes.identityCanary.controls.canary.excludesZero,
  }
  fixtures[fixture] = {
    lanes,
    comparison,
    reversal,
    equalBudgetVerified: EQUAL_BUDGET_PAIRS.every(([a, b]) => lanes[a].cost.timedCalls === lanes[b].cost.timedCalls),
    runnerSdPpByLane: Object.fromEntries(policy.lanes.map((l) => [l, lanes[l].runnerSdPp])),
  }
}

const topologyDecision = classifyTopology({ fixtures, policy })

const summary = {
  schema: 'snapdom-r9-hosted-topology-challenge-summary-v1',
  state: 'CHALLENGE_COMPLETE',
  complete: true,
  performanceClaim: false,
  promotable: false,
  verdict: topologyDecision.verdict,
  generatedAt: new Date().toISOString(),
  profile,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
  freshRunners: ordered.length,
  fixtures: policy.fixtures,
  preregisteredMetrics: PREREGISTERED_METRICS,
  budget: {
    perLane: Object.fromEntries(policy.lanes.map((l) => [l, laneBudget(l, sampling)])),
    equalBudgetPairs: EQUAL_BUDGET_PAIRS,
    timedCallsPerFixture: policy.lanes.reduce((a, l) => a + laneBudget(l, sampling).timedCalls, 0),
  },
  runnerProvenance: {
    imageVersions: [...new Set(ordered.map((d) => d.runner?.imageVersion).filter(Boolean))],
    browserVersions: [...new Set(ordered.map((d) => d.browserVersion).filter(Boolean))],
    cpuModels: [...new Set(ordered.map((d) => d.runner?.cpuModel).filter(Boolean))],
    runnerNames: [...new Set(ordered.map((d) => d.runner?.name).filter(Boolean))].length,
  },
  challenge: fixtures,
  topologyDecision,
  successCriterion: policy.successCriterion,
  openFalsifiers: policy.openFalsifiers,
  interpretation:
    'Self-null topology challenge. Every arm in every lane except the injected positive control is ' +
    'byte- and option-identical, so a non-zero control is measurement bias, never a snapDOM effect. ' +
    'CHALLENGE_COMPLETE means the preregistered matrix was collected. The topologyDecision may ' +
    'select or reject a MEASUREMENT TOPOLOGY only; it is not an optimization, non-regression, code merge ' +
    'or snapDOM promotion claim.',
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')

const rows = []
for (const fixture of policy.fixtures) {
  const f = fixtures[fixture]
  rows.push(`| ${fixture} | current6 | ${f.lanes.current6.absControlMeanPct?.toFixed(2)} | ${f.lanes.current6.maxAbsControlCiEndpointPct?.toFixed(2)} | ${f.lanes.current6.runnerSdPp?.toFixed(2)} | — | ${f.lanes.current6.cost.timedCalls} |`)
  rows.push(`| ${fixture} | blocked6 | ${f.lanes.blocked6.absControlMeanPct?.toFixed(2)} | ${f.lanes.blocked6.maxAbsControlCiEndpointPct?.toFixed(2)} | ${f.lanes.blocked6.runnerSdPp?.toFixed(2)} | — | ${f.lanes.blocked6.cost.timedCalls} |`)
  for (const dose of DOSES) {
    const c = f.comparison.recoveries[dose]
    rows.push(`| ${fixture} | treatment ${dose} (current) | — | — | — | ${c.currentPct.toFixed(2)}% [${f.lanes.treatmentCurrent.doses[dose].recovery.ci95.map((v) => v.toFixed(2)).join(', ')}] | ${f.lanes.treatmentCurrent.cost.timedCalls} |`)
    rows.push(`| ${fixture} | treatment ${dose} (blocked) | — | — | — | ${c.blockedPct.toFixed(2)}% [${f.lanes.treatmentBlocked.doses[dose].recovery.ci95.map((v) => v.toFixed(2)).join(', ')}] | ${f.lanes.treatmentBlocked.cost.timedCalls} |`)
  }
  rows.push(`| ${fixture} | identityCanary | ${f.reversal.canaryAbsMeanPct.toFixed(2)} | ${f.reversal.canaryMaxAbsCiEndpointPct.toFixed(2)} | ${f.lanes.identityCanary.runnerSdPp?.toFixed(2)} | ${f.lanes.identityCanary.treatmentSensitive ? 'SENSITIVE' : 'not treatment-sensitive'} | ${f.lanes.identityCanary.cost.timedCalls} |`)
  rows.push(`| ${fixture} | current6Reversed | ${f.reversal.reversedBaseNullAbsMeanPct.toFixed(2)} | ${f.lanes.current6Reversed.maxAbsControlCiEndpointPct?.toFixed(2)} | ${f.lanes.current6Reversed.runnerSdPp?.toFixed(2)} | baseNull sign flipped: ${f.reversal.baseNullSignFlipped} | ${f.lanes.current6Reversed.cost.timedCalls} |`)
}
appendSummary([
  '### snapDOM R9 hosted topology challenge',
  '',
  '**CHALLENGE_COMPLETE** — equal-cost topology evidence only; **no performance claim, no promotion**.',
  '',
  `- profile: \`${profile}\``,
  `- fresh Chromium runners: ${ordered.length}/${expected.length}`,
  `- bundle: \`${prepared.bundle.sha256.slice(0, 12)}\``,
  `- candidate SHA: \`${prepared.candidateGitSha.slice(0, 12)}\``,
  `- timed calls per fixture per runner: ${summary.budget.timedCallsPerFixture} (equal on every preregistered compared pair)`,
  `- topology replacement verdict: **${topologyDecision.verdict}**`,
  `- worst null endpoint: OLD ${topologyDecision.global.oldMaxNullEndpointPct.toFixed(2)}% → NEW ${topologyDecision.global.newMaxNullEndpointPct.toFixed(2)}%`,
  `- worst runner SD(log): OLD ${topologyDecision.global.oldMaxRunnerSdPp.toFixed(2)}pp → NEW ${topologyDecision.global.newMaxRunnerSdPp.toFixed(2)}pp`,
  '',
  '| fixture | lane | \\|control mean\\| % | max abs control CI endpoint % | runner SD(log) pp | positive-control recovery | timed calls |',
  '|---|---|---:|---:|---:|---:|---:|',
  ...rows,
  '',
  '**Read the recovery columns before the bias columns.** A topology that lowers control bias while',
  'its recovery CI sits strictly below the current rig\'s is attenuating real treatment sensitivity',
  'and is rejected regardless of how clean its nulls look.',
  '',
  `Attenuation flag raised on: ${Object.entries(fixtures).filter(([, f]) => f.comparison.attenuation).map(([k]) => k).join(', ') || 'no fixture'}.`,
  '',
  ...policy.openFalsifiers.map((f) => `- falsifier: ${f}`),
  '',
].join('\n'))
console.log(JSON.stringify(summary, null, 2))
