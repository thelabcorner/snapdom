#!/usr/bin/env node
// Adaptive post-setup settle gate for R9 hosted calibration.
//
// Browser installation can leave short-lived package-manager / decompression work behind.
// Sampling the scientific ambient gate immediately after install mistakes that related setup
// tail for unrelated runner contention. This phase waits for a preregistered run of quiet
// windows, then exits. Persistent activity still fails closed at maxWaitMs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const CAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration')
const policy = JSON.parse(fs.readFileSync(path.join(CAL, 'POLICY.json'), 'utf8'))
const cfg = policy.settle

const fail = (message) => {
  console.error(`R9 calibration settle refused: ${message}`)
  process.exit(1)
}
if (process.env.GITHUB_ACTIONS !== 'true') fail('GitHub-Actions-only')
if (!cfg || !Number.isInteger(cfg.intervalMs) || !Number.isInteger(cfg.maxWaitMs) ||
    !Number.isInteger(cfg.consecutive) || !Number.isFinite(cfg.maxCpuPercent)) {
  fail('invalid settle policy')
}
if (cfg.intervalMs < 250 || cfg.maxWaitMs < cfg.intervalMs ||
    cfg.consecutive < 1 || cfg.maxCpuPercent < 0 || cfg.maxCpuPercent > 100) {
  fail('settle policy out of range')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function snapshot() {
  let idle = 0, total = 0
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

const values = []
let quiet = 0
let elapsed = 0
let prev = snapshot()
while (elapsed < cfg.maxWaitMs && quiet < cfg.consecutive) {
  await sleep(cfg.intervalMs)
  elapsed += cfg.intervalMs
  const next = snapshot()
  const cpu = utilization(prev, next)
  prev = next
  values.push(cpu)
  quiet = cpu <= cfg.maxCpuPercent ? quiet + 1 : 0
}
const pass = quiet >= cfg.consecutive
const report = {
  schema: 'snapdom-r9-hosted-calibration-settle-v1',
  generatedAt: new Date().toISOString(),
  host: { platform: os.platform(), release: os.release(), logicalCpus: os.cpus().length },
  policy: cfg,
  samples: values,
  elapsedMs: elapsed,
  terminalQuietWindows: quiet,
  pass,
}
const outDir = path.join(CAL, 'settle')
fs.mkdirSync(outDir, { recursive: true })
const browser = process.env.SNAPDOM_CAL_BROWSER || 'unknown'
const replicate = process.env.SNAPDOM_CAL_REPLICATE || 'unknown'
const out = path.join(outDir, `settle-${browser}-r${replicate}.json`)
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')

console.log(`post-install settle CPU: ${values.map((x) => x.toFixed(1)).join(', ')}%`)
console.log(`quiet=${quiet}/${cfg.consecutive} elapsed=${elapsed}ms => ${pass ? 'SETTLED' : 'BLOCK'}`)
if (!pass) {
  console.error(`settle blocked: no ${cfg.consecutive} consecutive <=${cfg.maxCpuPercent}% windows within ${cfg.maxWaitMs}ms`)
  process.exitCode = 3
}
