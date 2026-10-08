// R17 runner-level estimates. Evidence is rejected on absent/partial/mismatched runs.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(process.argv[2] || 'r17-evidence')
const expectedBaseline = 'ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b'
const names = ['mixed-straggler', 'html-straggler', 'svg-straggler', 'mixed-fast', 'mixed-small', 'inline-control']
const byName = new Map(names.map(name => [name, []]))
const average = values => values.reduce((a, b) => a + b, 0) / values.length
let candidate = null
const all = []
for (let i = 1; i <= 6; i++) {
  const raw = await readFile(resolve(root, 'runner-' + i + '.json'), 'utf8')
  const report = JSON.parse(raw)
  if (report.schema !== 'snapdom-r17-queue-paired-v1' || report.runner !== i ||
      report.baselineSha !== expectedBaseline || !report.candidateSha ||
      (candidate && report.candidateSha !== candidate)) {
    throw Error('R17 provenance mismatch on runner ' + i)
  }
  candidate = report.candidateSha
  if (!Array.isArray(report.scenarios) || report.scenarios.length !== names.length) {
    throw Error('R17 scenario count mismatch on runner ' + i)
  }
  for (let j = 0; j < names.length; j++) {
    const scenario = report.scenarios[j]
    if (scenario.scenario?.name !== names[j] || scenario.exactRaw !== true ||
        scenario.exactPixels !== true || scenario.pairs?.length !== 8) {
      throw Error('R17 incomplete fidelity evidence: ' + names[j] + ' runner ' + i)
    }
    const order = scenario.pairs.map(p => p.order)
    if (order.filter(x => x === 'AB').length !== 4 || order.filter(x => x === 'BA').length !== 4) {
      throw Error('R17 unbalanced measurement sequence: ' + names[j])
    }
    const logRatios = scenario.pairs.map(p => {
      if (!(p.A.ms > 0 && p.B.ms > 0 && /^[a-f0-9]{64}$/.test(p.rawSha256))) {
        throw Error('R17 invalid timing/hash evidence')
      }
      if (p.A.maxFlight > 6 || p.B.maxFlight > 6) throw Error('R17 request ceiling violated')
      return Math.log(p.B.ms / p.A.ms)
    })
    byName.get(names[j]).push({ runner: i, logRatio: average(logRatios),
      baselineMs: average(scenario.pairs.map(p => p.A.ms)),
      candidateMs: average(scenario.pairs.map(p => p.B.ms)) })
  }
  all.push({ runner: i, runnerImage: report.runnerImage || null })
}
let rng = 0x173a2026
const random = () => ((rng = (Math.imul(1664525, rng) + 1013904223) >>> 0) / 2 ** 32)
const out = {}
for (const [name, data] of byName) {
  const logs = data.map(x => x.logRatio)
  const samples = []
  for (let b = 0; b < 10000; b++) {
    const picked = []
    for (let j = 0; j < logs.length; j++) picked.push(logs[Math.floor(random() * logs.length)])
    samples.push(100 * (Math.exp(average(picked)) - 1))
  }
  samples.sort((a, b) => a - b)
  const point = 100 * (Math.exp(average(logs)) - 1)
  const ci = [samples[Math.floor(samples.length * 0.025)], samples[Math.floor(samples.length * 0.975)]]
  out[name] = {
    percentChange: point, ci95RunnerBootstrap: ci,
    baselineMeanMs: average(data.map(d => d.baselineMs)),
    candidateMeanMs: average(data.map(d => d.candidateMs)),
    confidentGain: ci[1] < 0, confidentRegression: ci[0] > 0,
    perRunner: data
  }
  console.log(JSON.stringify({ scenario: name, percentChange: point, ci95: ci,
    baselineMeanMs: out[name].baselineMeanMs, candidateMeanMs: out[name].candidateMeanMs }))
}
const summary = { schema: 'snapdom-r17-aggregated-v1', verdict: 'FIDELITY_OK_TIMING_MEASURED_NOT_PROMOTED',
  candidate, baseline: expectedBaseline, sixIndependentRunners: all,
  pairsPerScenario: 48, scenarios: out }
await writeFile(resolve(root, 'summary.json'), JSON.stringify(summary, null, 2))
