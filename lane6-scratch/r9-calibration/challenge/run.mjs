#!/usr/bin/env node
/**
 * Spawn one hosted topology-challenge runner cell, after re-verifying every piece of frozen
 * provenance the prepare job recorded.
 *
 * The re-verification is the point. A runner cell downloads the prepared bundle and plan as an
 * artifact, so the only thing standing between "the workflow said so" and "these bytes were measured"
 * is this file recomputing every hash and refusing to launch a browser on a mismatch.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { laneExecutionOrder, laneBudget, totalTimedCalls } from './algebra/call-budget.mjs'

const ROOT = process.cwd()
const CHAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge')
const PREP = path.join(CHAL, 'prepared.json')
const BUNDLE = path.resolve(ROOT, 'lane6-scratch/r9-calibration/bundle/candidate.mjs')

const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()
const fail = (m) => { console.error('R9 topology challenge run refused:', m); process.exit(1) }

if (process.env.GITHUB_ACTIONS !== 'true') fail('browser execution is GitHub-Actions-only')
if (!fs.existsSync(PREP) || !fs.existsSync(BUNDLE)) fail('prepared evidence or bundle missing')

const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
if (prepared.schema !== 'snapdom-r9-hosted-topology-challenge-prepared-v1') fail('prepared schema mismatch')
if (process.env.GITHUB_REPOSITORY !== policy.repository) fail('repository mismatch')
if (!process.env.GITHUB_RUN_ID || !process.env.GITHUB_JOB || !process.env.RUNNER_NAME) fail('hosted provenance incomplete')
if (process.env.RUNNER_OS !== 'Linux') fail('the challenge requires a Linux GitHub-hosted runner')
if (!process.env.ImageOS || !process.env.ImageVersion) fail('runner image provenance missing')
if (shaFile(path.join(CHAL, 'POLICY.json')) !== prepared.policySha256) fail('policy drift')
if (shaFile(BUNDLE) !== prepared.bundle.sha256) fail('bundle drift')
for (const [rel, expected] of Object.entries(prepared.measurementFiles || {})) {
  const abs = path.resolve(ROOT, rel)
  if (!fs.existsSync(abs) || shaFile(abs) !== expected) fail(`measurement semantics drift: ${rel}`)
}
const gitSha = process.env.SNAPDOM_CANDIDATE_GIT_SHA || process.env.GITHUB_SHA || ''
if (gitSha !== prepared.candidateGitSha) fail('candidate git SHA drift')

const require = createRequire(import.meta.url)
const pw = require('playwright/package.json').version
if (pw !== policy.playwrightVersion) fail('Playwright version drift')

const browser = String(arg('browser', policy.browser)).toLowerCase()
if (browser !== policy.browser) fail(`this challenge is ${policy.browser}-only`)
const replicate = Number(arg('replicate'))
const profile = arg('profile', 'primary')
if (!Number.isInteger(replicate) || replicate < 0 || replicate >= policy.replicates[browser]) {
  fail(`replicate outside the preregistered matrix: ${replicate}`)
}
if (!policy.sampling[profile]) fail(`unknown sampling profile: ${profile}`)

const seed = (policy.baseSeed + replicate * 104729) >>> 0
const outName = `topology-${browser}-r${replicate}.json`
const sampling = policy.sampling[profile]
const totals = totalTimedCalls(sampling, policy.fixtures.length)
const benchArgs = [
  path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge/bench-r9-topology.mjs'),
  `--browser=${browser}`,
  `--replicate=${replicate}`,
  `--profile=${profile}`,
  `--seed=${seed}`,
  `--bootstrap=${policy.bootstrap}`,
  `--bundle=${path.relative(ROOT, BUNDLE).replaceAll('\\', '/')}`,
  `--playwright-version=${policy.playwrightVersion}`,
  `--label=R9 hosted topology challenge ${browser} r${replicate} ${profile}`,
  `--out=${outName}`,
]

const request = {
  schema: 'snapdom-r9-hosted-topology-challenge-request-v1',
  browser,
  replicate,
  profile,
  seed,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
  laneOrder: laneExecutionOrder(policy.lanes, replicate),
  budget: {
    perLane: Object.fromEntries(policy.lanes.map((l) => [l, laneBudget(l, sampling)])),
    timedCallsPerFixture: totals.perFixture,
    timedCallsTotal: totals.total,
  },
  positiveControl: policy.positiveControl,
  github: {
    // runAttempt is recorded for provenance but MUST NOT enter any artifact name: cell identity is
    // run_id + replicate, so a retry overwrites its own evidence instead of duplicating the cell.
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB,
    runnerName: process.env.RUNNER_NAME,
    imageOs: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
  },
  argv: [process.execPath, ...benchArgs.map((x, i) => (i === 0 ? path.relative(ROOT, x).replaceAll('\\', '/') : x))],
}
fs.mkdirSync(path.join(CHAL, 'requests'), { recursive: true })
fs.writeFileSync(
  path.join(CHAL, 'requests', `topology-${browser}-r${replicate}.json`),
  JSON.stringify(request, null, 2) + '\n',
)

const child = spawnSync(process.execPath, benchArgs, {
  cwd: ROOT,
  env: {
    ...process.env,
    SNAPDOM_BENCH_MANIFEST_SHA256: prepared.policySha256,
    SNAPDOM_CANDIDATE_GIT_SHA: prepared.candidateGitSha,
  },
  stdio: 'inherit',
})
if (child.error) fail(child.error.message)
process.exit(child.status ?? 1)
