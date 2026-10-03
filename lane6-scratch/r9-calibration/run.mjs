#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = process.cwd()
const CAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration')
const PREP = path.join(CAL, 'prepared.json')
const BUNDLE = path.join(CAL, 'bundle/candidate.mjs')
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const fail = (m) => { console.error('R9 calibration run refused:', m); process.exit(1) }
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()

if (process.env.GITHUB_ACTIONS !== 'true') fail('browser calibration is GitHub-Actions-only')
if (!fs.existsSync(PREP) || !fs.existsSync(BUNDLE)) fail('prepared evidence/bundle missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
if (prepared.schema !== 'snapdom-r9-hosted-calibration-prepared-v1') fail('prepared schema mismatch')
if (process.env.GITHUB_REPOSITORY !== policy.repository) fail('repository mismatch')
if (!process.env.GITHUB_RUN_ID || !process.env.GITHUB_JOB || !process.env.RUNNER_NAME) fail('GitHub hosted provenance incomplete')
if (process.env.RUNNER_OS !== 'Linux') fail('calibration requires Linux GitHub-hosted runner')
if (!process.env.ImageOS || !process.env.ImageVersion) fail('runner image provenance missing')
if (shaFile(path.join(CAL, 'POLICY.json')) !== prepared.policySha256) fail('policy drift')
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
if (!['chromium','firefox','webkit'].includes(browser)) fail('invalid browser')
if (!Number.isInteger(replicate) || replicate < 0 || replicate >= policy.replicates[browser]) fail('replicate outside policy')

const engineOffset = {chromium: 0, firefox: 1000003, webkit: 2000003}[browser]
const seed = (policy.sampling.baseSeed + engineOffset + replicate * 104729) >>> 0
const outName = `calibration-${browser}-r${replicate}.json`
const d = policy.diagnosticOnly
const s = policy.sampling
const benchArgs = [
  path.resolve(ROOT, 'lane6-scratch/r9/bench-r9-controlled.mjs'),
  '--mode=option-pair',
  `--suite=${policy.suite}`,
  `--baseline=${path.relative(ROOT, BUNDLE).replaceAll('\\\\','/')}`,
  `--candidate=${path.relative(ROOT, BUNDLE).replaceAll('\\\\','/')}`,
  '--base={}',
  '--opt={}',
  `--browser=${browser}`,
  `--n=${s.n}`,
  `--batch=${s.batch}`,
  `--warmup=${s.warmup}`,
  `--bootstrap=${s.bootstrap}`,
  `--epsilon=${d.epsilon}`,
  `--control-band=${d.controlBand}`,
  `--noop-band=${d.equivalenceBand}`,
  `--max-pair-log-sd=${d.maxPairLogSd}`,
  `--seed=${seed}`,
  '--expect=equivalence',
  `--playwright-version=${policy.playwrightVersion}`,
  `--only=${policy.fixtures.join(',')}`,
  `--label=R9 hosted calibration ${browser} r${replicate}`,
  `--out=${outName}`,
]
const request = {
  schema: 'snapdom-r9-hosted-calibration-request-v1',
  browser, replicate, seed,
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
  argv: [process.execPath, ...benchArgs.map((x, i) => i === 0 ? path.relative(ROOT, x).replaceAll('\\\\','/') : x)],
}
fs.mkdirSync(path.join(CAL, 'requests'), {recursive:true})
fs.writeFileSync(path.join(CAL, 'requests', `calibration-${browser}-r${replicate}.json`), JSON.stringify(request, null, 2) + '\n')

const child = spawnSync(process.execPath, benchArgs, {
  cwd: ROOT,
  env: {
    ...process.env,
    SNAPDOM_BENCH_MANIFEST_SHA256: prepared.policySha256,
    SNAPDOM_CANDIDATE_GIT_SHA: prepared.candidateGitSha,
    SNAPDOM_BASELINE_GIT_SHA: prepared.candidateGitSha,
  },
  stdio: 'inherit',
})
if (child.error) fail(child.error.message)
process.exit(child.status ?? 1)
