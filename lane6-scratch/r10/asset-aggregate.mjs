#!/usr/bin/env node
import fs from 'node:fs'
import { selectImageCohort } from '../r12/select-image-cohort.mjs'
import path from 'node:path'
import { aggregateLinear, aggregateLogPoints, sha256 } from './asset-bench-lib.mjs'

const ROOT = process.cwd()
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '='
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
const INPUT = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r10/aggregate-input'))
const PREPARED = path.resolve(ROOT, arg('prepared', 'lane6-scratch/r10/prepared.json'))
const OUT = path.resolve(ROOT, arg('out', 'lane6-scratch/r10/asset-summary.json'))
const EXPECTED = Number(arg('expected', '6'))

if (!Number.isInteger(EXPECTED) || EXPECTED < 2) throw new Error('expected runner count must be >= 2')
if (!fs.existsSync(PREPARED)) throw new Error('prepared.json missing')
const preparedBytes = fs.readFileSync(PREPARED)
const prepared = JSON.parse(preparedBytes)
const preparedSha256 = sha256(preparedBytes)
if (prepared.schema !== 'snapdom-r10-asblob-prepared-v1') throw new Error('prepared schema mismatch')
if (EXPECTED !== prepared.acquisition?.runnerReplicates) throw new Error('runner-count policy drifted after prepare')
for (const [rel, expected] of Object.entries(prepared.measurementFiles || {})) {
  const abs = path.resolve(ROOT, rel)
  if (!fs.existsSync(abs) || sha256(fs.readFileSync(abs)) !== expected) {
    throw new Error('aggregate measurement file digest mismatch: ' + rel)
  }
}
if (process.env.GITHUB_ACTIONS === 'true') {
  if (process.env.GITHUB_SHA !== prepared.measurementGitSha) throw new Error('aggregate measurement git SHA mismatch')
  if (process.env.GITHUB_REPOSITORY !== prepared.github?.repository) throw new Error('aggregate GitHub repository mismatch')
  if (process.env.GITHUB_RUN_ID !== prepared.github?.runId) throw new Error('aggregate GitHub run id mismatch')
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.isFile() && /^runner-r\d+\.json$/.test(ent.name)) out.push(p)
  }
  return out
}

const docs = []
for (const file of walk(INPUT)) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value?.schema === 'snapdom-r10-asblob-runner-v1') docs.push({ file, value })
  } catch {}
}

const byReplicate = new Map()
const duplicate = []
const wrongIdentity = []
const invalidEvidence = []
for (const item of docs) {
  const d = item.value
  if (byReplicate.has(d.replicate)) duplicate.push(d.replicate)
  else byReplicate.set(d.replicate, item)

  const p = d.provenance || {}
  if (
    p.measurementGitSha !== prepared.measurementGitSha ||
    p.candidateGitSha !== prepared.candidateGitSha ||
    p.baselineGitSha !== prepared.baselineGitSha ||
    p.candidateBundleSha256 !== prepared.candidate.sha256 ||
    p.baselineBundleSha256 !== prepared.baseline.sha256 ||
    p.preparedSha256 !== preparedSha256 ||
    p.nodeVersion !== prepared.nodeVersion ||
    p.playwrightVersion !== prepared.playwrightVersion ||
    p.browser?.name !== 'chromium' ||
    p.github?.repository !== prepared.github?.repository ||
    p.github?.runId !== prepared.github?.runId ||
    p.acquisition?.repeats !== prepared.acquisition?.repeats ||
    p.acquisition?.warmup !== prepared.acquisition?.warmup ||
    JSON.stringify(p.acquisition?.memorySettlePolicy) !== JSON.stringify(prepared.acquisition?.memorySettlePolicy) ||
    JSON.stringify(p.measurementFiles || {}) !== JSON.stringify(prepared.measurementFiles || {})
  ) {
    wrongIdentity.push(d.replicate)
  }
}
const expectedReplicates = Array.from({ length: EXPECTED }, (_, i) => i)
const missing = expectedReplicates.filter((r) => !byReplicate.has(r))

