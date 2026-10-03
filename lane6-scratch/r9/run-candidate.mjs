#!/usr/bin/env node
/**
 * Executes exactly one preregistered fresh-runner cell.
 *
 * Two jobs:
 *   1. refuse anything the preregistration does not already authorise (including local browsers);
 *   2. hand the measurement to the ambient CPU gate, then to the hosted-only harness.
 *
 * All numeric arguments are read from the resolved plan (policy-owned). Nothing is passed through
 * from the candidate, because nothing numeric survives candidate resolution.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { arg, sha256File } from './protocol.mjs'
import { GovernorRefusal, assertHostedEnvironment, deriveSeed } from './governor.mjs'

const ROOT = process.cwd()
const PLAN_PATH = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const PHASE = arg('phase')
const REPLICATE = Number(arg('replicate', '0'))
const BROWSER_ARG = arg('browser', '')

function fail(message, detail) {
  console.error(`R9 run refused: ${message}`)
  if (detail && Object.keys(detail).length) console.error(JSON.stringify(detail, null, 2))
  process.exit(1)
}

try {
  assertHostedEnvironment()
} catch (error) {
  fail(error instanceof GovernorRefusal ? error.message : String(error))
}

if (!['scout', 'confirm', 'engineGuard'].includes(PHASE)) fail(`invalid --phase ${PHASE}`)
if (!Number.isInteger(REPLICATE) || REPLICATE < 0) fail('invalid --replicate')
if (!fs.existsSync(PLAN_PATH)) fail('resolved-plan.json missing; run resolve-candidate.mjs first')

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
if (plan.schema !== 'snapdom-r9-resolved-plan-v2') fail('resolved-plan schema mismatch')
const candidate = plan.candidate
const phaseSpec = plan.phaseSpec[PHASE]
if (!phaseSpec) fail(`phase ${PHASE} is not registered in policy`)

const preregistered = Number.isInteger(phaseSpec.replicates) ? phaseSpec.replicates : null
if (preregistered === null) {
  fail(`phase ${PHASE} has no preregistered replicate count; policy slot phases.${PHASE}.replicates is unfrozen and hosted calibration owns it`)
}
if (REPLICATE >= preregistered) fail(`replicate ${REPLICATE} is outside preregistered count ${preregistered}`)

const browser = BROWSER_ARG || phaseSpec.browsers[0]
if (!phaseSpec.browsers.includes(browser)) fail(`browser ${browser} is not preregistered for phase ${PHASE}`)

const manifestPath = path.resolve(ROOT, plan.candidateManifest)
const observedManifestSha = sha256File(manifestPath)
if (observedManifestSha !== plan.candidateManifestSha256) fail('candidate manifest changed after resolve')
const observedPolicySha = sha256File(path.resolve(ROOT, 'lane6-scratch/r9/POLICY.json'))
if (observedPolicySha !== plan.policySha256) fail('governor policy changed after resolve')
if (process.env.SNAPDOM_MEASURED_SHA && process.env.SNAPDOM_MEASURED_SHA !== plan.measuredSha) {
  fail('workflow measured SHA does not match the resolved plan')
}
if (process.env.SNAPDOM_BENCH_MANIFEST_SHA256 &&
    process.env.SNAPDOM_BENCH_MANIFEST_SHA256 !== observedManifestSha) {
  fail('workflow manifest SHA does not match the resolved plan')
}

const bundles = path.resolve(ROOT, 'lane6-scratch/r9/bundles')
const candidateBundle = path.join(bundles, 'candidate.mjs')
const baselineBundle = path.join(bundles, 'baseline.mjs')
if (!fs.existsSync(candidateBundle)) fail('candidate bundle artifact missing')
if (candidate.mode === 'bundle-diff' && !fs.existsSync(baselineBundle)) fail('baseline bundle artifact missing')

const acquisition = plan.acquisition[PHASE]
const selection = [...plan.selection.selected]
const expectation = plan.phaseExpectations[PHASE]
const seed = deriveSeed(acquisition.seed, REPLICATE)
const outName = `${candidate.id}-${PHASE}-${browser}-r${REPLICATE}.json`

const args = [
  path.resolve(ROOT, plan.harnessRel),
  `--mode=${candidate.mode}`,
  `--suite=${candidate.suite}`,
  `--baseline=${path.relative(ROOT, baselineBundle).replaceAll('\\', '/')}`,
  `--candidate=${path.relative(ROOT, candidateBundle).replaceAll('\\', '/')}`,
  `--base=${JSON.stringify(candidate.base)}`,
  `--opt=${JSON.stringify(candidate.opt)}`,
  `--browser=${browser}`,
  `--n=${acquisition.n}`,
  `--batch=${acquisition.batch}`,
  `--warmup=${acquisition.warmup}`,
  `--bootstrap=${acquisition.bootstrap}`,
  `--epsilon=${plan.thresholds.epsilon}`,
  `--control-band=${plan.thresholds.controlBand}`,
  `--noop-band=${plan.thresholds.equivalenceBand}`,
  `--max-pair-log-sd=${plan.thresholds.maxPairLogSd}`,
  `--seed=${seed}`,
  `--expect=${expectation.toLowerCase()}`,
  `--expectation=${expectation}`,
  `--phase=${PHASE}`,
  `--replicate=${REPLICATE}`,
  `--policy-sha256=${plan.policySha256}`,
  `--manifest-sha256=${observedManifestSha}`,
  `--measured-sha=${plan.measuredSha}`,
  `--measured-ref=${plan.measuredRef}`,
  `--label=${candidate.id} ${PHASE} ${browser} r${REPLICATE}`,
  `--out=${outName}`,
]
if (selection.length) args.push(`--only=${selection.join(',')}`)

const requestDir = path.resolve(ROOT, 'lane6-scratch/r9/requests')
fs.mkdirSync(requestDir, { recursive: true })
const request = {
  schema: 'snapdom-r9-run-request-v2',
  candidateId: candidate.id,
  phase: PHASE,
  replicate: REPLICATE,
  browser,
  seed,
  expectation,
  manifestSha256: observedManifestSha,
  policySha256: observedPolicySha,
  measuredSha: plan.measuredSha,
  measuredRef: plan.measuredRef,
  argv: [process.execPath, ...args.map((v, i) => (i === 0 ? path.relative(ROOT, v).replaceAll('\\', '/') : v))],
  output: `lane6-scratch/r9/results/${outName}`,
}
fs.writeFileSync(path.join(requestDir, `${candidate.id}-${PHASE}-${browser}-r${REPLICATE}-request.json`),
  JSON.stringify(request, null, 2) + '\n')

const child = spawnSync(process.execPath, args, {
  cwd: ROOT,
  env: {
    ...process.env,
    SNAPDOM_BENCH_MANIFEST_SHA256: observedManifestSha,
    SNAPDOM_BENCH_POLICY_SHA256: observedPolicySha,
    SNAPDOM_MEASURED_SHA: plan.measuredSha,
    SNAPDOM_MEASURED_REF: plan.measuredRef,
  },
  stdio: 'inherit',
})
if (child.error) fail(child.error.message)
process.exit(child.status ?? 1)
