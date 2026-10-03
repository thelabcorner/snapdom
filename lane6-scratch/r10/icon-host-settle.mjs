#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.error('R10 icon ceiling settle is GitHub-Actions-only')
  process.exit(1)
}

const cfg = Object.freeze({
  intervalMs: 1000,
  maxWaitMs: 30000,
  consecutive: 3,
  maxCpuPercent: 20,
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function snapshot() {
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

const samples = []
let quiet = 0
let elapsed = 0
let prev = snapshot()
while (elapsed < cfg.maxWaitMs && quiet < cfg.consecutive) {
  await sleep(cfg.intervalMs)
  elapsed += cfg.intervalMs
  const next = snapshot()
  const cpu = utilization(prev, next)
  prev = next
  samples.push(cpu)
  quiet = cpu <= cfg.maxCpuPercent ? quiet + 1 : 0
}

const pass = quiet >= cfg.consecutive
const report = {
  schema: 'snapdom-r10-icon-host-settle-v1',
  generatedAt: new Date().toISOString(),
  policy: cfg,
  host: { platform: os.platform(), release: os.release(), logicalCpus: os.cpus().length },
  samples,
  elapsedMs: elapsed,
  terminalQuietWindows: quiet,
  pass,
  github: {
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
    runnerName: process.env.RUNNER_NAME || null,
  },
}

const out = path.resolve(process.cwd(), 'lane6-scratch/r10/icon-host-settle.json')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
console.log('R10 icon post-install settle CPU: ' + samples.map((x) => x.toFixed(1)).join(', ') + '%')
console.log('quiet=' + quiet + '/' + cfg.consecutive + ' elapsed=' + elapsed + 'ms => ' + (pass ? 'SETTLED' : 'BLOCK'))
if (!pass) process.exitCode = 3
