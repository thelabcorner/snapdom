#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { aggregateLinear, aggregateLogPoints } from './asset-bench-lib.mjs'

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
const prepared = JSON.parse(fs.readFileSync(PREPARED, 'utf8'))

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
for (const item of docs) {
  const d = item.value
  if (byReplicate.has(d.replicate)) duplicate.push(d.replicate)
  else byReplicate.set(d.replicate, item)

  const p = d.provenance || {}
  if (
    p.candidateGitSha !== prepared.candidateGitSha ||
    p.baselineGitSha !== prepared.baselineGitSha ||
    p.candidateBundleSha256 !== prepared.candidate.sha256 ||
    p.baselineBundleSha256 !== prepared.baseline.sha256 ||
    p.playwrightVersion !== prepared.playwrightVersion
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
      '- wrong identity: ' + (wrongIdentity.join(', ') || 'none') + '\n')
  }
  console.error(JSON.stringify(summary, null, 2))
  process.exit(1)
}

if (missing.length || duplicate.length || wrongIdentity.length || docs.length !== EXPECTED) incomplete()

const runners = expectedReplicates.map((r) => byReplicate.get(r).value)
const conditionIds = Object.keys(runners[0].conditions || {})
if (!conditionIds.length) throw new Error('runner artifact has no conditions')
for (const d of runners) {
  if (JSON.stringify(Object.keys(d.conditions || {})) !== JSON.stringify(conditionIds)) {
    throw new Error('condition identity/order mismatch on runner ' + d.replicate)
  }
}

const conditions = {}
for (const id of conditionIds) {
  const cells = runners.map((d) => d.conditions[id])
  const timingPoints = cells.map((c) => c.timing.logPoint)
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
    timing: aggregateLogPoints(timingPoints),
    memory: {
      candidateMinusBaselineRetentionKb: aggregateLinear(retentionDiff),
      candidateMinusBaselineSweepKb: aggregateLinear(sweepDiff),
      candidateMinusBaselineTotalKb: aggregateLinear(totalDiff),
      baselineWarmupDeltaKb: aggregateLinear(baselineWarmup),
      candidateWarmupDeltaKb: aggregateLinear(candidateWarmup),
    },
    runnerPoints: runners.map((d, i) => ({
      replicate: d.replicate,
      timingPct: (Math.exp(timingPoints[i]) - 1) * 100,
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

const summary = {
  schema: 'snapdom-r10-asblob-summary-v1',
  state: 'EXPERIMENT_COMPLETE',
  complete: true,
  performanceClaim: false,
  generatedAt: new Date().toISOString(),
  expectedRunners: EXPECTED,
  observedRunners: runners.length,
  candidateGitSha: prepared.candidateGitSha,
  baselineGitSha: prepared.baselineGitSha,
  candidateBundleSha256: prepared.candidate.sha256,
  baselineBundleSha256: prepared.baseline.sha256,
  mechanism: prepared.mechanism,
  fixtures: runners[0].fixtures,
  conditions,
  interpretation: 'Runner-level paired mechanism experiment only. Negative timing means candidate faster. Primary memory is candidate-minus-baseline post-warmup retention increment measured from pre-capture process-tree VmRSS; sweep and total deltas are secondary. No promotion threshold was preregistered.',
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = []
  for (const [id, c] of Object.entries(conditions)) {
    const t = c.timing
    const retention = c.memory.candidateMinusBaselineRetentionKb
    const sweep = c.memory.candidateMinusBaselineSweepKb
    rows.push(
      '| ' + id + ' | ' + c.role + ' | ' +
      (t.available ? t.pct.toFixed(2) + '%' : 'n/a') + ' | ' +
      (t.available ? '[' + t.ci95.map((x) => x.toFixed(2)).join(', ') + ']%' : 'n/a') + ' | ' +
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
    '| condition | role | candidate/base timing | 95% runner CI | retention RSS delta | 95% runner CI | post-warm sweep delta |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...rows,
    '',
    'Negative timing is faster. Positive retention RSS delta means the candidate added more settled Chromium process-tree RSS during warmup than baseline.',
    '',
  ].join('\n'))
}

console.log(JSON.stringify(summary, null, 2))