function incomplete() {
  const summary = {
    schema: 'snapdom-r10-asblob-summary-v1',
    state: 'INCOMPLETE_EVIDENCE',
    complete: false,
    performanceClaim: false,
    expectedRunners: EXPECTED,
    discoveredRunners: docs.length,
    missing,
    duplicate,
    wrongIdentity,
    invalidEvidence,
    measurementGitSha: prepared.measurementGitSha,
    candidateGitSha: prepared.candidateGitSha,
    baselineGitSha: prepared.baselineGitSha,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '### snapDOM R10 AS-BLOB experiment\n\n**INCOMPLETE_EVIDENCE** — no performance claim.\n\n' +
      '- missing runners: ' + (missing.join(', ') || 'none') + '\n' +
      '- duplicate runners: ' + (duplicate.join(', ') || 'none') + '\n' +
      '- wrong identity: ' + (wrongIdentity.join(', ') || 'none') + '\n' +
      '- invalid evidence: ' + (invalidEvidence.join(', ') || 'none') + '\n')
  }
  console.error(JSON.stringify(summary, null, 2))
  process.exit(1)
}

let runners = expectedReplicates.filter((r) => byReplicate.has(r)).map((r) => byReplicate.get(r).value)
const conditionIds = runners.length ? Object.keys(runners[0].conditions || {}) : []
if (runners.length && !conditionIds.length) invalidEvidence.push('runner artifact has no conditions')
const fixtureIdentity = runners.length ? JSON.stringify(runners[0].fixtures || {}) : ''
if (runners.length && fixtureIdentity === '{}') invalidEvidence.push('runner artifact has no fixture identity')

const browserVersions = [...new Set(runners.map((d) => d.provenance?.browser?.version).filter(Boolean))]
const runnerImages = [...new Set(runners.map((d) => {
  const r = d.provenance?.runner || {}
  return r.imageOs && r.imageVersion ? r.imageOs + '@' + r.imageVersion : null
}).filter(Boolean))]
const runAttempts = [...new Set(runners.map((d) => d.provenance?.github?.runAttempt).filter(Boolean))].sort()
if (runners.length && browserVersions.length !== 1) invalidEvidence.push('Chromium version is not homogeneous across fresh runners')
if (EXPECTED !== 12 && runners.length && runnerImages.length !== 1) invalidEvidence.push('GitHub runner image is not homogeneous across fresh runners')

const settlePolicy = prepared.acquisition?.memorySettlePolicy || {}
const memoryStateValid = (state) => (
  state?.stable === true &&
  Number.isFinite(state?.pssKb) &&
  Number.isFinite(state?.rendererPssKb) &&
  Number.isFinite(state?.settleRangePssKb) &&
  Number.isFinite(state?.settleDriftPssKb) &&
  state.settleRangePssKb <= settlePolicy.deltaKb &&
  state.settleDriftPssKb <= settlePolicy.maxDriftKb &&
  Array.isArray(state?.rendererPids) &&
  state.rendererPids.length >= 1 &&
  typeof state?.identityKey === 'string' &&
  state.identityKey.length > 0
)

const finiteEvidence = (d, id) => {
  const c = d.conditions?.[id]
  const scalars = [
    c?.timing?.logPoint,
    c?.timing?.renderLogPoint,
    c?.timing?.totalLogPoint,
    c?.timing?.orderBiasLog,
    c?.memory?.candidateMinusBaselineRetentionKb,
    c?.memory?.candidateMinusBaselineSweepKb,
    c?.memory?.candidateMinusBaselineTotalKb,
    c?.memory?.baseline?.warmupDeltaKb,
    c?.memory?.candidate?.warmupDeltaKb,
  ]
  if (!scalars.every(Number.isFinite)) return false

  for (const side of ['baseline', 'candidate']) {
    const m = c?.memory?.[side]
    if (!memoryStateValid(m?.initial) || !memoryStateValid(m?.warmed) || !memoryStateValid(m?.final)) return false
    if (m.initial.identityKey !== m.warmed.identityKey || m.warmed.identityKey !== m.final.identityKey) return false
  }
  return true
}

