#!/usr/bin/env node
// F4 provenance gate plus the PREREGISTERED decision rule. This file is the only place a verdict
// is formed, and it reads the policy rather than restating it, so a threshold edit is a policy
// edit and shows up in the pinned policy hash.
//
// The rule, from F4_POLICY.json:
//   REJECT_PARTITION   no shadow fixture's 95% CI upper bound reaches gates.minEffectPct, OR the
//                     instrument is noisy on any fixture, OR the no-op control is not equivalent,
//                     OR any fixture regresses by more than gates.minEffectPct.
//   PROMOTE_TO_DESIGN  every splitting-free shadow fixture clears gates.minEffectPct with a clean
//                     instrument, the no-op control is equivalent, and nothing regresses. This
//                     authorizes building the sound partition. It is not a promotion.
//   INCOMPLETE         anything missing, blocked or unparseable. Zero evidence never reads as a
//                     promising partition.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const LANE = path.resolve(ROOT, 'lane6-scratch/r10-shadow')
const PREP = path.join(LANE, 'prepared.json')
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()

const finish = (doc, code = 0) => {
  const dir = path.join(LANE, 'decisions')
  fs.mkdirSync(dir, { recursive: true })
  const name = doc.file || `f4-${doc.browser}-r${doc.replicate}.json`
  const out = path.join(dir, name)
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
  console.log(JSON.stringify({ ...doc, written: path.relative(ROOT, out).replaceAll('\\', '/') }, null, 2))
  process.exit(code)
}

if (!fs.existsSync(PREP)) throw new Error('prepared.json missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
const gates = policy.gates
const browser = String(arg('browser')).toLowerCase()
const replicate = Number(arg('replicate'))
const gateExit = Number(arg('gate-exit', '1'))
const reportPath = path.resolve(LANE, 'results', `f4-${browser}-r${replicate}.json`)
const baseDoc = {
  schema: 'snapdom-r10-f4-wall-decision-v1',
  browser,
  replicate,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
  github: {
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
  },
}

if (gateExit === 3) finish({ ...baseDoc, state: 'INCOMPLETE_EVIDENCE', usable: false, reason: 'AMBIENT_BLOCKED' }, 2)
if (gateExit !== 0) finish({ ...baseDoc, state: 'HARNESS_FAILED', usable: false, reason: `bench exit ${gateExit}` }, 1)
if (!fs.existsSync(reportPath)) finish({ ...baseDoc, state: 'INCOMPLETE_EVIDENCE', usable: false, reason: 'MISSING_REPORT' }, 2)

let report
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) }
catch (e) { finish({ ...baseDoc, state: 'PROVENANCE_FAILURE', usable: false, reason: `report parse: ${e.message}` }, 1) }

const ENGINE_OFFSET = { chromium: 0, firefox: 1000003, webkit: 2000003 }
const hard = []
const p = report.provenance || {}
if (report.schema !== 'snapdom-r10-f4-wall-v1') hard.push('report schema')
if (p.github?.actions !== true || p.github?.repository !== policy.repository) {
  hard.push('GitHub Actions repository provenance')
}
if (!p.github?.runId || p.github.runId !== process.env.GITHUB_RUN_ID) hard.push('run id provenance')
if (!p.github?.job || p.github.job !== process.env.GITHUB_JOB) hard.push('job provenance')
if (!p.runner?.name || !p.runner?.imageOs || !p.runner?.imageVersion || p.runner?.os !== 'Linux') {
  hard.push('hosted runner provenance')
}
if (p.browser?.requested !== browser || p.browser?.actualName !== browser || !p.browser?.actualVersion) {
  hard.push('browser identity')
}
if (p.browser?.playwrightVersion !== policy.playwrightVersion) hard.push('Playwright version')
for (const [rel, field] of [
  ['lane6-scratch/r10-shadow/bench-f4.mjs', 'harness'],
  ['lane6-scratch/r9/protocol.mjs', 'protocol'],
  ['__tests__/helpers/shadowCards.js', 'fixtureSource'],
  ['lane6-scratch/r10-shadow/F4_POLICY.json', 'policy'],
]) {
  const value = p.code?.[field]
  if (!value || value.sha256 !== prepared.measurementFiles[rel]) hard.push(`measurement hash ${rel}`)
}
if (p.bundle?.sha256 !== prepared.bundle.sha256) hard.push('bundle identity')
const rp = p.protocol || {}
for (const [key, expected] of Object.entries({
  mode: 'option-pair',
  n: policy.sampling.n,
  batch: policy.sampling.batch,
  warmup: policy.sampling.warmup,
  bootstrap: policy.sampling.bootstrap,
  replicate,
  engineOffset: ENGINE_OFFSET[browser],
})) {
  if (rp[key] !== expected) hard.push(`protocol field ${key}`)
}
const expectedSeed = (policy.sampling.baseSeed + ENGINE_OFFSET[browser] + replicate * 104729) >>> 0
if (rp.seed !== expectedSeed) hard.push('seed')
if (JSON.stringify(rp.fixtureNames) !== JSON.stringify(policy.fixtures)) hard.push('fixture manifest/order')
if (JSON.stringify(Object.keys(report.fixtures || {})) !== JSON.stringify(policy.fixtures)) {
  hard.push('fixture result identity/order')
}

