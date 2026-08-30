import fs from 'node:fs'

function arg(name, fallback = undefined) {
  const prefix = `--${name}=`
  const hit = process.argv.find((value) => value.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

function numeric(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function extractBenchmarks(json, source) {
  const found = new Map()
  const seen = new WeakSet()

  function walk(value, path = []) {
    if (!value || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)

    const hz = numeric(value.hz)
    if (typeof value.name === 'string' && hz && hz > 0) {
      const name = value.name
      if (found.has(name)) {
        throw new Error(`Duplicate benchmark name ${JSON.stringify(name)} in ${source}. Benchmark names must be unique.`)
      }
      found.set(name, {
        name,
        hz,
        mean: numeric(value.mean),
        rme: numeric(value.rme),
        samples: Array.isArray(value.samples) ? value.samples.length : numeric(value.samples),
        path: path.join('.'),
      })
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)]))
      return
    }

    for (const [key, child] of Object.entries(value)) {
      walk(child, [...path, key])
    }
  }

  walk(json)
  if (!found.size) {
    throw new Error(`No benchmark records with numeric hz fields were found in ${source}`)
  }
  return found
}

function loadRound(path) {
  return extractBenchmarks(JSON.parse(fs.readFileSync(path, 'utf8')), path)
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function mad(values) {
  const m = median(values)
  return median(values.map((value) => Math.abs(value - m)))
}

function fmtPct(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtHz(value) {
  if (value >= 1000) return `${value.toFixed(0)} ops/s`
  if (value >= 10) return `${value.toFixed(1)} ops/s`
  return `${value.toFixed(3)} ops/s`
}

const baselinePaths = (arg('baseline') || '').split(',').filter(Boolean)
const candidatePaths = (arg('candidate') || '').split(',').filter(Boolean)
const requireGain = arg('require-gain', 'false') === 'true'

if (!baselinePaths.length || baselinePaths.length !== candidatePaths.length) {
  throw new Error('Pass equal non-empty comma-separated --baseline=... and --candidate=... lists')
}

const baselines = baselinePaths.map(loadRound)
const candidates = candidatePaths.map(loadRound)
const names = [...baselines[0].keys()].filter((name) => candidates[0].has(name)).sort()

if (!names.length) throw new Error('Baseline and candidate have no common benchmarks')

for (let round = 0; round < baselines.length; round++) {
  for (const name of names) {
    if (!baselines[round].has(name) || !candidates[round].has(name)) {
      throw new Error(`Benchmark ${JSON.stringify(name)} is missing from paired round ${round + 1}`)
    }
  }
}

const rows = names.map((name) => {
  const pairRatios = baselines.map((base, index) => candidates[index].get(name).hz / base.get(name).hz)
  const pairGains = pairRatios.map((ratio) => (ratio - 1) * 100)
  const baselineHz = median(baselines.map((run) => run.get(name).hz))
  const candidateHz = median(candidates.map((run) => run.get(name).hz))
  return {
    name,
    baselineHz,
    candidateHz,
    pairRatios,
    pairGains,
    gain: (median(pairRatios) - 1) * 100,
    mad: mad(pairGains),
    positivePairs: pairRatios.filter((ratio) => ratio > 1).length,
  }
})

const aggregateRatio = Math.exp(rows.reduce((sum, row) => sum + Math.log(1 + row.gain / 100), 0) / rows.length)
const aggregateGain = (aggregateRatio - 1) * 100
const best = [...rows].sort((a, b) => b.gain - a.gain)[0]
const worst = [...rows].sort((a, b) => a.gain - b.gain)[0]

const lines = []
lines.push('# Optimization benchmark comparison')
lines.push('')
lines.push(`Paired rounds: ${baselines.length}`)
lines.push(`Aggregate geometric-mean throughput: ${fmtPct(aggregateGain)}`)
lines.push('')
lines.push('| Benchmark | Baseline | Candidate | Median gain | Pair wins | Pair MAD |')
lines.push('|---|---:|---:|---:|---:|---:|')
for (const row of [...rows].sort((a, b) => b.gain - a.gain)) {
  lines.push(`| ${row.name} | ${fmtHz(row.baselineHz)} | ${fmtHz(row.candidateHz)} | ${fmtPct(row.gain)} | ${row.positivePairs}/${baselines.length} | ${row.mad.toFixed(2)} pp |`)
}

let accepted = true
let reason = 'measurement-only commit; runtime gain gate not required'

if (requireGain) {
  const bestRobust = best.gain >= 0.75 && best.positivePairs >= Math.ceil(baselines.length * 2 / 3) && best.gain > best.mad
  const aggregatePositive = aggregateGain >= 0.20
  const regressionBounded = worst.gain >= -2.50
  accepted = bestRobust && aggregatePositive && regressionBounded
  reason = accepted
    ? `accepted: best=${fmtPct(best.gain)}, aggregate=${fmtPct(aggregateGain)}, worst=${fmtPct(worst.gain)}`
    : `rejected: best=${fmtPct(best.gain)} (${best.positivePairs}/${baselines.length} pair wins, MAD ${best.mad.toFixed(2)} pp), aggregate=${fmtPct(aggregateGain)}, worst=${fmtPct(worst.gain)}`
}

lines.push('')
lines.push(`**Scientist gate:** ${accepted ? 'ACCEPT' : 'REJECT'} — ${reason}`)

const report = `${lines.join('\n')}\n`
console.log(report)

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
}

const output = arg('json')
if (output) {
  fs.writeFileSync(output, JSON.stringify({ accepted, reason, aggregateGain, best, worst, rows }, null, 2))
}

if (!accepted) process.exitCode = 1