for (const d of runners) {
  if (JSON.stringify(d.fixtures || {}) !== fixtureIdentity) {
    invalidEvidence.push('r' + d.replicate + ': fixture identity mismatch')
  }
  if (JSON.stringify(Object.keys(d.conditions || {})) !== JSON.stringify(conditionIds)) {
    invalidEvidence.push('r' + d.replicate + ': condition identity/order mismatch')
    continue
  }
  for (const id of conditionIds) {
    const c = d.conditions[id]
    const canonical = runners[0].conditions[id]
    if (
      c?.role !== canonical?.role ||
      c?.fixture !== canonical?.fixture ||
      c?.csp !== canonical?.csp ||
      c?.sweep !== canonical?.sweep
    ) {
      invalidEvidence.push('r' + d.replicate + '/' + id + ': condition metadata mismatch')
    }
    if (!finiteEvidence(d, id)) invalidEvidence.push('r' + d.replicate + '/' + id + ': missing or non-finite primary evidence')
  }
}

if (missing.length || duplicate.length || wrongIdentity.length || invalidEvidence.length || docs.length !== EXPECTED) incomplete()

// R12 prospective 12-host acquisition: select a homogeneous stratum using ONLY complete
// runner image identity metadata. Every acquired runner has already passed provenance,
// fixture and finite-memory checks. Preserve all excluded files and report their IDs.
const cohort = EXPECTED === 12 ? selectImageCohort(runners, 6) : null
if (cohort && !cohort.valid) {
  invalidEvidence.push('no six-runner homogeneous image cohort in prospective twelve-host acquisition')
  incomplete()
}
if (cohort) runners = cohort.selectedDocs

const conditions = {}
for (const id of conditionIds) {
  const cells = runners.map((d) => d.conditions[id])
  const capturePoints = cells.map((c) => c.timing.logPoint)
  const totalPoints = cells.map((c) => c.timing.totalLogPoint)
  const retentionDiff = cells.map((c) => c.memory.candidateMinusBaselineRetentionKb)
  const sweepDiff = cells.map((c) => c.memory.candidateMinusBaselineSweepKb)
  const totalDiff = cells.map((c) => c.memory.candidateMinusBaselineTotalKb)
  const baselineWarmup = cells.map((c) => c.memory.baseline.warmupDeltaKb)
  const candidateWarmup = cells.map((c) => c.memory.candidate.warmupDeltaKb)

  conditions[id] = {
    role: cells[0].role,
    fixture: cells[0].fixture,
    csp: cells[0].csp,
    sweep: cells[0].sweep,
    timing: {
      primary: 'capture',
      capture: aggregateLogPoints(capturePoints),
      endToEnd: aggregateLogPoints(totalPoints),
    },
    memory: {
      candidateMinusBaselineRetentionKb: aggregateLinear(retentionDiff),
      candidateMinusBaselineSweepKb: aggregateLinear(sweepDiff),
      candidateMinusBaselineTotalKb: aggregateLinear(totalDiff),
      baselineWarmupDeltaKb: aggregateLinear(baselineWarmup),
      candidateWarmupDeltaKb: aggregateLinear(candidateWarmup),
    },
    runnerPoints: runners.map((d, i) => ({
      replicate: d.replicate,
      captureTimingPct: (Math.exp(capturePoints[i]) - 1) * 100,
      endToEndTimingPct: (Math.exp(totalPoints[i]) - 1) * 100,
      retentionDiffKb: retentionDiff[i],
      sweepDiffKb: sweepDiff[i],
      totalDiffKb: totalDiff[i],
      baselineWarmupDeltaKb: baselineWarmup[i],
      candidateWarmupDeltaKb: candidateWarmup[i],
      runAttempt: d.provenance.github?.runAttempt || null,
      runnerImageVersion: d.provenance.runner?.imageVersion || null,
      browserVersion: d.provenance.browser?.version || null,
    })),
  }
}

const matchedMemoryControls = {}
const cspRetention = runners.map((d) => d.conditions?.['large-csp']?.memory?.candidateMinusBaselineRetentionKb)
if (cspRetention.every(Number.isFinite)) {
  for (const [id, condition] of Object.entries(conditions)) {
    if (condition.role !== 'claim') continue
    const claimRetention = runners.map((d) => d.conditions[id].memory.candidateMinusBaselineRetentionKb)
    const did = claimRetention.map((x, i) => x - cspRetention[i])
    matchedMemoryControls[id] = {
      control: 'large-csp',
      estimand: '(candidate-baseline retention PSS)claim - (candidate-baseline retention PSS)large-csp',
      effectKb: aggregateLinear(did),
      runnerPointsKb: did,
    }
  }
}