const invalid = []
for (const name of policy.fixtures) {
  const fx = report.fixtures[name]
  const blocks = fx?.effect?.logRatios?.blocks
  if (!Array.isArray(blocks) || blocks.length !== policy.sampling.n || blocks.some((x) => !Number.isFinite(x))) {
    invalid.push(`${name}: invalid effect blocks`)
  }
  for (const layout of ['effectForward', 'effectReverse', 'baseNullForward', 'baseNullReverse',
    'optNullForward', 'optNullReverse']) {
    const rows = report.layouts?.[layout]?.[name]?.rows
    if (!Array.isArray(rows) || rows.length !== policy.sampling.n ||
        rows.some((r) => !(r.slot1 > 0) || !(r.slot2 > 0))) {
      invalid.push(`${name}: invalid ${layout} rows`)
    }
  }
}
if (hard.length) finish({ ...baseDoc, state: 'PROVENANCE_FAILURE', usable: false, reasons: hard }, 1)
if (invalid.length) finish({ ...baseDoc, state: 'INVALID_SAMPLE', usable: false, reasons: invalid }, 1)

const fixtures = {}
const reasons = []
for (const name of policy.fixtures) {
  const fx = report.fixtures[name]
  fixtures[name] = {
    noop: fx.meta.noop,
    splitting: fx.meta.splitting,
    effectPct: fx.effect.pct,
    ci95: fx.effect.ci95,
    baseNull: { pct: fx.baseNull.pct, ci95: fx.baseNull.ci95 },
    optNull: { pct: fx.optNull.pct, ci95: fx.optNull.ci95 },
    spikeByteSafe: fx.spikeByteSafe,
    controlsPass: fx.controlsPass,
    stabilityPass: fx.stabilityPass,
    maxPairLogSd: fx.maxPairLogSd,
    rawMaxCov: fx.rawMaxCov,
  }
  if (!fx.controlsPass) reasons.push(`${name}: A/A control outside the control band`)
  if (!fx.stabilityPass) reasons.push(`${name}: instrument noise above the preregistered pair SD`)
  if (fx.meta.noop && !fx.noOpEquivalent) reasons.push(`${name}: no-op control not equivalent`)
  if (fx.regresses) reasons.push(`${name}: regression beyond the preregistered tolerance`)
}

const judged = policy.fixtures.filter((name) => !policy.noopFixtures.includes(name))
// A splitting fixture's two arms are EXPECTED to diverge in bytes, so its bytes say nothing
// about whether the win is real. Only splitting-free fixtures can carry the promotion case.
const promotable = judged.filter((name) => !policy.splittingFixtures.includes(name))
const anyReaches = judged.some((name) => report.fixtures[name].reachesMinEffect)
const allClear = promotable.length > 0 && promotable.every((name) => report.fixtures[name].clearsMinEffect)
const noisy = reasons.some((r) => r.includes('control band') || r.includes('noise'))
const regressed = reasons.some((r) => r.includes('regression'))
const verdict = (!anyReaches || noisy || regressed || !allClear) ? 'REJECT_PARTITION' : 'PROMOTE_TO_DESIGN'

finish({
  ...baseDoc,
  state: 'F4_SAMPLE',
  usable: true,
  reportSha256: shaFile(reportPath),
  runner: p.runner,
  browserVersion: p.browser.actualVersion,
  fixtures,
  sampleVerdict: verdict,
  reasons,
  preregistered: {
    minEffectPct: gates.minEffectPct,
    controlBand: gates.controlBand,
    equivalenceBand: gates.equivalenceBand,
    maxPairLogSd: gates.maxPairLogSd,
  },
  rule: policy.decision,
}, 0)