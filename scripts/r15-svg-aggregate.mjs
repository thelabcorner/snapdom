// Six independent hosted-VM runner records. Never treat eight within-VM pairs
// as eight independent machines. Fail closed on identity, fidelity, runner image,
// missing arms, malformed routes, or a source mutation.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'

const dir = resolve(process.argv.find((s) => s.startsWith('--dir='))?.slice(6) || 'lane6-scratch/r15/aggregate-input')
const out = resolve(process.argv.find((s) => s.startsWith('--out='))?.slice(6) || 'lane6-scratch/r15/results/summary.json')
const required = ['svg-hot', 'svg-hot-latency', 'html-only', 'svg-proxy-control', 'svg-disabled-control', 'svg-eviction-control']
const median = (x) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)]
const files = []
async function list(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) await list(p)
    else if (/runner-\d+\.json$/.test(entry.name)) files.push(p)
  }
}
await list(dir)
const reports = []
for (const f of files) reports.push(JSON.parse(await readFile(f, 'utf8')))
const failures = []
if (reports.length !== 6) failures.push('expected exactly six original runner records, received ' + reports.length)
const idSet = new Set(reports.map((r) => r.runner))
if (idSet.size !== 6 || [...idSet].some((id) => !Number.isInteger(id) || id < 0 || id > 5))
  failures.push('runner identities are not exactly [0, 1, 2, 3, 4, 5]')
const images = [...new Set(reports.map((r) => r.runnerImage))]
if (images.length !== 1 || !images[0]) failures.push('GitHub runner image is missing or heterogeneous across independent runners')
const baseIds = [...new Set(reports.map((r) => r.baselineGitSha))]
const candIds = [...new Set(reports.map((r) => r.candidateGitSha))]
if (baseIds.length !== 1 || !baseIds[0] || baseIds[0] !== process.env.BASELINE_SHA) failures.push('baseline SHA mismatch')
if (candIds.length !== 1 || !candIds[0] || candIds[0] !== process.env.CANDIDATE_SHA) failures.push('candidate SHA mismatch')

let seed = 0x12345678
function random() {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}
function confidenceInterval(values) {
  if (values.length !== 6) return null
  const draws = []
  for (let i = 0; i < 12000; i++) {
    const xs = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)])
    draws.push(median(xs))
  }
  draws.sort((a, b) => a - b)
  return [draws[Math.floor(draws.length * .025)], draws[Math.floor(draws.length * .975)]]
}
const arms = []
for (const name of required) {
  const samples = []
  for (const r of reports) {
    const scenario = r.scenarios?.find((s) => s.scenario?.name === name)
    if (!scenario) { failures.push('missing ' + name + ' from runner ' + r.runner); continue }
    if (!scenario.rawParity || !scenario.pixelParity) failures.push('fidelity failed: ' + name + ', runner ' + r.runner)
    if (scenario.pairs?.length !== 8) {
      failures.push('expected eight balanced pairs: ' + name + ', runner ' + r.runner)
      continue
    }
    if (scenario.pairs.filter((p) => p.order === 'AB').length !== 4 ||
        scenario.pairs.filter((p) => p.order === 'BA').length !== 4)
      failures.push('AB/BA order imbalance: ' + name + ', runner ' + r.runner)
    const ratios = []
    for (const p of scenario.pairs) {
      if (!Number.isFinite(p.A.ms) || !Number.isFinite(p.B.ms) || p.A.ms <= 0 || p.B.ms <= 0) {
        failures.push('invalid capture timing: ' + name + ', runner ' + r.runner)
        continue
      }
      if (name.startsWith('svg-hot') && (p.A.fetchCalls <= 0 || p.B.fetchCalls !== 0))
        failures.push('hot capture route not proven: ' + name + ', runner ' + r.runner)
      if (name === 'svg-proxy-control' && (p.A.fetchCalls <= 0 || p.B.fetchCalls <= 0))
        failures.push('proxy control route not proven: runner ' + r.runner)
      if (name === 'svg-disabled-control' && (p.A.fetchCalls <= 0 || p.B.fetchCalls <= 0))
        failures.push('disabled cache control route not proven: runner ' + r.runner)
      ratios.push((p.B.ms / p.A.ms - 1) * 100)
    }
    if (ratios.length === 8) samples.push({ runner: r.runner, medianPct: median(ratios) })
  }
  const effects = samples.map((x) => x.medianPct)
  const ci = confidenceInterval(effects)
  arms.push({
    name, runners: samples.length, perRunner: samples,
    medianChangePct: effects.length ? median(effects) : null,
    confidence95Pct: ci,
    significantImprovement: !!ci && ci[1] < 0,
    significantRegression: !!ci && ci[0] > 0
  })
}
const summary = {
  schema: 'snapdom-r15-svg-memo-summary-v1',
  state: failures.length ? 'INCOMPLETE_EVIDENCE' : 'MEASURED_EXPERIMENT',
  performanceClaim: failures.length === 0,
  productionPromotion: false,
  reasonForNoPromotion: 'Process-set/renderer PSS has not been measured for this additional asset-retention path.',
  candidates: { baseline: baseIds, candidate: candIds, images },
  records: files.length,
  failures, arms
}
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
if (failures.length) process.exitCode = 1
