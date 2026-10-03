#!/usr/bin/env node
/**
 * Freezes the immutable measurement identities for the lane.
 *
 * Everything the governor later re-verifies is pinned here: harness, protocol, fixture source,
 * ambient gate script, lockfile, build config, toolchain versions, workflow identity, the exact
 * measured commit and ref, and the policy-owned thresholds.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { PLAN_SCHEMA, mergeRefProblems, readJson } from './governor.mjs'

const ROOT = process.cwd()
const planPath = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const bundleDir = path.resolve(ROOT, 'lane6-scratch/r9/bundles')
const outPath = path.join(bundleDir, 'build-provenance.json')

function fail(message, detail) {
  console.error(`R9 build provenance refused: ${message}`)
  if (detail && Object.keys(detail).length) console.error(JSON.stringify(detail, null, 2))
  process.exit(1)
}

if (!fs.existsSync(planPath)) fail('resolved plan missing; run resolve-candidate.mjs first')
const plan = readJson(planPath)
if (plan.schema !== PLAN_SCHEMA) fail(`resolved-plan schema mismatch (${plan.schema})`)

const candidatePath = path.join(bundleDir, 'candidate.mjs')
const baselinePath = path.join(bundleDir, 'baseline.mjs')
if (!fs.existsSync(candidatePath)) fail('candidate bundle missing')
if (plan.candidate.mode === 'bundle-diff' && !fs.existsSync(baselinePath)) fail('baseline bundle missing')

const measuredSha = process.env.SNAPDOM_MEASURED_SHA || process.env.GITHUB_SHA || null
const measuredRef = process.env.SNAPDOM_MEASURED_REF || process.env.GITHUB_REF || null
if (!/^[0-9a-f]{40}$/i.test(measuredSha || '')) fail('exact measured git SHA missing')
const refProblems = mergeRefProblems(measuredRef || '')
if (refProblems.length) fail(refProblems.join('; '))
if (measuredSha !== plan.measuredSha) fail(`measured SHA ${measuredSha} does not match resolved plan ${plan.measuredSha}`)
if (measuredRef !== plan.measuredRef) fail(`measured ref ${measuredRef} does not match resolved plan ${plan.measuredRef}`)

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmVersion = execFileSync(npmBin, ['--version'], { encoding: 'utf8' }).trim()
const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
if (playwrightVersion !== plan.toolchainSpec?.playwrightVersion) {
  fail(`installed Playwright ${playwrightVersion} != policy pin ${plan.toolchainSpec?.playwrightVersion}`)
}
const nodeVersion = process.version.replace(/^v/, '')
if (nodeVersion !== plan.toolchainSpec?.nodeVersion) {
  fail(`running Node ${nodeVersion} != policy pin ${plan.toolchainSpec?.nodeVersion}`)
}

const MEASUREMENT_FILES = [
  plan.harnessRel,
  plan.protocolRel,
  plan.fixtureSourceRel,
  plan.governorRel,
  plan.gateRel,
  'lane6-scratch/r9/resolve-candidate.mjs',
  'lane6-scratch/r9/run-candidate.mjs',
  'lane6-scratch/r9/decide-run.mjs',
  'lane6-scratch/r9/aggregate.mjs',
  'lane6-scratch/r9/closeout.mjs',
  'lane6-scratch/r9/POLICY.json',
  'package-lock.json',
  'esbuild.config.mjs',
  '.github/workflows/r9-hosted-bench.yml',
]
const measurementFiles = {}
for (const rel of MEASUREMENT_FILES) {
  const abs = path.resolve(ROOT, rel)
  if (!fs.existsSync(abs)) fail(`measurement file missing: ${rel}`)
  measurementFiles[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').toUpperCase()
}

const record = {
  schema: 'snapdom-r9-build-provenance-v2',
  generatedAt: new Date().toISOString(),
  candidateId: plan.candidateId,
  manifestSha256: plan.candidateManifestSha256,
  policySha256: plan.policySha256,
  measured: {
    sha: measuredSha,
    ref: measuredRef,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  },
  candidate: {
    gitSha: measuredSha,
    bundleSha256: crypto.createHash('sha256').update(fs.readFileSync(candidatePath)).digest('hex').toUpperCase(),
    bundleBytes: fs.statSync(candidatePath).size,
  },
  baseline: plan.candidate.mode === 'bundle-diff' ? {
    gitSha: plan.candidate.baselineRef,
    bundleSha256: crypto.createHash('sha256').update(fs.readFileSync(baselinePath)).digest('hex').toUpperCase(),
    bundleBytes: fs.statSync(baselinePath).size,
  } : {
    gitSha: null,
    bundleSha256: crypto.createHash('sha256').update(fs.readFileSync(candidatePath)).digest('hex').toUpperCase(),
    bundleBytes: fs.statSync(candidatePath).size,
  },
  thresholds: plan.thresholds,
  thresholdFrozen: plan.frozen,
  unfrozenSlots: plan.unfrozenSlots,
  measurementFiles,
  toolchain: {
    node: nodeVersion,
    npm: npmVersion,
    playwrightVersion,
    nodeExpected: plan.toolchainSpec.nodeVersion,
    playwrightExpected: plan.toolchainSpec.playwrightVersion,
    platform: process.platform,
    arch: process.arch,
  },
  gate: plan.gateSpec,
  acquisition: plan.acquisition,
  phaseExpectations: plan.phaseExpectations,
  selection: plan.selection,
  github: {
    repository: process.env.GITHUB_REPOSITORY || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
    eventName: process.env.GITHUB_EVENT_NAME || null,
  },
}

fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(record, null, 2))
