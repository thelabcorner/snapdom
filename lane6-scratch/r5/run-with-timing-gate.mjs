#!/usr/bin/env node
// Ambient CPU gate for SnapDOM decision-quality timing.
//
// Usage:
//   node lane6-scratch/r5/run-with-timing-gate.mjs -- node <benchmark.mjs> [...args]
//   node lane6-scratch/r5/run-with-timing-gate.mjs          # gate-only diagnostic
//
// This is intentionally stricter than the benchmark's own CoV/null-control gates. It measures
// host CPU while this process is idle and refuses to launch timing if unrelated work already
// occupies a meaningful fraction of the machine.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const split = argv.indexOf('--')
const gateArgs = split >= 0 ? argv.slice(0, split) : argv
const command = split >= 0 ? argv.slice(split + 1) : []
const arg = (name, fallback) => {
  const prefix = `--${name}=`
  const hit = gateArgs.find((x) => x.startsWith(prefix))
  return hit ? Number(hit.slice(prefix.length)) : fallback
}

const SAMPLES = Math.max(3, Math.floor(arg('samples', 8)))
const INTERVAL_MS = Math.max(250, Math.floor(arg('interval-ms', 1000)))
const MAX_MEDIAN = arg('median', 10)
const MAX_MEAN = arg('mean', 12)
const MAX_PEAK = arg('max', 20)

// Adaptive post-setup settle. Browser installation/unpack left 25-27% CPU tail in the first
// hosted calibration attempt; the ordinary gate must not sample until related setup work is quiet.
const SETTLE_INTERVAL_MS = Math.max(250, Math.floor(arg('settle-interval-ms', 1000)))
const SETTLE_MAX_WAIT_MS = Math.max(SETTLE_INTERVAL_MS, Math.floor(arg('settle-max-wait-ms', 30000)))
const SETTLE_CONSECUTIVE = Math.max(1, Math.floor(arg('settle-consecutive', 3)))
const SETTLE_MAX_CPU = arg('settle-max-cpu', 20)

for (const [name, value] of Object.entries({ MAX_MEDIAN, MAX_MEAN, MAX_PEAK, SETTLE_MAX_CPU })) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.error(`timing gate refused invalid ${name}=${value}`)
    process.exit(2)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function cpuSnapshot() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}
function utilization(a, b) {
  const total = b.total - a.total
  const idle = b.idle - a.idle
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0
}
function stats(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const mid = sorted.length >> 1
  const median = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { mean, median, min: sorted[0], max: sorted.at(-1) }
}
async function collectWindow(intervalMs) {
  const before = cpuSnapshot()
  await sleep(intervalMs)
  return utilization(before, cpuSnapshot())
}

// Stage 1: a high window resets the quiet streak. Persistent activity fails closed at the deadline.
const settleValues = []
let settleQuiet = 0
let settleElapsedMs = 0
while (settleElapsedMs < SETTLE_MAX_WAIT_MS && settleQuiet < SETTLE_CONSECUTIVE) {
  const value = await collectWindow(SETTLE_INTERVAL_MS)
  settleValues.push(value)
  settleElapsedMs += SETTLE_INTERVAL_MS
  settleQuiet = value <= SETTLE_MAX_CPU ? settleQuiet + 1 : 0
}
const settlePass = settleQuiet >= SETTLE_CONSECUTIVE

// Stage 2: the ordinary decision gate starts only after the host has demonstrably settled.
const values = []
if (settlePass) {
  for (let i = 0; i < SAMPLES; i++) values.push(await collectWindow(INTERVAL_MS))
}
const summary = stats(values)
const ambientPass = !!summary &&
  summary.median <= MAX_MEDIAN &&
  summary.mean <= MAX_MEAN &&
  summary.max <= MAX_PEAK
const pass = settlePass && ambientPass
const report = {
  schema: 'snapdom-r9-timing-gate-v1',
  generatedAt: new Date().toISOString(),
  scriptSha256: sha256File(fileURLToPath(import.meta.url)),
  host: { platform: os.platform(), release: os.release(), logicalCpus: os.cpus().length },
  hosted: {
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
    runnerName: process.env.RUNNER_NAME || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    workflowRef: process.env.GITHUB_WORKFLOW_REF || null,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
  },
  method: 'adaptive quiet-settle then os.cpus tick deltas while gate process is otherwise idle',
  settle: {
    thresholds: {
      intervalMs: SETTLE_INTERVAL_MS,
      maxWaitMs: SETTLE_MAX_WAIT_MS,
      consecutive: SETTLE_CONSECUTIVE,
      maxCpuPercent: SETTLE_MAX_CPU,
    },
    samples: settleValues,
    elapsedMs: settleElapsedMs,
    terminalQuietWindows: settleQuiet,
    pass: settlePass,
  },
  sampling: { samples: SAMPLES, intervalMs: INTERVAL_MS },
  thresholds: { median: MAX_MEDIAN, mean: MAX_MEAN, max: MAX_PEAK },
  samples: values,
  summary,
  pass,
  command,
}
const outDir = path.join(ROOT, 'lane6-scratch/r5/results')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'timing-environment-latest.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`settle CPU: ${settleValues.map((x) => x.toFixed(1)).join(', ')}%`)
console.log(`settle quiet=${settleQuiet}/${SETTLE_CONSECUTIVE} elapsed=${settleElapsedMs}ms => ${settlePass ? 'SETTLED' : 'BLOCK'}`)
if (summary) {
  console.log(`ambient CPU: ${values.map((x) => x.toFixed(1)).join(', ')}%`)
  console.log(`mean=${summary.mean.toFixed(1)}% median=${summary.median.toFixed(1)}% peak=${summary.max.toFixed(1)}% => ${ambientPass ? 'PASS' : 'BLOCK'}`)
}

if (!settlePass) {
  console.error(`timing blocked: no ${SETTLE_CONSECUTIVE} consecutive <=${SETTLE_MAX_CPU}% CPU windows within ${SETTLE_MAX_WAIT_MS}ms`)
  process.exitCode = 3
} else if (!ambientPass) {
  console.error(`timing blocked: require median<=${MAX_MEDIAN}%, mean<=${MAX_MEAN}%, peak<=${MAX_PEAK}%`)
  process.exitCode = 3
} else if (command.length) {
  const child = spawn(command[0], command.slice(1), { cwd: ROOT, stdio: 'inherit', shell: false })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
  })
  process.exitCode = code
}