const summary = {
  schema: 'snapdom-r10-asblob-summary-v1',
  state: cohort ? 'EXPERIMENT_COMPLETE_IMAGE_COHORT' : 'EXPERIMENT_COMPLETE',
  complete: true,
  performanceClaim: false,
  generatedAt: new Date().toISOString(),
  expectedRunners: EXPECTED,
  observedRunners: runners.length,
  totalValidatedRunnerArtifacts: docs.length,
  samplingPlan: cohort ? 'prospective-12-image-stratum' : 'six-homogeneous',
  selectedImage: cohort?.selectedImage || null,
  cohortStrata: cohort?.strata || null,
  selectedRunnerIds: cohort?.selectedRunnerIds || null,
  excludedRunnerIds: cohort?.excludedRunnerIds || [],
  measurementGitSha: prepared.measurementGitSha,
  candidateGitSha: prepared.candidateGitSha,
  baselineGitSha: prepared.baselineGitSha,
  candidateBundleSha256: prepared.candidate.sha256,
  baselineBundleSha256: prepared.baseline.sha256,
  mechanism: prepared.mechanism,
  fixtures: runners[0].fixtures,
  conditions,
  matchedMemoryControls,
  interpretation: 'Runner-level paired mechanism experiment only. Capture timing is primary; end-to-end timing is secondary. Negative timing means candidate faster. Primary memory is candidate-minus-baseline post-warmup process-tree PSS retention increment; claim-arm memory is also reported as a runner-matched difference-in-differences against the workload-matched large-csp retention-free control. Sweep and total deltas are secondary. No promotion threshold was preregistered.',
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = []
  for (const [id, c] of Object.entries(conditions)) {
    const capture = c.timing.capture
    const total = c.timing.endToEnd
    const retention = c.memory.candidateMinusBaselineRetentionKb
    const sweep = c.memory.candidateMinusBaselineSweepKb
    rows.push(
      '| ' + id + ' | ' + c.role + ' | ' +
      (capture.available ? capture.pct.toFixed(2) + '%' : 'n/a') + ' | ' +
      (capture.available ? '[' + capture.ci95.map((x) => x.toFixed(2)).join(', ') + ']%' : 'n/a') + ' | ' +
      (total.available ? total.pct.toFixed(2) + '%' : 'n/a') + ' | ' +
      (retention.available ? (retention.point / 1024).toFixed(1) + ' MiB' : 'n/a') + ' | ' +
      (retention.available ? '[' + retention.ci95.map((x) => (x / 1024).toFixed(1)).join(', ') + '] MiB' : 'n/a') + ' | ' +
      (sweep.available ? (sweep.point / 1024).toFixed(1) + ' MiB' : 'n/a') + ' |',
    )
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '### snapDOM R10 AS-BLOB experiment',
    '',
    '**EXPERIMENT_COMPLETE** — paired runner-level evidence; no automatic performance claim.',
    '',
    '- runners: ' + runners.length + '/' + EXPECTED,
    '- candidate bundle: ' + prepared.candidate.sha256.slice(0, 12),
    '- baseline bundle: ' + prepared.baseline.sha256.slice(0, 12),
    '- retention cap: ' + Math.round(prepared.mechanism.maxImageBlobBytes / 1024 / 1024) + ' MiB (HYPOTHESIS)',
    '',
    '| condition | role | capture timing | 95% runner CI | end-to-end timing | retention RSS delta | 95% runner CI | post-warm sweep delta |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...rows,
    '',
    'Negative timing is faster. Positive retention PSS delta means the candidate added more settled Chromium process-tree proportional-set memory during warmup than baseline.',
    '',
    ...Object.entries(matchedMemoryControls).flatMap(([id, x]) => [
      '- matched memory control ' + id + ' vs ' + x.control + ': ' +
        (x.effectKb.available ? (x.effectKb.point / 1024).toFixed(2) + ' MiB [' +
          x.effectKb.ci95.map((v) => (v / 1024).toFixed(2)).join(', ') + '] MiB' : 'unavailable'),
    ]),
    '',
  ].join('\n'))
}

console.log(JSON.stringify(summary, null, 2))
