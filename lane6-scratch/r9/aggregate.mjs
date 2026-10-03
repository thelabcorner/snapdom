#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { arg, ciWithin, pctFromLog, stats } from './protocol.mjs'

const ROOT = process.cwd()
const PLAN_PATH = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const PHASE = arg('phase', 'confirm')
const INPUT_DIR = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r9/aggregate-input'))
const OUT_PATH = path.resolve(ROOT, arg('out', 'lane6-scratch/r9/decisions/aggregate-confirm.json'))

function fail(message) {
  console.error(`R9 aggregate infrastructure failure: ${message}`)
  process.exit(1)
}
function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
}
function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.json')) out.push(p)
  }
  return out
}
function tCritical95(df) {
  const table = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
    8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
    15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  }
  return table[Math.min(20, Math.max(1, df))] ?? 1.96
}
function runnerCi(logPoints) {
  const s = stats(logPoints)
  if (logPoints.length < 2) return { logPoint: s.mean, pct: pctFromLog(s.mean), ci95: [-Infinity, Infinity] }
  const half = tCritical95(logPoints.length - 1) * s.sd / Math.sqrt(logPoints.length)
  return {
    logPoint: s.mean,
    pct: pctFromLog(s.mean),
    ci95: [pctFromLog(s.mean - half), pctFromLog(s.mean + half)],
    runnerSdLog: s.sd,
  }
}

if (!fs.existsSync(PLAN_PATH)) fail('resolved plan missing')
if (!['confirm', 'engineGuard'].includes(PHASE)) fail('aggregate supports confirm or engineGuard')
const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
const candidate = plan.candidate
const phase = candidate.phases[PHASE]
if (!phase) fail(`phase ${PHASE} is not registered`)

const docs = []
for (const file of walk(INPUT_DIR)) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value?.schema === 'snapdom-r9-run-decision-v1' && value.phase === PHASE) docs.push({ file, value })
  } catch {}
}
const expected = phase.replicates * phase.browsers.length
if (docs.length !== expected) {
  fail(`expected ${expected} per-run decisions for ${PHASE}, found ${docs.length}`)
}

const keys = new Set()
for (const { value } of docs) {
  if (value.candidateId !== candidate.id) fail('candidate id mismatch across decisions')
  if (value.manifestSha256 !== plan.candidateManifestSha256) fail('manifest hash mismatch across decisions')
  const key = `${value.browser}:${value.replicate}`
  if (keys.has(key)) fail(`duplicate decision ${key}`)
  keys.add(key)
}

const expectedKeys = []
for (const browser of phase.browsers) {
  for (let r = 0; r < phase.replicates; r++) expectedKeys.push(`${browser}:${r}`)
}
for (const key of expectedKeys) if (!keys.has(key)) fail(`missing decision ${key}`)

const hardFailures = docs.filter(({ value }) => value.hardFailure)
if (hardFailures.length) fail(`${hardFailures.length} replicate decisions contain hard infrastructure/provenance failures`)

const expectedFixtures = [...candidate.primaryFixtures, ...candidate.guardFixtures]
const byBrowser = {}
for (const browser of phase.browsers) {
  const reps = docs.filter(({ value }) => value.browser === browser)
    .sort((a, b) => a.value.replicate - b.value.replicate)
  const fixtures = {}
  for (const name of expectedFixtures) {
    const points = reps.map(({ value }) => value.fixtures?.[name]?.logPoint)
    if (points.some((x) => !Number.isFinite(x))) fail(`missing logPoint for ${browser}/${name}`)
    const aggregate = reps.length === 1
      ? {
          logPoint: points[0],
          pct: reps[0].value.fixtures[name].pct,
          ci95: reps[0].value.fixtures[name].ci95,
          runnerSdLog: null,
        }
      : runnerCi(points)
    fixtures[name] = {
      ...aggregate,
      replicatePointsPct: reps.map(({ value }) => value.fixtures[name].pct),
      replicateCi95: reps.map(({ value }) => value.fixtures[name].ci95),
      allIndividualEligible: reps.every(({ value }) => value.eligible),
      anyIndividualRegression: reps.some(({ value }) => value.fixtures[name].candidateRegression),
      allIndividualEquivalent: reps.every(({ value }) => value.fixtures[name].candidateEquivalent),
    }
  }
  byBrowser[browser] = {
    replicates: reps.map(({ value }) => ({
      replicate: value.replicate,
      state: value.state,
      eligible: value.eligible,
      reportSha256: value.reportSha256,
      provenance: value.provenance,
    })),
    fixtures,
  }
}

