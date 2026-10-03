#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { sha256 } from './asset-bench-lib.mjs'
import { MAX_IMAGE_BLOB_BYTES, WORKER_MIN_PAYLOAD_CHARS } from '../../src/core/cache.js'

const ROOT = process.cwd()
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '='
  const hit = process.argv.find((x) => x.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}
const baselineRel = arg('baseline', 'lane6-scratch/r10/bundles/baseline.mjs')
const candidateRel = arg('candidate', 'lane6-scratch/r10/bundles/candidate.mjs')
const outRel = arg('out', 'lane6-scratch/r10/prepared.json')
const baseline = path.resolve(ROOT, baselineRel)
const candidate = path.resolve(ROOT, candidateRel)
const out = path.resolve(ROOT, outRel)

for (const file of [baseline, candidate]) {
  if (!fs.existsSync(file)) throw new Error('prepared bundle missing: ' + path.relative(ROOT, file))
}

const measurementGitSha = process.env.SNAPDOM_MEASUREMENT_GIT_SHA || process.env.GITHUB_SHA || ''
const candidateGitSha = process.env.SNAPDOM_CANDIDATE_GIT_SHA || ''
const baselineGitSha = process.env.SNAPDOM_BASELINE_GIT_SHA || ''
if (!/^[0-9a-f]{40}$/i.test(measurementGitSha)) throw new Error('exact measurement git SHA missing')
if (!/^[0-9a-f]{40}$/i.test(candidateGitSha)) throw new Error('exact candidate git SHA missing')
if (!/^[0-9a-f]{40}$/i.test(baselineGitSha)) throw new Error('exact baseline git SHA missing')

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version
const measurementFiles = [
  '.github/workflows/r10-asset-bench.yml',
  'lane6-scratch/r5/run-with-timing-gate.mjs',
  'lane6-scratch/r10/prepare.mjs',
  'lane6-scratch/r10/host-settle.mjs',
  'lane6-scratch/r10/assets-bench.mjs',
  'lane6-scratch/r10/asset-bench-lib.mjs',
  'lane6-scratch/r10/asset-aggregate.mjs',
]
const fileIdentity = {}
for (const rel of measurementFiles) {
  const abs = path.resolve(ROOT, rel)
  if (!fs.existsSync(abs)) throw new Error('measurement file missing: ' + rel)
  fileIdentity[rel] = sha256(fs.readFileSync(abs))
}

const doc = {
  schema: 'snapdom-r10-asblob-prepared-v1',
  generatedAt: new Date().toISOString(),
  measurementGitSha,
  candidateGitSha,
  baselineGitSha,
  playwrightVersion,
  nodeVersion: process.version,
  candidate: {
    path: candidateRel.replaceAll('\\', '/'),
    sha256: sha256(fs.readFileSync(candidate)),
    bytes: fs.statSync(candidate).size,
  },
  baseline: {
    path: baselineRel.replaceAll('\\', '/'),
    sha256: sha256(fs.readFileSync(baseline)),
    bytes: fs.statSync(baseline).size,
  },
  mechanism: {
    workerMinPayloadChars: WORKER_MIN_PAYLOAD_CHARS,
    maxImageBlobBytes: MAX_IMAGE_BLOB_BYTES,
    retentionCapStatus: 'HYPOTHESIS',
  },
  measurementFiles: fileIdentity,
  github: {
    repository: process.env.GITHUB_REPOSITORY || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
  },
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, [
    'candidate_bundle_sha256=' + doc.candidate.sha256,
    'baseline_bundle_sha256=' + doc.baseline.sha256,
    'playwright_version=' + doc.playwrightVersion,
  ].join('\n') + '\n')
}
console.log(JSON.stringify(doc, null, 2))
