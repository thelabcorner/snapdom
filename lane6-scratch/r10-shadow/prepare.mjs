#!/usr/bin/env node
// Freezes the identity of one F4 run: the policy, the compiled bundle, the runner, the toolchain
// and the hash of every file whose contents define what a measurement MEANS. A later cell refuses
// to run against a policy or a harness that moved under it, so a verdict can always be traced to
// the exact bytes that produced it.
//
// GitHub-Actions-only, like every other step in this lane.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = process.cwd()
const LANE = path.resolve(ROOT, 'lane6-scratch/r10-shadow')
const POLICY = path.join(LANE, 'F4_POLICY.json')
const BUNDLE = path.join(LANE, 'bundle/candidate.mjs')
const OUT = path.join(LANE, 'prepared.json')

const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()
const fail = (m) => { console.error('F4 prepare refused:', m); process.exit(1) }

if (process.env.GITHUB_ACTIONS !== 'true') fail('prepare is GitHub-Actions-only')
if (!fs.existsSync(POLICY) || !fs.existsSync(BUNDLE)) fail('policy or compiled bundle missing')
const policy = JSON.parse(fs.readFileSync(POLICY, 'utf8'))
if (policy.schema !== 'snapdom-r10-f4-wall-policy-v2') fail('policy schema mismatch')
if (process.env.GITHUB_REPOSITORY !== policy.repository) fail('repository identity mismatch')
if (process.version !== `v${policy.nodeVersion}`) fail(`Node ${process.version} != policy v${policy.nodeVersion}`)
if (!/^\d+\.\d+\.\d+$/.test(policy.playwrightVersion)) fail('Playwright must be exact x.y.z')

if (!Array.isArray(policy.fixtures) || !policy.fixtures.length) fail('fixture list missing')
if (!Array.isArray(policy.noopFixtures) || !policy.noopFixtures.length) fail('no-op control missing')
for (const name of policy.noopFixtures) {
  if (!policy.fixtures.includes(name)) fail('no-op control not in fixtures: ' + name)
}
for (const name of policy.promotionExcludedFixtures || []) {
  if (!policy.fixtures.includes(name)) fail('promotion-excluded fixture not in fixtures: ' + name)
}
for (const name of policy.parityExemptFixtures || []) {
  if (!policy.fixtures.includes(name)) fail('parity-exempt fixture not in fixtures: ' + name)
}
for (const [engine, count] of Object.entries(policy.replicates || {})) {
  if (!['chromium', 'firefox', 'webkit'].includes(engine) || !Number.isInteger(count) || count < 1 || count > 16) {
    fail('invalid engine replicate policy')
  }
}
if (!policy.replicates.chromium || policy.replicates.chromium < 2) {
  fail('the primary stage needs at least two fresh runners to have a variance at all')
}
const s = policy.sampling || {}
for (const k of ['n', 'batch', 'warmup', 'bootstrap', 'baseSeed']) {
  if (!Number.isInteger(s[k]) || s[k] < 0) fail('invalid sampling.' + k)
}
const t = policy.thresholds || {}
if (!(t.practicalFloorPct > 0)) fail('thresholds.practicalFloorPct must be positive')
if (!(t.materialRegressionPct > 0)) fail('thresholds.materialRegressionPct must be positive')
const instrument = policy.instrument || {}
if (!(instrument.outerNullEnvelopePct > 0)) fail('instrument.outerNullEnvelopePct must be positive')
if (!instrument.outerNullEnvelopeSource) fail('instrument.outerNullEnvelopeSource must cite its origin')
if (!(instrument.grossMaxPairLogSd > 0)) fail('instrument.grossMaxPairLogSd must be positive')
for (const state of ['REJECT_PARTITION', 'PROMISING', 'INCONCLUSIVE', 'INCOMPLETE_EVIDENCE', 'PROVENANCE_FAILURE']) {
  if (!policy.decision?.[state]) fail('decision rule missing ' + state)
}
if (!Array.isArray(policy.stageOrder) || policy.stageOrder[0] !== 'chromium') {
  fail('stageOrder must start with the chromium primary stage')
}

const require = createRequire(import.meta.url)
const pw = require('playwright/package.json').version
if (pw !== policy.playwrightVersion) fail('installed Playwright ' + pw + ' != policy ' + policy.playwrightVersion)

// Everything whose contents define the measurement: the driver, the shared protocol, the fixtures,
// the aggregation arithmetic, the gate, and the policy itself.
const rels = [
  'lane6-scratch/r10-shadow/F4_POLICY.json',
  'lane6-scratch/r10-shadow/bench-f4.mjs',
  'lane6-scratch/r10-shadow/prepare.mjs',
  'lane6-scratch/r10-shadow/run.mjs',
  'lane6-scratch/r10-shadow/validate.mjs',
  'lane6-scratch/r10-shadow/aggregate.mjs',
  'lane6-scratch/r10-shadow/settle.mjs',
  'lane6-scratch/r10-shadow/lib/stats.mjs',
  'lane6-scratch/r10-shadow/lib/matrix.mjs',
  'lane6-scratch/r10-shadow/lib/decide.mjs',
  'lane6-scratch/r10-shadow/lib/artifacts.mjs',
  'lane6-scratch/r10-shadow/lib/settle.mjs',
  'lane6-scratch/r10-shadow/lib/workflow.mjs',
  'lane6-scratch/r9/protocol.mjs',
  'lane6-scratch/r5/run-with-timing-gate.mjs',
  '__tests__/helpers/shadowCards.js',
  '.github/workflows/r10-f4-wall.yml',
  'package-lock.json',
  'esbuild.config.mjs',
]
const files = Object.fromEntries(rels.map((rel) => {
  const abs = path.resolve(ROOT, rel)
  if (!fs.existsSync(abs)) fail('measurement file missing: ' + rel)
  return [rel, shaFile(abs)]
}))

const candidateGitSha = process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null
if (!/^[0-9a-f]{40}$/i.test(candidateGitSha || '')) fail('exact candidate git SHA missing')

const prepared = {
  schema: 'snapdom-r10-f4-wall-prepared-v2',
  generatedAt: new Date().toISOString(),
  policy,
  policySha256: shaFile(POLICY),
  candidateGitSha,
  bundle: { sha256: shaFile(BUNDLE), bytes: fs.statSync(BUNDLE).size },
  measurementFiles: files,
  github: {
    repository: process.env.GITHUB_REPOSITORY,
    // run_id keys every artifact; attempt is recorded here and never used in a name.
    runId: process.env.GITHUB_RUN_ID || null,
    attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
  },
}
fs.writeFileSync(OUT, JSON.stringify(prepared, null, 2) + '\n')

const outputs = {
  policy_sha256: prepared.policySha256,
  bundle_sha256: prepared.bundle.sha256,
  chromium_matrix: JSON.stringify(Array.from({ length: policy.replicates.chromium }, (_, i) => i)),
  engine_matrix: JSON.stringify(
    ['firefox', 'webkit'].flatMap((engine) => Array.from({ length: policy.replicates[engine] }, (_, replicate) => ({ engine, replicate })))
  ),
  max_parallel: String(policy.maxParallel),
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''))
}
console.log(JSON.stringify({ prepared: true, ...outputs }, null, 2))