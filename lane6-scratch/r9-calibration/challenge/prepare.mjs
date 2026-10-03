#!/usr/bin/env node
/**
 * Freeze the immutable identity of the R9 hosted topology challenge.
 *
 * GitHub-Actions-only, exactly like `lane6-scratch/r9-calibration/prepare.mjs`, because its whole
 * job is to bind a set of file hashes, a bundle hash, a policy hash and an exact git SHA into one
 * document that every later job re-verifies. If that binding can be produced locally, it is not
 * provenance.
 *
 * It additionally refuses to emit a plan unless:
 *   - the workflow and policy pass the browser-free structural audit;
 *   - the challenge's settle configuration is deep-equal to the calibration's, so the challenge
 *     cannot drift onto a different ambient threshold than the run it is compared against;
 *   - BOTH sampling profiles satisfy every preregistered equal-budget pair and every structural
 *     constraint, so an operator cannot dispatch a profile that is quietly unbalanced.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { auditPolicy, auditWorkflow } from './algebra/workflow-contract.mjs'
import { LANE_NAMES, budgetPairReport, describeSamplingProfile, laneBudget } from './algebra/call-budget.mjs'

const ROOT = process.cwd()
const CHAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge')
const CAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration')
const POLICY = path.join(CHAL, 'POLICY.json')
const CAL_POLICY = path.join(CAL, 'POLICY.json')
const BUNDLE = path.join(CAL, 'bundle/candidate.mjs')
const WORKFLOW = path.resolve(ROOT, '.github/workflows/r9-topology-challenge.yml')
const OUT = path.join(CHAL, 'prepared.json')

const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const fail = (m) => { console.error('R9 topology challenge prepare refused:', m); process.exit(1) }

if (process.env.GITHUB_ACTIONS !== 'true') fail('prepare is GitHub-Actions-only')
if (!fs.existsSync(POLICY)) fail('challenge policy missing')
if (!fs.existsSync(BUNDLE)) fail('compiled bundle missing: run npm run compile and copy dist/snapdom.mjs first')

const policy = readJson(POLICY)
const policyAudit = auditPolicy(policy)
if (policyAudit.problems.length) fail(`policy audit: ${policyAudit.problems.join(' | ')}`)
if (!fs.existsSync(WORKFLOW)) fail('challenge workflow missing')
const workflowAudit = auditWorkflow(fs.readFileSync(WORKFLOW, 'utf8'))
if (workflowAudit.problems.length) fail(`workflow audit: ${workflowAudit.problems.join(' | ')}`)

if (process.env.GITHUB_REPOSITORY !== policy.repository) fail('repository identity mismatch')
if (process.version !== `v${policy.nodeVersion}`) fail(`Node ${process.version} != policy v${policy.nodeVersion}`)
if (!/^\d+\.\d+\.\d+$/.test(policy.playwrightVersion)) fail('Playwright must be exact x.y.z')

const require = createRequire(import.meta.url)
const pw = require('playwright/package.json').version
if (pw !== policy.playwrightVersion) fail(`installed Playwright ${pw} != policy ${policy.playwrightVersion}`)

const calPolicy = readJson(CAL_POLICY)
if (JSON.stringify(calPolicy.settle) !== JSON.stringify(policy.settle)) {
  fail(`settle configuration drifted from lane6-scratch/r9-calibration/POLICY.json: ${JSON.stringify(policy.settle)}`)
}

const declaredLanes = policy.lanes
if (declaredLanes.length !== LANE_NAMES.length || !LANE_NAMES.every((l) => declaredLanes.includes(l))) {
  fail(`policy lanes must be exactly the six preregistered lanes: ${LANE_NAMES.join(', ')}`)
}

const profiles = {}
for (const [name, sampling] of Object.entries(policy.sampling)) {
  const budget = describeSamplingProfile(name, sampling, policy.fixtures.length)
  const unbalanced = budget.pairs.filter((p) => !p.equal)
  if (unbalanced.length) {
    fail(`profile ${name} is unbalanced on ${unbalanced.map((p) => p.pair.join(' vs ')).join(', ')}`)
  }
  const structural = LANE_NAMES
    .map((l) => laneBudget(l, sampling))
    .filter((b) => !b.rotationComplete || !b.withinBlockBalanced)
    .map((b) => `${b.lane}(rotation=${b.rotationComplete},balanced=${b.withinBlockBalanced})`)
  if (structural.length) fail(`profile ${name} violates structural constraints: ${structural.join(', ')}`)
  profiles[name] = budget
}

const rels = [
  'lane6-scratch/r9/protocol.mjs',
  'lane6-scratch/atlas/profiler/fixtures.mjs',
  'lane6-scratch/r5/run-with-timing-gate.mjs',
  'lane6-scratch/r9-calibration/settle.mjs',
  'lane6-scratch/r9-calibration/POLICY.json',
  'lane6-scratch/r9-calibration/DIAGNOSTIC-LEDGER.md',
  'lane6-scratch/r9-calibration/challenge/POLICY.json',
  'lane6-scratch/r9-calibration/challenge/README.md',
  'lane6-scratch/r9-calibration/challenge/bench-r9-topology.mjs',
  'lane6-scratch/r9-calibration/challenge/prepare.mjs',
  'lane6-scratch/r9-calibration/challenge/run.mjs',
  'lane6-scratch/r9-calibration/challenge/validate.mjs',
  'lane6-scratch/r9-calibration/challenge/aggregate.mjs',
  'lane6-scratch/r9-calibration/challenge/algebra/call-budget.mjs',
  'lane6-scratch/r9-calibration/challenge/algebra/topology-model.mjs',
  'lane6-scratch/r9-calibration/challenge/algebra/aggregate-contract.mjs',
  'lane6-scratch/r9-calibration/challenge/algebra/decision.mjs',
  'lane6-scratch/r9-calibration/challenge/algebra/decision.test.mjs',
  'lane6-scratch/r9-calibration/challenge/algebra/workflow-contract.mjs',
  'lane6-scratch/r9-calibration/challenge/algebra/topology-challenge.test.mjs',
  '.github/workflows/r9-topology-challenge.yml',
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
  schema: 'snapdom-r9-hosted-topology-challenge-prepared-v1',
  generatedAt: new Date().toISOString(),
  policy,
  policySha256: shaFile(POLICY),
  calibrationPolicySha256: shaFile(CAL_POLICY),
  settleSha256: shaFile(path.join(CAL, 'settle.mjs')),
  candidateGitSha,
  bundle: { sha256: shaFile(BUNDLE), bytes: fs.statSync(BUNDLE).size },
  profiles,
  equalBudgetPairs: Object.fromEntries(
    Object.entries(policy.sampling).map(([name, s]) => [name, budgetPairReport(s)])),
  workflowAudit,
  policyAudit,
  measurementFiles: files,
  github: {
    repository: process.env.GITHUB_REPOSITORY,
    workflow: process.env.GITHUB_WORKFLOW || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
  },
}
fs.mkdirSync(CHAL, { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(prepared, null, 2) + '\n')

const chromium = Array.from({ length: policy.replicates.chromium }, (_, i) => i)
const outputs = {
  policy_sha256: prepared.policySha256,
  bundle_sha256: prepared.bundle.sha256,
  chromium_matrix: JSON.stringify(chromium),
  max_parallel: String(policy.maxParallel),
  node_version: policy.nodeVersion,
  profiles: JSON.stringify(Object.keys(policy.sampling)),
  primary_timed_calls_total: String(profiles.primary.timedCallsTotal),
  reduced_timed_calls_total: String(profiles.reduced.timedCallsTotal),
}
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''))
}
console.log(JSON.stringify({ prepared: true, replicates: policy.replicates.chromium, ...outputs }, null, 2))
