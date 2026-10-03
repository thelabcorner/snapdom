import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'

export function arg(name, fallback = undefined) {
  const prefix = `--${name}=`
  const hit = process.argv.find((value) => value.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

export function numberArg(name, fallback) {
  const value = Number(arg(name, fallback))
  if (!Number.isFinite(value)) throw new Error(`invalid --${name}`)
  return value
}

export function parseExtra(raw) {
  if (!raw) return {}
  if (raw.startsWith('{')) return JSON.parse(raw)
  const out = {}
  for (const pair of raw.split(',')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) throw new Error(`bad flag pair ${pair}`)
    const key = pair.slice(0, eq)
    const val = pair.slice(eq + 1)
    out[key] = val === 'true' ? true
      : val === 'false' ? false
        : val === 'null' ? null
          : val === 'undefined' ? undefined
            : Number.isNaN(Number(val)) || val === '' ? val : Number(val)
  }
  return out
}

export function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase()
}

export function sha256File(path) {
  return sha256Buffer(fs.readFileSync(path))
}

export function sha256Text(value) {
  return sha256Buffer(Buffer.from(value))
}

export function assertHostedBrowser() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error(
      'R9 browser benchmarks are GitHub-Actions-only. ' +
      'Local browser execution is intentionally blocked by protocol.'
    )
  }
}

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

export function stats(xs) {
  if (!xs.length) return { mean: NaN, median: NaN, sd: NaN, cov: NaN, n: 0 }
  const m = mean(xs)
  const sd = xs.length > 1
    ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
    : 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length & 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
  return { mean: m, median, sd, cov: m ? sd / m : 0, n: xs.length }
}

export function rng(seed) {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}

export const pctFromLog = (logRatio) => (Math.exp(logRatio) - 1) * 100

export function crossoverEffect(forwardRows, reverseRows, seed, bootstrap = 12000) {
  if (forwardRows.length !== reverseRows.length || !forwardRows.length) {
    throw new Error('crossover rows must be non-empty and index-aligned')
  }
  const forward = forwardRows.map((row) => Math.log(row.slot2 / row.slot1))
  const reverse = reverseRows.map((row) => Math.log(row.slot1 / row.slot2))
  // Each index is one acquisition block. The forward and reverse layouts for that index are
  // measured in the same interleaved round by bench-r9-controlled.mjs, so collapse them into
  // one symmetric crossover effect BEFORE resampling. This preserves common-mode runner drift
  // instead of independently bootstrapping temporally paired observations.
  const blocks = forward.map((value, i) => (value + reverse[i]) / 2)
  const logPoint = mean(blocks)
  const random = rng(seed)
  const draws = new Array(bootstrap)
  for (let i = 0; i < bootstrap; i++) {
    let total = 0
    for (let j = 0; j < blocks.length; j++) total += blocks[(random() * blocks.length) | 0]
    draws[i] = total / blocks.length
  }
  draws.sort((a, b) => a - b)
  const lo = draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.025))]
  const hi = draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.975))]
  return {
    logPoint,
    pct: pctFromLog(logPoint),
    ci95: [pctFromLog(lo), pctFromLog(hi)],
    logRatios: { forward, reverse, blocks },
  }
}

export function ciWithin(ci95, bandFraction) {
  const band = Math.abs(bandFraction) * 100
  return ci95[0] >= -band && ci95[1] <= band
}

export function ciSpansZero(ci95) {
  return ci95[0] <= 0 && ci95[1] >= 0
}

export function hostedProvenance(extra = {}) {
  const cpus = os.cpus()
  return {
    generatedAt: new Date().toISOString(),
    github: {
      actions: process.env.GITHUB_ACTIONS === 'true',
      repository: process.env.GITHUB_REPOSITORY || null,
      workflow: process.env.GITHUB_WORKFLOW || null,
      workflowRef: process.env.GITHUB_WORKFLOW_REF || null,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA || null,
      runId: process.env.GITHUB_RUN_ID || null,
      runNumber: process.env.GITHUB_RUN_NUMBER || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      eventName: process.env.GITHUB_EVENT_NAME || null,
      sha: process.env.GITHUB_SHA || null,
      ref: process.env.GITHUB_REF || null,
      headRef: process.env.GITHUB_HEAD_REF || null,
      baseRef: process.env.GITHUB_BASE_REF || null,
      actor: process.env.GITHUB_ACTOR || null,
    },
    runner: {
      os: process.env.RUNNER_OS || os.platform(),
      arch: process.env.RUNNER_ARCH || os.arch(),
      name: process.env.RUNNER_NAME || null,
      imageOs: process.env.ImageOS || null,
      imageVersion: process.env.ImageVersion || null,
      platform: os.platform(),
      release: os.release(),
      logicalCpus: cpus.length,
      cpuModel: cpus[0]?.model || null,
    },
    node: {
      version: process.version,
      v8: process.versions.v8,
    },
    ...extra,
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + stableJson(value[key])
    ).join(',') + '}'
  }
  return JSON.stringify(value)
}
