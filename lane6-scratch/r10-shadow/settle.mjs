#!/usr/bin/env node
/**
 * Adaptive post-install settle. Waits for the runner to go quiet before the ambient CPU gate looks
 * at it, because `playwright install --with-deps` spikes CPU and disk and a gate that samples
 * straight afterwards blocks for a reason that has nothing to do with the machine being busy.
 *
 * Shape is preregistered in F4_POLICY.json: three consecutive samples one second apart, each at
 * or under 20% utilisation, up to a 30 second ceiling, returning as soon as the window is clean.
 * Utilisation is measured exactly the way lane6-scratch/r5/run-with-timing-gate.mjs measures it —
 * os.cpus tick deltas while this process is otherwise idle — so settle and gate agree about what
 * quiet means instead of each inventing its own scale.
 *
 * Exit 0 settled, exit 3 not settled within the ceiling. Exit 3 is the same class the ambient gate
 * uses, so validate.mjs records both as INCOMPLETE_EVIDENCE: this cell observed nothing, which is
 * a red lane and not a performance statement.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createSettlePlan, evaluateSettle, shouldStop } from './lib/settle.mjs'

const ROOT = process.cwd()
const LANE = path.resolve(ROOT, 'lane6-scratch/r10-shadow')
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}

const policy = JSON.parse(fs.readFileSync(path.join(LANE, 'F4_POLICY.json'), 'utf8'))
const plan = createSettlePlan(policy)
const engine = String(arg('engine', 'chromium')).toLowerCase()
const replicate = arg('replicate', '0')
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

const started = Date.now()
const samples = []
let prev = cpuSnapshot()
let stop = { stop: false, reason: 'STARTED', settled: false }
while (!stop.stop) {
  await sleep(plan.intervalMs)
  const next = cpuSnapshot()
  samples.push(utilization(prev, next))
  prev = next
  stop = shouldStop({ elapsedMs: Date.now() - started, samples, plan })
}

const elapsedMs = Date.now() - started
const verdict = evaluateSettle(samples, plan)
const report = {
  schema: 'snapdom-r10-f4-settle-v1',
  engine,
  replicate,
  runId: process.env.GITHUB_RUN_ID || null,
  attempt: process.env.GITHUB_RUN_ATTEMPT || null,
  host: { platform: os.platform(), logicalCpus: os.cpus().length },
  method: 'os.cpus tick deltas while the settle process is otherwise idle',
  plan,
  samples,
  elapsedMs,
  settled: verdict.settled,
  reason: stop.reason,
  peak: samples.length ? Math.max(...samples) : null,
}
const outDir = path.join(LANE, 'results')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'settle-' + engine + '-r' + replicate + '.json')
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

console.log('settle ' + engine + ' r' + replicate + ' samples=' + samples.map((v) => v.toFixed(1)).join(',') + '%')
console.log('settle ' + (verdict.settled ? 'SETTLED' : 'NOT SETTLED (' + stop.reason + ')')
  + ' peak=' + (report.peak === null ? 'n/a' : report.peak.toFixed(1) + '%')
  + ' elapsed=' + elapsedMs + 'ms artifact=' + path.relative(ROOT, outPath).replaceAll('\\', '/'))
process.exit(verdict.settled ? 0 : 3)