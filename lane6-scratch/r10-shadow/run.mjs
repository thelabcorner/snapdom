#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = process.cwd()
const LANE = path.resolve(ROOT, 'lane6-scratch/r10-shadow')
const PREP = path.join(LANE, 'prepared.json')
const BUNDLE = path.join(LANE, 'bundle/candidate.mjs')
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const fail = (m) => { console.error('F4 run refused:', m); process.exit(1) }
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()

if (process.env.GITHUB_ACTIONS !== 'true') fail('F4 wall measurement is GitHub-Actions-only')
if (!fs.existsSync(PREP) || !fs.existsSync(BUNDLE)) fail('prepared evidence/bundle missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
if (prepared.schema !== 'snapdom-r10-f4-wall-prepared-v1') fail('prepared schema mismatch')
if (process.env.GITHUB_REPOSITORY !== policy.repository) fail('repository mismatch')
if (!process.env.GITHUB_RUN_ID || !process.env.GITHUB_JOB || !process.env.RUNNER_NAME) fail('hosted provenance incomplete')
if (process.env.RUNNER_OS !== 'Linux') fail('F4 requires a Linux GitHub-hosted runner')
if (!process.env.ImageOS || !process.env.ImageVersion) fail('runner image provenance missing')
if (shaFile(path.join(LANE, 'F4_POLICY.json')) !== prepared.policySha256) fail('policy drift')
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

const browser = String(arg('browser')).toLowerCase()
const replicate = Number(arg('replicate'))
if (!['chromium', 'firefox', 'webkit'].includes(browser)) fail('invalid browser')
if (!Number.isInteger(replicate) || replicate < 0 || replicate >= policy.replicates[browser]) {
  fail('replicate outside policy')
}

const engineOffset = { chromium: 0, firefox: 1000003, webkit: 2000003 }[browser]
const seed = (policy.sampling.baseSeed + engineOffset + replicate * 104729) >>> 0
const benchArgs = [
  path.resolve(ROOT, 'lane6-scratch/r10-shadow/bench-f4.mjs'),
  `--browser=${browser}`,
  `--replicate=${replicate}`,
  `--bundle=${path.relative(ROOT, BUNDLE).replaceAll('\\', '/')}`,
  `--n=${policy.sampling.n}`,
  `--batch=${policy.sampling.batch}`,
  `--warmup=${policy.sampling.warmup}`,
  `--bootstrap=${policy.sampling.bootstrap}`,
  `--seed=${seed}`,
  `--label=F4 wall falsifier ${browser} r${replicate}`,
  `--out=f4-${browser}-r${replicate}.json`,
]
const request = {
  schema: 'snapdom-r10-f4-wall-request-v1',
  browser,
  replicate,
  seed,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
  github: {
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB,
    runnerName: process.env.RUNNER_NAME,
    imageOs: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
  },
  argv: [process.execPath, ...benchArgs.map((x, i) => (
    i === 0 ? path.relative(ROOT, x).replaceAll('\\', '/') : x))],
}
fs.mkdirSync(path.join(LANE, 'requests'), { recursive: true })
fs.writeFileSync(path.join(LANE, 'requests', `f4-${browser}-r${replicate}.json`),
  JSON.stringify(request, null, 2) + '\n')

const child = spawnSync(process.execPath, benchArgs, {
  cwd: ROOT,
  env: {
    ...process.env,
    SNAPDOM_CANDIDATE_GIT_SHA: prepared.candidateGitSha,
    SNAPDOM_BASELINE_GIT_SHA: prepared.candidateGitSha,
    SNAPDOM_BENCH_MANIFEST_SHA256: prepared.policySha256,
  },
  stdio: 'inherit',
})
if (child.error) fail(child.error.message)
process.exit(child.status ?? 1)