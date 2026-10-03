#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { arg, sha256File } from './protocol.mjs'

const ROOT = process.cwd()
const PLAN_PATH = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const PHASE = arg('phase')
const REPLICATE = Number(arg('replicate', '0'))
const BROWSER = arg('browser', '')
const GATE_EXIT = Number(arg('gate-exit', '0'))
const REPORT_ARG = arg('report', '')
const OUT_ARG = arg('out', '')

function fail(message) {
  console.error(`R9 decision infrastructure failure: ${message}`)
  process.exit(1)
}
function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
}
function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
if (!['scout', 'confirm', 'engineGuard'].includes(PHASE)) fail('invalid --phase')
if (!Number.isInteger(REPLICATE) || REPLICATE < 0) fail('invalid --replicate')
if (!fs.existsSync(PLAN_PATH)) fail('resolved plan missing')

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
const candidate = plan.candidate
const phase = candidate.phases[PHASE]
if (!phase) fail(`phase ${PHASE} absent from manifest`)
const browser = BROWSER || phase.browsers[0]
if (!phase.browsers.includes(browser)) fail(`browser ${browser} is not valid for phase ${PHASE}`)

const outDir = path.resolve(ROOT, 'lane6-scratch/r9/decisions')
fs.mkdirSync(outDir, { recursive: true })
const outPath = OUT_ARG
  ? path.resolve(ROOT, OUT_ARG)
  : path.join(outDir, `${candidate.id}-${PHASE}-${browser}-r${REPLICATE}.json`)

function finish(decision, infrastructureFailure = false) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(decision, null, 2) + '\n')
  writeOutput('eligible', decision.eligible ? 'true' : 'false')
  writeOutput('state', decision.state)
  writeOutput('decision_path', path.relative(ROOT, outPath).replaceAll('\\', '/'))
  appendSummary([
    `### R9 ${candidate.id} · ${PHASE} · ${browser} · r${REPLICATE}`,
    '',
    `- state: **${decision.state}**`,
    `- eligible for next stage: **${decision.eligible ? 'yes' : 'no'}**`,
    `- manifest: \`${plan.candidateManifestSha256.slice(0, 12)}\``,
    ...(decision.reasons || []).map((x) => `- ${x}`),
    '',
  ].join('\n'))
  console.log(JSON.stringify(decision, null, 2))
  if (infrastructureFailure) process.exit(1)
}

if (GATE_EXIT === 3) {
  finish({
    schema: 'snapdom-r9-run-decision-v1',
    candidateId: candidate.id,
    manifestSha256: plan.candidateManifestSha256,
    phase: PHASE,
    replicate: REPLICATE,
    browser,
    state: 'AMBIENT_BLOCKED',
    eligible: false,
    hardFailure: false,
    reasons: ['ambient CPU gate blocked before browser timing; no performance claim was consumed'],
    fixtures: {},
  })
  process.exit(0)
}
if (GATE_EXIT !== 0) {
  finish({
    schema: 'snapdom-r9-run-decision-v1',
    candidateId: candidate.id,
    manifestSha256: plan.candidateManifestSha256,
    phase: PHASE,
    replicate: REPLICATE,
    browser,
    state: 'HARNESS_FAILED',
    eligible: false,
    hardFailure: true,
    reasons: [`benchmark process exited ${GATE_EXIT}`],
    fixtures: {},
  }, true)
}

const expectedReport = path.resolve(
  ROOT,
  REPORT_ARG || `lane6-scratch/r9/results/${candidate.id}-${PHASE}-${browser}-r${REPLICATE}.json`,
)
const buildProvenancePath = path.resolve(ROOT, 'lane6-scratch/r9/bundles/build-provenance.json')
if (!fs.existsSync(expectedReport)) {
  finish({
    schema: 'snapdom-r9-run-decision-v1',
    candidateId: candidate.id,
    manifestSha256: plan.candidateManifestSha256,
    phase: PHASE,
    replicate: REPLICATE,
    browser,
    state: 'MISSING_EVIDENCE',
    eligible: false,
    hardFailure: true,
    reasons: [`expected report absent: ${path.relative(ROOT, expectedReport)}`],
    fixtures: {},
  }, true)
}

let report
try { report = JSON.parse(fs.readFileSync(expectedReport, 'utf8')) }
catch (error) { fail(`cannot parse report: ${error.message}`) }
if (!fs.existsSync(buildProvenancePath)) fail('build-provenance.json missing from bundle artifact')
let build
try { build = JSON.parse(fs.readFileSync(buildProvenancePath, 'utf8')) }
catch (error) { fail(`cannot parse build provenance: ${error.message}`) }

