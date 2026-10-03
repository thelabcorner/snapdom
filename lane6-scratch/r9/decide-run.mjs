#!/usr/bin/env node
/**
 * Adjudicates exactly one fresh-runner cell.
 *
 * A run decision establishes evidence validity only. It can never carry a promotion verdict:
 * `promotableEver` is structurally false on every run decision, and the aggregate refuses any
 * input where that invariant is violated.
 *
 * Terminal outcomes:
 *   PROVENANCE_FAILURE    an identity did not verify                       -> red
 *   INCOMPLETE_EVIDENCE   required evidence missing or unusable            -> red
 *   EVIDENCE_VALID        the cell is admissible as runner-level input      -> green
 */

import fs from 'node:fs'
import path from 'node:path'
import { arg, sha256File } from './protocol.mjs'
import {
  GovernorRefusal,
  PLAN_SCHEMA,
  assertHostedEnvironment,
  judgeRunEvidence,
  readJson,
  scoutVerdict,
} from './governor.mjs'

const ROOT = process.cwd()
const PLAN_PATH = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const PHASE = arg('phase')
const REPLICATE = Number(arg('replicate', '0'))
const BROWSER = arg('browser', '')
const GATE_EXIT = Number(arg('gate-exit', '0'))
const REPORT_ARG = arg('report', '')
const OUT_ARG = arg('out', '')

function fail(message, detail) {
  console.error(`R9 decision infrastructure failure: ${message}`)
  if (detail && Object.keys(detail).length) console.error(JSON.stringify(detail, null, 2))
  process.exit(1)
}
function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
}
function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

try {
  assertHostedEnvironment()
} catch (error) {
  fail(error instanceof GovernorRefusal ? error.message : String(error))
}

if (!['scout', 'confirm', 'engineGuard'].includes(PHASE)) fail('invalid --phase')
if (!Number.isInteger(REPLICATE) || REPLICATE < 0) fail('invalid --replicate')
if (!fs.existsSync(PLAN_PATH)) fail('resolved plan missing')

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
if (plan.schema !== PLAN_SCHEMA) fail('resolved-plan schema mismatch')
const candidate = plan.candidate
const phaseSpec = plan.phaseSpec[PHASE]
if (!phaseSpec) fail('phase ' + PHASE + ' absent from policy')
if (!Number.isInteger(phaseSpec.replicates)) {
  fail('phase ' + PHASE + ' has no preregistered replicate count; policy slot phases.' + PHASE + '.replicates is unfrozen')
}

const browser = BROWSER || phaseSpec.browsers[0]
if (!phaseSpec.browsers.includes(browser)) fail('browser ' + browser + ' is not preregistered for phase ' + PHASE)

const outDir = path.resolve(ROOT, 'lane6-scratch/r9/decisions')
fs.mkdirSync(outDir, { recursive: true })
const outPath = OUT_ARG
  ? path.resolve(ROOT, OUT_ARG)
  : path.join(outDir, candidate.id + '-' + PHASE + '-' + browser + '-r' + REPLICATE + '.json')

function base() {
  return {
    schema: 'snapdom-r9-run-decision-v2',
    candidateId: candidate.id,
    manifestSha256: plan.candidateManifestSha256,
    policySha256: plan.policySha256,
    measuredSha: plan.measuredSha,
    measuredRef: plan.measuredRef,
    phase: PHASE,
    replicate: REPLICATE,
    browser,
    expectation: plan.phaseExpectations[PHASE],
    promotable: false,
    promotableEver: false,
  }
}

function finish(decision, exitCode = 0) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(decision, null, 2) + '\n')
  writeOutput('verdict', decision.verdict)
  writeOutput('evidence_usable', decision.evidenceUsable ? 'true' : 'false')
  writeOutput('promotable', 'false')
  if (PHASE === 'scout') writeOutput('scout_killed', scoutVerdict(decision).killed ? 'true' : 'false')
  writeOutput('decision_path', path.relative(ROOT, outPath).replaceAll('\\', '/'))
  appendSummary([
    '### R9 ' + candidate.id + ' · ' + PHASE + ' · ' + browser + ' · r' + REPLICATE,
    '',
    '- verdict: **' + decision.verdict + '**',
    '- runner-level promotion: **never** (inference is aggregate-only)',
    '- manifest: `' + plan.candidateManifestSha256.slice(0, 12) + '`',
    '- policy: `' + plan.policySha256.slice(0, 12) + '`' + (plan.frozen ? '' : ' (unfrozen)'),
    ...(decision.reasons || []).map((x) => '- ' + x),
    '',
  ].join('\n'))
  console.log(JSON.stringify(decision, null, 2))
  process.exit(exitCode)
}

function infrastructureFailure(verdict, reasons, extra = {}) {
  finish({ ...base(), verdict, evidenceUsable: false, reasons, scientific: [], fixtures: {}, ...extra }, 1)
}

// The ambient gate blocks before any browser timing happens. That is zero evidence, and it is
// reported as INCOMPLETE_EVIDENCE — never as a clean pass and never as a claim.
if (GATE_EXIT === 3) {
  infrastructureFailure('INCOMPLETE_EVIDENCE', [
    'ambient CPU gate blocked before browser timing; no performance claim was consumed',
  ])
}
if (GATE_EXIT !== 0) {
  infrastructureFailure('PROVENANCE_FAILURE', ['benchmark or gate process exited ' + GATE_EXIT])
}

const expectedReport = path.resolve(
  ROOT,
  REPORT_ARG || ('lane6-scratch/r9/results/' + candidate.id + '-' + PHASE + '-' + browser + '-r' + REPLICATE + '.json'),
)
const buildProvenancePath = path.resolve(ROOT, 'lane6-scratch/r9/bundles/build-provenance.json')
const gatePath = path.resolve(ROOT, 'lane6-scratch/r5/results/timing-environment-latest.json')
const policyPath = path.resolve(ROOT, 'lane6-scratch/r9/POLICY.json')

if (!fs.existsSync(expectedReport)) {
  infrastructureFailure('INCOMPLETE_EVIDENCE', ['expected report absent: ' + path.relative(ROOT, expectedReport)])
}
if (!fs.existsSync(buildProvenancePath)) {
  infrastructureFailure('PROVENANCE_FAILURE', ['build-provenance.json missing from the prepared artifact'])
}

let report
try { report = JSON.parse(fs.readFileSync(expectedReport, 'utf8')) }
catch (error) { fail('cannot parse report: ' + error.message) }
let build
try { build = JSON.parse(fs.readFileSync(buildProvenancePath, 'utf8')) }
catch (error) { fail('cannot parse build provenance: ' + error.message) }
let gate = null
if (fs.existsSync(gatePath)) {
  try { gate = JSON.parse(fs.readFileSync(gatePath, 'utf8')) }
  catch (error) { fail('cannot parse ambient gate artifact: ' + error.message) }
}

const policy = readJson(policyPath)
if (sha256File(policyPath) !== plan.policySha256) fail('governor policy changed after resolve')

const decision = judgeRunEvidence({
  plan,
  policy,
  report,
  build,
  gate,
  env: process.env,
  phase: PHASE,
  browser,
  replicate: REPLICATE,
})

finish(
  {
    ...decision,
    reportSha256: sha256File(expectedReport),
    reportPath: path.relative(ROOT, expectedReport).replaceAll('\\', '/'),
    gateSha256: gate && fs.existsSync(gatePath) ? sha256File(gatePath) : null,
  },
  decision.verdict === 'PROVENANCE_FAILURE' || decision.verdict === 'INCOMPLETE_EVIDENCE' ? 1 : 0,
)
