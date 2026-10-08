#!/usr/bin/env node
// Fail-closed R13 real-Worker timing aggregation; one independent point per hosted runner.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const expectedReference = 'ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b'
const source = path.resolve('lane6-scratch/r13/results')
const out = path.join(source, 'summary.json')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const files = []
function walk(directory, depth = 0) {
  if (depth > 3) throw new Error('invalid nested input depth')
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    const p = path.join(directory, dirent.name)
    if (dirent.isDirectory()) walk(p, depth + 1)
    else if (/^runner-r\d+\.json$/.test(dirent.name)) files.push(p)
  }
}
walk(source)
const runnerData = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
const errors = []
if (runnerData.length !== 6) errors.push('require exactly 6 independently measured runners')
const ids = new Set()
let identity = null
const names = ['solo-decode', 'four-way-decode', 'eight-way-decode', 'four-way-full-encode']
const cohort = new Map()
for (const r of runnerData) {
  if (r.schema !== 'snapdom-r13-singleflight-browser-v1') errors.push('runner schema mismatch')
  if (!Number.isInteger(r.replicate) || r.replicate < 0 || r.replicate >= 6 || ids.has(r.replicate)) {
    errors.push('duplicated or unexpected replicate index ' + r.replicate)
  }
  ids.add(r.replicate)
  if (r.repository !== 'thelabcorner/snapdom' || r.baselineSha !== expectedReference ||
      r.measurementSha !== process.env.GITHUB_SHA) {
    errors.push('frozen code identity mismatch at replicate ' + r.replicate)
  }
  const pinned = [r.measurementSha, r.baselineSha, r.referenceWorkerSha256, r.candidateWorkerSha256,
    r.fixtureSha256, r.browserVersion]
  if (pinned.some(v => typeof v !== 'string' || !v)) errors.push('missing source or binary provenance')
  const key = JSON.stringify(pinned)
  if (identity === null) identity = key
  else if (identity !== key) errors.push('source/browser/fixture identity not homogeneous')
  const image = r.runnerImageVersion || 'unknown'
  cohort.set(image, [...(cohort.get(image) || []), r.replicate])
  for (const name of names) {
    const pairs = r.results?.[name]
    if (!Array.isArray(pairs) || pairs.length !== 8) {
      errors.push('missing or truncated paired regime ' + name + ' at runner ' + r.replicate)
      continue
    }
    const expectedCount = name === 'solo-decode' ? 1 : name === 'eight-way-decode' ? 8 : 4
    const orders = new Set()
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i]
      if (!p || !Number.isFinite(p.logRatio) ||
          p.baselineDecodes !== expectedCount || p.candidateDecodes !== 1 ||
          !(p.baselineMs > 0 && p.candidateMs > 0) ||
          Math.abs(p.logRatio - Math.log(p.candidateMs / p.baselineMs)) > 1e-8) {
        errors.push('invalid decode count/timing at ' + name + ' runner ' + r.replicate + ', pair ' + i)
      }
      orders.add(JSON.stringify(p.order))
    }
    if (orders.size !== 2 || pairs.filter(p => p.order[0] === 'baseline').length !== 4 ||
        pairs.filter(p => p.order[0] === 'candidate').length !== 4) {
      errors.push('unbalanced order at ' + name + ' runner ' + r.replicate)
    }
  }
}
if (cohort.size !== 1 || cohort.has('unknown')) errors.push('GitHub runner image identity not homogeneous')
const sampleStat = (values) => {
  const n = values.length
  const avg = values.reduce((a,b) => a+b,0) / n
  const variance = values.reduce((a,b) => a+(b-avg)**2,0) / (n-1)
  const margin = 2.5705818356 * Math.sqrt(variance/n) // Student-t 95%, df=5, six runners
  return { runners:n, pct:(Math.exp(avg)-1)*100, ci95Pct:[(Math.exp(avg-margin)-1)*100,
    (Math.exp(avg+margin)-1)*100], logPoint:avg, significantFaster:avg+margin<0 }
}
const regimes = {}
for (const name of names) {
  if (runnerData.length !== 6 || runnerData.some(r=>!Array.isArray(r.results?.[name]))) continue
  const points = runnerData.map(r=>{
    const pairs = r.results[name]
    const first = pairs.filter(p=>p.order[0]==='baseline')
    const second = pairs.filter(p=>p.order[0]==='candidate')
    const mean = (a)=> a.reduce((s,p)=>s+p.logRatio,0)/a.length
    return 0.5*(mean(first)+mean(second))
  })
  regimes[name] = { ...sampleStat(points), runnerLogPoints: points }
}
const report = {
  schema: 'snapdom-r13-singleflight-summary-v1', state:errors.length?'INCOMPLETE_EVIDENCE':'MEASURED',
  performanceClaim:errors.length===0 && regimes['four-way-full-encode']?.significantFaster===true,
  interpretation:'Exploratory real-Worker microbenchmark only. Not end-to-end capture timing or cross-engine fidelity.',
  expectedRunners:6, discoveredRunners:runnerData.length, replicateIds:[...ids].sort(),
  imageCohorts:Object.fromEntries(cohort), errors, measurementSha:process.env.GITHUB_SHA||null,
  referenceSha:expectedReference, runnerEvidenceSha256:Object.fromEntries(files.map(f=>[
    path.basename(f), sha(fs.readFileSync(f))
  ])), regimes,
}
fs.mkdirSync(path.dirname(out),{recursive:true})
fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
if(errors.length) process.exitCode=1