const reasons = []
const expectation = phase.expect || candidate.expect
for (const browser of phase.browsers) {
  const group = byBrowser[browser]
  if (!group.replicates.every((r) => r.eligible)) reasons.push(`${browser}: one or more runner-level decisions did not clear gates`)
  for (const name of expectedFixtures) {
    const fx = group.fixtures[name]
    if (expectation === 'equivalence') {
      if (!ciWithin(fx.ci95, phase.equivalenceBand)) {
        reasons.push(`${browser}/${name}: runner-level CI is outside ±${(phase.equivalenceBand * 100).toFixed(1)}% equivalence band`)
      }
      if (!fx.allIndividualEquivalent) reasons.push(`${browser}/${name}: at least one fresh runner failed equivalence`)
    } else if (expectation === 'improvement') {
      if (candidate.primaryFixtures.includes(name) && !(fx.ci95[1] < -(phase.epsilon * 100))) {
        reasons.push(`${browser}/${name}: aggregate CI does not clear improvement epsilon`)
      }
      if (candidate.guardFixtures.includes(name) && (fx.ci95[0] > phase.epsilon * 100 || fx.anyIndividualRegression)) {
        reasons.push(`${browser}/${name}: guard regression`)
      }
    } else if (expectation === 'explore') {
      if (candidate.guardFixtures.includes(name) && (fx.ci95[0] > phase.epsilon * 100 || fx.anyIndividualRegression)) {
        reasons.push(`${browser}/${name}: exploratory guard regression`)
      }
    }
  }
}

const eligible = reasons.length === 0
const decision = {
  schema: 'snapdom-r9-aggregate-decision-v1',
  candidateId: candidate.id,
  manifestSha256: plan.candidateManifestSha256,
  phase: PHASE,
  expectation,
  state: eligible ? 'GATES_CLEARED' : 'NO_CLAIM',
  eligible,
  reasons,
  policy: {
    freshRunnerReplicates: phase.replicates,
    browsers: phase.browsers,
    epsilon: phase.epsilon,
    equivalenceBand: phase.equivalenceBand,
    method: 'Student-t 95% CI across fresh-runner log-effect point estimates; raw samples remain runner-local',
  },
  browsers: byBrowser,
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
fs.writeFileSync(OUT_PATH, JSON.stringify(decision, null, 2) + '\n')
writeOutput('eligible', eligible ? 'true' : 'false')
writeOutput('state', decision.state)
writeOutput('decision_path', path.relative(ROOT, OUT_PATH).replaceAll('\\', '/'))

const rows = []
for (const [browser, group] of Object.entries(byBrowser)) {
  for (const [name, fx] of Object.entries(group.fixtures)) {
    rows.push(`| ${browser} | ${name} | ${fx.pct.toFixed(2)}% | [${fx.ci95.map((v) => Number.isFinite(v) ? v.toFixed(2) : String(v)).join(', ')}]% |`)
  }
}
appendSummary([
  `### R9 aggregate · ${candidate.id} · ${PHASE}`,
  '',
  `**${decision.state}** — eligible: **${eligible ? 'yes' : 'no'}**`,
  '',
  '| browser | fixture | runner-mean effect | 95% runner-level CI |',
  '|---|---|---:|---:|',
  ...rows,
  '',
  ...reasons.map((x) => `- ${x}`),
  '',
].join('\n'))

console.log(JSON.stringify(decision, null, 2))
