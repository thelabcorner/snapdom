#!/usr/bin/env node
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
if (policy.schema !== 'snapdom-r10-f4-wall-policy-v1') fail('policy schema mismatch')
if (process.env.GITHUB_REPOSITORY !== policy.repository) fail('repository identity mismatch')
if (process.version !== `v${policy.nodeVersion}`) fail(`Node ${process.version} != policy v${policy.nodeVersion}`)
if (!/^\d+\.\d+\.\d+$/.test(policy.playwrightVersion)) fail('Playwright must be exact x.y.z')
if (!Array.isArray(policy.fixtures) || !policy.fixtures.length) fail('fixture list missing')
if (!Array.isArray(policy.noopFixtures) || !policy.noopFixtures.length) fail('no-op control missing')
for (const [engine, count] of Object.entries(policy.replicates || {})) {
  if (!['chromium', 'firefox', 'webkit'].includes(engine) || !Number.isInteger(count) || count < 1 || count > 16) {
    fail('invalid engine replicate policy')
  }
}
const s = policy.sampling || {}
for (const k of ['n', 'batch', 'warmup', 'bootstrap', 'baseSeed']) {
  if (!Number.isInteger(s[k]) || s[k] < 0) fail(`invalid sampling.${k}`)
}
const gates = policy.gates || {}
if (!(gates.minEffectPct > 0)) fail('gates.minEffectPct must be a positive number')
if (!(gates.controlBand > 0) || !(gates.equivalenceBand > 0) || !(gates.maxPairLogSd > 0)) {
  fail('gate bands must be positive numbers')
}
if (!policy.decision?.reject || !policy.decision?.promoteToDesign) fail('decision rule missing both branches')
for (const name of policy.noopFixtures) {
  if (!policy.fixtures.includes(name)) fail(`no-op control not in fixtures: ${name}`)
}

const require = createRequire(import.meta.url)
const pw = require('playwright/package.json').version
if (pw !== policy.playwrightVersion) fail(`installed Playwright ${pw} != policy ${policy.playwrightVersion}`)

const rels = [
  'lane6-scratch/r10-shadow/bench-f4.mjs',
  'lane6-scratch/r9/protocol.mjs',
  '__tests__/helpers/shadowCards.js',
  'lane6-scratch/r5/run-with-timing-gate.mjs',
  'lane6-scratch/r10-shadow/F4_POLICY.json',
  'lane6-scratch/r10-shadow/prepare.mjs',
  'lane6-scratch/r10-shadow/run.mjs',
  'lane6-scratch/r10-shadow/validate.mjs',
  '.github/workflows/r10-f4-wall.yml',
  'package-lock.json',
  'esbuild.config.mjs',
]
const files = Object.fromEntries(rels.map((rel) => {
  const abs = path.resolve(ROOT, rel)
  if (!fs.existsSync(abs)) fail(`measurement file missing: ${rel}`)
  return [rel, shaFile(abs)]
}))

const candidateGitSha = process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null
if (!/^[0-9a-f]{40}$/i.test(candidateGitSha || '')) fail('exact candidate git SHA missing')

const prepared = {
  schema: 'snapdom-r10-f4-wall-prepared-v1',
  generatedAt: new Date().toISOString(),
  policy,
  policySha256: shaFile(POLICY),
  candidateGitSha,
  bundle: { sha256: shaFile(BUNDLE), bytes: fs.statSync(BUNDLE).size },
  measurementFiles: files,
  github: {
    repository: process.env.GITHUB_REPOSITORY,
    workflow: process.env.GITHUB_WORKFLOW || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  },
}
fs.writeFileSync(OUT, JSON.stringify(prepared, null, 2) + '\n')

const chromium = Array.from({ length: policy.replicates.chromium }, (_, i) => i)
const engines = []
for (const engine of ['firefox', 'webkit']) {
  for (let replicate = 0; replicate < policy.replicates[engine]; replicate++) {
    engines.push({ engine, replicate })
  }
}
const outputs = {
  policy_sha256: prepared.policySha256,
  bundle_sha256: prepared.bundle.sha256,
  chromium_matrix: JSON.stringify(chromium),
  engine_matrix: JSON.stringify(engines),
  max_parallel: String(policy.maxParallel),
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''))
}
console.log(JSON.stringify({ prepared: true, ...outputs }, null, 2))