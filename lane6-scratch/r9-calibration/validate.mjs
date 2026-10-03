#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const CAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration')
const PREP = path.join(CAL, 'prepared.json')
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()
const mean = (xs) => xs.reduce((a,b) => a+b, 0) / xs.length
const sd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a,b) => a + (b-m)**2, 0) / (xs.length - 1))
}
const rawSlotBias = (layout) => {
  const xs = layout.rows.map((r) => Math.log(r.slot2 / r.slot1))
  return mean(xs)
}
const finish = (doc, code = 0) => {
  const dir = path.join(CAL, 'decisions')
  fs.mkdirSync(dir, {recursive:true})
  const out = path.join(dir, `calibration-${doc.browser}-r${doc.replicate}.json`)
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
  console.log(JSON.stringify(doc, null, 2))
  process.exit(code)
}

if (!fs.existsSync(PREP)) throw new Error('prepared.json missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
const browser = String(arg('browser')).toLowerCase()
const replicate = Number(arg('replicate'))
const gateExit = Number(arg('gate-exit', '1'))
const reportPath = path.resolve(ROOT, 'lane6-scratch/r9/results', `calibration-${browser}-r${replicate}.json`)
const baseDoc = {
  schema: 'snapdom-r9-hosted-calibration-decision-v1',
  browser, replicate,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
  github: {
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
  },
}

if (gateExit === 3) finish({...baseDoc, state:'INCOMPLETE_EVIDENCE', usable:false, reason:'AMBIENT_BLOCKED'}, 2)
if (gateExit !== 0) finish({...baseDoc, state:'HARNESS_FAILED', usable:false, reason:`benchmark exit ${gateExit}`}, 1)
if (!fs.existsSync(reportPath)) finish({...baseDoc, state:'INCOMPLETE_EVIDENCE', usable:false, reason:'MISSING_REPORT'}, 2)

let report
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) }
catch (e) { finish({...baseDoc,state:'PROVENANCE_FAILURE',usable:false,reason:`report parse: ${e.message}`},1) }

const hard = []
const p = report.provenance || {}
if (report.schema !== 'snapdom-r9-hosted-bench-v1') hard.push('report schema')
if (p.github?.actions !== true || p.github?.repository !== policy.repository) hard.push('GitHub Actions repository provenance')
if (!p.github?.runId || p.github.runId !== process.env.GITHUB_RUN_ID) hard.push('run id provenance')
if (!p.github?.job || p.github.job !== process.env.GITHUB_JOB) hard.push('job provenance')
if (!p.runner?.name || !p.runner?.imageOs || !p.runner?.imageVersion || p.runner?.os !== 'Linux') hard.push('hosted runner provenance')
if (p.browser?.requested !== browser || p.browser?.actualName !== browser || !p.browser?.actualVersion) hard.push('browser identity')
if (p.browser?.playwrightVersion !== policy.playwrightVersion) hard.push('Playwright version')
if (p.code?.manifestSha256 !== prepared.policySha256) hard.push('policy identity')
for (const key of ['lane6-scratch/r9/bench-r9-controlled.mjs','lane6-scratch/r9/protocol.mjs','lane6-scratch/atlas/profiler/fixtures.mjs']) {
  const field = key.includes('bench-r9') ? p.code?.harness : key.includes('protocol') ? p.code?.protocol : p.code?.fixtureSource
  if (!field || field.sha256 !== prepared.measurementFiles[key]) hard.push(`measurement hash ${key}`)
}
if (p.git?.candidateSha !== prepared.candidateGitSha || p.git?.baselineSha !== prepared.candidateGitSha) hard.push('git SHA identity')
if (p.bundles?.candidate?.sha256 !== prepared.bundle.sha256 || p.bundles?.baseline?.sha256 !== prepared.bundle.sha256) hard.push('bundle identity')
const rp = p.protocol || {}
for (const [key, expected] of Object.entries({
  mode:'option-pair', suite:policy.suite, n:policy.sampling.n, batch:policy.sampling.batch,
  warmup:policy.sampling.warmup, bootstrap:policy.sampling.bootstrap,
})) {
  if (rp[key] !== expected) hard.push(`protocol field ${key}`)
}
const expectedSeed = (policy.sampling.baseSeed + {chromium:0,firefox:1000003,webkit:2000003}[browser] + replicate*104729) >>> 0
if (rp.seed !== expectedSeed) hard.push('seed')
if (JSON.stringify(rp.fixtureNames) !== JSON.stringify(policy.fixtures)) hard.push('fixture manifest/order')

const observed = Object.keys(report.fixtures || {})
if (JSON.stringify(observed) !== JSON.stringify(policy.fixtures)) hard.push('fixture result identity/order')
if (hard.length) finish({...baseDoc,state:'PROVENANCE_FAILURE',usable:false,reasons:hard},1)

const fixtures = {}
const invalid = []
for (const name of policy.fixtures) {
  const fx = report.fixtures[name]
  if (!fx?.parity) invalid.push(`${name}: raw parity failed`)
  const blocks = fx?.candidate?.logRatios?.blocks
  if (!Array.isArray(blocks) || blocks.length !== policy.sampling.n || blocks.some((x) => !Number.isFinite(x))) {
    invalid.push(`${name}: invalid candidate observation blocks`)
    continue
  }
  for (const layoutName of ['effectForward','effectReverse','baseNullForward','baseNullReverse','optNullForward','optNullReverse']) {
    const rows = report.layouts?.[layoutName]?.[name]?.rows
    if (!Array.isArray(rows) || rows.length !== policy.sampling.n ||
        rows.some((r) => !(r.slot1 > 0) || !(r.slot2 > 0))) {
      invalid.push(`${name}: invalid ${layoutName} rows`)
    }
  }
  const b1 = rawSlotBias(report.layouts.baseNullForward[name])
  const b2 = rawSlotBias(report.layouts.baseNullReverse[name])
  const o1 = rawSlotBias(report.layouts.optNullForward[name])
  const o2 = rawSlotBias(report.layouts.optNullReverse[name])
  const baseSlotBias = (b1+b2)/2
  const optSlotBias = (o1+o2)/2
  fixtures[name] = {
    candidate: {logPoint: fx.candidate.logPoint, pct: fx.candidate.pct, ci95: fx.candidate.ci95},
    baseNull: {logPoint: fx.baseNull.logPoint, pct: fx.baseNull.pct, ci95: fx.baseNull.ci95},
    optNull: {logPoint: fx.optNull.logPoint, pct: fx.optNull.pct, ci95: fx.optNull.ci95},
    withinBlockSd: sd(blocks),
    withinSe: sd(blocks) / Math.sqrt(blocks.length),
    maxPairLogSd: fx.maxPairLogSd,
    rawMaxCov: fx.rawMaxCov,
    baseSlotBias,
    optSlotBias,
    slotInteraction: optSlotBias - baseSlotBias,
  }
}
if (invalid.length) finish({...baseDoc,state:'CALIBRATION_INVALID',usable:false,reasons:invalid},1)

finish({
  ...baseDoc,
  state:'CALIBRATION_SAMPLE',
  usable:true,
  reportSha256:shaFile(reportPath),
  runner:p.runner,
  browserVersion:p.browser.actualVersion,
  fixtures,
},0)
