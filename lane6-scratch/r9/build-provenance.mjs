#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { sha256File } from './protocol.mjs'

const ROOT = process.cwd()
const planPath = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
if (!fs.existsSync(planPath)) throw new Error('resolved plan missing')
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
const bundleDir = path.resolve(ROOT, 'lane6-scratch/r9/bundles')
const candidatePath = path.join(bundleDir, 'candidate.mjs')
const baselinePath = path.join(bundleDir, 'baseline.mjs')
if (!fs.existsSync(candidatePath)) throw new Error('candidate bundle missing')
if (plan.candidate.mode === 'bundle-diff' && !fs.existsSync(baselinePath)) throw new Error('baseline bundle missing')

const npmVersion = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8' }).trim()
const record = {
  schema: 'snapdom-r9-build-provenance-v1',
  generatedAt: new Date().toISOString(),
  candidateId: plan.candidateId,
  manifestSha256: plan.candidateManifestSha256,
  candidate: {
    gitSha: process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || null,
    bundleSha256: sha256File(candidatePath),
    bundleBytes: fs.statSync(candidatePath).size,
  },
  baseline: plan.candidate.mode === 'bundle-diff' ? {
    gitSha: process.env.SNAPDOM_BASELINE_GIT_SHA || plan.candidate.baselineRef,
    bundleSha256: sha256File(baselinePath),
    bundleBytes: fs.statSync(baselinePath).size,
  } : {
    gitSha: null,
    bundleSha256: sha256File(candidatePath),
    bundleBytes: fs.statSync(candidatePath).size,
  },
  toolchain: {
    node: process.version,
    npm: npmVersion,
    packageLockSha256: sha256File(path.resolve(ROOT, 'package-lock.json')),
    esbuildConfigSha256: sha256File(path.resolve(ROOT, 'esbuild.config.mjs')),
    playwrightVersion: plan.candidate.playwrightVersion,
  },
  github: {
    repository: process.env.GITHUB_REPOSITORY || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    eventName: process.env.GITHUB_EVENT_NAME || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
  },
}
fs.writeFileSync(path.join(bundleDir, 'build-provenance.json'), JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(record, null, 2))