const hard = []
const scientific = []
if (report.schema !== 'snapdom-r9-hosted-bench-v1') hard.push('report schema mismatch')
if (report.provenance?.github?.actions !== true) hard.push('report was not produced under GitHub Actions')
if (report.provenance?.browser?.requested !== browser) hard.push('requested browser provenance mismatch')
if (report.provenance?.browser?.actualName !== browser) hard.push('actual launched browser provenance mismatch')
if (!report.provenance?.browser?.actualVersion) hard.push('actual browser version missing')
if (report.provenance?.browser?.playwrightVersion !== candidate.playwrightVersion) hard.push('Playwright version mismatch')
if (report.provenance?.code?.manifestSha256 !== plan.candidateManifestSha256) hard.push('candidate manifest hash mismatch')
if (build.schema !== 'snapdom-r9-build-provenance-v1') hard.push('build provenance schema mismatch')
if (build.candidateId !== candidate.id || build.manifestSha256 !== plan.candidateManifestSha256) {
  hard.push('build provenance candidate/manifest identity mismatch')
}
if (report.provenance?.bundles?.candidate?.sha256 !== build.candidate?.bundleSha256) {
  hard.push('candidate bundle digest does not match prepare-stage build provenance')
}
if (report.provenance?.bundles?.baseline?.sha256 !== build.baseline?.bundleSha256) {
  hard.push('baseline bundle digest does not match prepare-stage build provenance')
}
if (report.provenance?.git?.candidateSha !== (process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null)) {
  hard.push('candidate git SHA mismatch')
}
if (build.candidate?.gitSha !== (process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null)) {
  hard.push('prepare-stage candidate git SHA mismatch')
}
if (candidate.mode === 'bundle-diff') {
  if (report.provenance?.git?.baselineSha !== candidate.baselineRef) hard.push('baseline git SHA mismatch')
  if (build.baseline?.gitSha !== candidate.baselineRef) hard.push('prepare-stage baseline git SHA mismatch')
  if (report.provenance?.bundles?.baseline?.sha256 === report.provenance?.bundles?.candidate?.sha256) {
    hard.push('bundle-diff unexpectedly produced identical bundle digests')
  }
} else if (report.provenance?.bundles?.baseline?.sha256 !== report.provenance?.bundles?.candidate?.sha256) {
  hard.push('option-pair must measure the same bundle digest in both arms')
}

const expectedFixtures = [...candidate.primaryFixtures, ...candidate.guardFixtures]
const observedFixtures = Object.keys(report.fixtures || {})
if (expectedFixtures.length !== observedFixtures.length ||
    expectedFixtures.some((x) => !observedFixtures.includes(x))) {
  hard.push(`fixture identity mismatch expected=[${expectedFixtures.join(',')}] observed=[${observedFixtures.join(',')}]`)
}

const knownNoOps = new Set(candidate.knownNoOpFixtures)
const fixtureDecision = {}
for (const name of expectedFixtures) {
  const fx = report.fixtures?.[name]
  if (!fx) continue
  const reasons = []
  if (!fx.parity) reasons.push('raw parity failed')
  if (!fx.controlsPass) reasons.push('AA/BB equivalence controls failed')
  if (!fx.stabilityPass) reasons.push(`paired log-ratio SD exceeded ${phase.maxPairLogSd.toFixed(3)}`)
  if (knownNoOps.has(name) && !fx.candidateEquivalent) reasons.push('pre-registered no-op effect is not equivalent')
  fixtureDecision[name] = {
    primary: candidate.primaryFixtures.includes(name),
    guard: candidate.guardFixtures.includes(name),
    knownNoOp: knownNoOps.has(name),
    pct: fx.candidate?.pct,
    ci95: fx.candidate?.ci95,
    logPoint: fx.candidate?.logPoint,
    parity: fx.parity,
    controlsPass: fx.controlsPass,
    stabilityPass: fx.stabilityPass,
    candidateWin: fx.candidateWin,
    candidateRegression: fx.candidateRegression,
    candidateEquivalent: fx.candidateEquivalent,
    rawMaxCov: fx.rawMaxCov,
    maxPairLogSd: fx.maxPairLogSd,
    reasons,
  }
  scientific.push(...reasons.map((r) => `${name}: ${r}`))
}

const expectation = phase.expect || candidate.expect
if (expectation === 'equivalence') {
  for (const name of expectedFixtures) {
    if (!fixtureDecision[name]?.candidateEquivalent) scientific.push(`${name}: candidate effect failed equivalence band`)
  }
} else if (expectation === 'improvement') {
  for (const name of candidate.primaryFixtures) {
    if (!fixtureDecision[name]?.candidateWin) scientific.push(`${name}: primary CI does not clear improvement epsilon`)
  }
  for (const name of candidate.guardFixtures) {
    if (fixtureDecision[name]?.candidateRegression) scientific.push(`${name}: guard fixture has a significant regression`)
  }
} else if (expectation === 'explore') {
  for (const name of candidate.guardFixtures) {
    if (fixtureDecision[name]?.candidateRegression) scientific.push(`${name}: exploratory guard fixture regressed`)
  }
}

if (hard.length) {
  finish({
    schema: 'snapdom-r9-run-decision-v1',
    candidateId: candidate.id,
    manifestSha256: plan.candidateManifestSha256,
    phase: PHASE,
    replicate: REPLICATE,
    browser,
    state: 'PROVENANCE_FAILURE',
    eligible: false,
    hardFailure: true,
    reasons: hard,
    fixtures: fixtureDecision,
    provenance: report.provenance,
  }, true)
}

const eligible = scientific.length === 0
finish({
  schema: 'snapdom-r9-run-decision-v1',
  candidateId: candidate.id,
  manifestSha256: plan.candidateManifestSha256,
  phase: PHASE,
  replicate: REPLICATE,
  browser,
  expectation,
  state: eligible ? 'GATES_CLEARED' : 'NO_CLAIM',
  eligible,
  hardFailure: false,
  reasons: scientific,
  fixtures: fixtureDecision,
  provenance: report.provenance,
  reportSha256: sha256File(expectedReport),
  reportPath: path.relative(ROOT, expectedReport).replaceAll('\\', '/'),
})
