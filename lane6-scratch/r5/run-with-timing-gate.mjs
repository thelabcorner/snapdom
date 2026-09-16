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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

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
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const mid = sorted.length >> 1
  const median = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { mean, median, min: sorted[0], max: sorted.at(-1) }
}

const values = []
let prev = cpuSnapshot()
for (let i = 0; i < SAMPLES; i++) {
  await sleep(INTERVAL_MS)
  const next = cpuSnapshot()
  values.push(utilization(prev, next))
  prev = next
}
const summary = stats(values)
const pass = summary.median <= MAX_MEDIAN && summary.mean <= MAX_MEAN && summary.max <= MAX_PEAK
const report = {
  generatedAt: new Date().toISOString(),
  host: { platform: os.platform(), release: os.release(), logicalCpus: os.cpus().length },
  method: 'os.cpus tick deltas while gate process is otherwise idle',
  thresholds: { median: MAX_MEDIAN, mean: MAX_MEAN, max: MAX_PEAK },
  samples: values,
  summary,
  pass,
  command,
}
const outDir = path.join(ROOT, 'lane6-scratch/r5/results')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'timing-environment-latest.json'), JSON.stringify(report, null, 2))
console.log(`ambient CPU: ${values.map((x) => x.toFixed(1)).join(', ')}%`)
console.log(`mean=${summary.mean.toFixed(1)}% median=${summary.median.toFixed(1)}% peak=${summary.max.toFixed(1)}% => ${pass ? 'PASS' : 'BLOCK'}`)

if (!pass) {
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
