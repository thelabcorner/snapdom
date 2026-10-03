#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { arg, sha256File } from './protocol.mjs'

const ROOT = process.cwd()
const PLAN_PATH = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const PHASE = arg('phase')
const REPLICATE = Number(arg('replicate', '0'))
const BROWSER_ARG = arg('browser', '')

function fail(message) {
  console.error(`R9 run refused: ${message}`)
  process.exit(1)
}
if (!process.env.GITHUB_ACTIONS || process.env.GITHUB_ACTIONS !== 'true') {
  fail('browser phases are GitHub-Actions-only')
}
if (!['scout', 'confirm', 'engineGuard'].includes(PHASE)) fail('missing/invalid --phase')
if (!Number.isInteger(REPLICATE) || REPLICATE < 0 || REPLICATE > 31) fail('invalid --replicate')
if (!fs.existsSync(PLAN_PATH)) fail('resolved-plan.json missing; run resolve-candidate.mjs first')

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
if (plan.schema !== 'snapdom-r9-resolved-plan-v1') fail('resolved-plan schema mismatch')
const candidate = plan.candidate
const phase = candidate.phases[PHASE]
if (!phase) fail(`phase ${PHASE} is not registered`)
if (REPLICATE >= phase.replicates) fail(`replicate ${REPLICATE} is outside declared count ${phase.replicates}`)

const browser = BROWSER_ARG || phase.browsers[0]
if (!phase.browsers.includes(browser)) fail(`browser ${browser} is not declared for phase ${PHASE}`)

const manifestPath = path.resolve(ROOT, plan.candidateManifest)
const observedManifestSha = sha256File(manifestPath)
if (observedManifestSha !== plan.candidateManifestSha256) fail('candidate manifest changed after resolve')
if (process.env.SNAPDOM_BENCH_MANIFEST_SHA256 &&
    process.env.SNAPDOM_BENCH_MANIFEST_SHA256 !== observedManifestSha) {
  fail('workflow manifest SHA does not match resolved plan')
}

const bundles = path.resolve(ROOT, 'lane6-scratch/r9/bundles')
const candidateBundle = path.join(bundles, 'candidate.mjs')
const baselineBundle = path.join(bundles, 'baseline.mjs')
if (!fs.existsSync(candidateBundle)) fail('candidate bundle artifact missing')
if (candidate.mode === 'bundle-diff' && !fs.existsSync(baselineBundle)) fail('baseline bundle artifact missing')

const selection = [...candidate.primaryFixtures, ...candidate.guardFixtures]
const seed = (phase.seed + REPLICATE * 104729) >>> 0
const outName = `${candidate.id}-${PHASE}-${browser}-r${REPLICATE}.json`
const expect = phase.expect || candidate.expect

const args = [
  path.resolve(ROOT, 'lane6-scratch/r9/bench-r9-controlled.mjs'),
  `--mode=${candidate.mode}`,
  `--suite=${candidate.suite}`,
  `--baseline=${path.relative(ROOT, baselineBundle).replaceAll('\\', '/')}`,
  `--candidate=${path.relative(ROOT, candidateBundle).replaceAll('\\', '/')}`,
  `--base=${JSON.stringify(candidate.base)}`,
  `--opt=${JSON.stringify(candidate.opt)}`,
  `--browser=${browser}`,
  `--n=${phase.n}`,
  `--batch=${phase.batch}`,
  `--warmup=${phase.warmup}`,
  `--bootstrap=${phase.bootstrap}`,
  `--epsilon=${phase.epsilon}`,
  `--control-band=${phase.controlBand}`,
  `--noop-band=${phase.equivalenceBand}`,
  `--max-pair-log-sd=${phase.maxPairLogSd}`,
  `--seed=${seed}`,
  `--expect=${expect}`,
  `--playwright-version=${candidate.playwrightVersion}`,
  `--label=${candidate.id} ${PHASE} ${browser} r${REPLICATE}`,
  `--out=${outName}`,
]
if (selection.length) args.push(`--only=${selection.join(',')}`)

const requestDir = path.resolve(ROOT, 'lane6-scratch/r9/results')
fs.mkdirSync(requestDir, { recursive: true })
const request = {
  schema: 'snapdom-r9-run-request-v1',
  candidateId: candidate.id,
  phase: PHASE,
  replicate: REPLICATE,
  browser,
  seed,
  manifestSha256: observedManifestSha,
  candidateGitSha: process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null,
  baselineGitSha: process.env.SNAPDOM_BASELINE_GIT_SHA || null,
  argv: [process.execPath, ...args.map((v, i) => i === 0 ? path.relative(ROOT, v).replaceAll('\\', '/') : v)],
  output: `lane6-scratch/r9/results/${outName}`,
}
fs.writeFileSync(
  path.join(requestDir, `${candidate.id}-${PHASE}-${browser}-r${REPLICATE}-request.json`),
  JSON.stringify(request, null, 2) + '\n',
)

const child = spawnSync(process.execPath, args, {
  cwd: ROOT,
  env: {
    ...process.env,
    SNAPDOM_BENCH_MANIFEST_SHA256: observedManifestSha,
  },
  stdio: 'inherit',
})
if (child.error) fail(child.error.message)
process.exit(child.status ?? 1)
