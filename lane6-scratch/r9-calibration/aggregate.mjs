#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const CAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration')
const PREP = path.join(CAL, 'prepared.json')
const arg = (name, fallback='') => {
  const p = `--${name}=`; const hit = process.argv.find((x)=>x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const INPUT = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r9-calibration/aggregate-input'))
const OUT = path.resolve(ROOT, arg('out', 'lane6-scratch/r9-calibration/calibration-summary.json'))
const mean = (xs) => xs.reduce((a,b)=>a+b,0)/xs.length
const variance = (xs) => {
  if (xs.length < 2) return NaN
  const m=mean(xs); return xs.reduce((a,b)=>a+(b-m)**2,0)/(xs.length-1)
}
const t975 = (df) => {
  const table = {1:12.706,2:4.303,3:3.182,4:2.776,5:2.571,6:2.447,7:2.365,8:2.306,9:2.262,10:2.228,11:2.201,12:2.179,13:2.160,14:2.145,15:2.131,16:2.120,17:2.110,18:2.101,19:2.093,20:2.086,21:2.080,22:2.074,23:2.069,24:2.064,25:2.060,26:2.056,27:2.052,28:2.048,29:2.045,30:2.042}
  return table[Math.min(30, Math.max(1, df))] ?? 1.96
}
const pct = (x) => (Math.exp(x)-1)*100
const ci = (xs) => {
  const m=mean(xs), sd=Math.sqrt(variance(xs)), se=sd/Math.sqrt(xs.length), h=t975(xs.length-1)*se
  return {logPoint:m,pct:pct(m),runnerSdLog:sd,seLog:se,ci95:[pct(m-h),pct(m+h)],logCi95:[m-h,m+h]}
}
function walk(dir, out=[]) {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir,{withFileTypes:true})) {
    const p=path.join(dir,ent.name)
    if (ent.isDirectory()) walk(p,out)
    else if (ent.isFile() && /^calibration-(chromium|firefox|webkit)-r\d+\.json$/.test(ent.name) && p.includes('decisions')) out.push(p)
  }
  return out
}
const appendSummary = (s) => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,s) }

if (!fs.existsSync(PREP)) throw new Error('prepared.json missing')
const prepared=JSON.parse(fs.readFileSync(PREP,'utf8'))
const policy=prepared.policy
const files=walk(INPUT)
const docs=[]
for (const p of files) {
  try {
    const d=JSON.parse(fs.readFileSync(p,'utf8'))
    if (d.schema==='snapdom-r9-hosted-calibration-decision-v1') docs.push({path:p,value:d})
  } catch {}
}

const expected=[]
for (const engine of ['chromium','firefox','webkit']) {
  for (let r=0;r<policy.replicates[engine];r++) expected.push(`${engine}:${r}`)
}
const byKey=new Map()
const duplicate=[]
for (const item of docs) {
  const d=item.value, key=`${d.browser}:${d.replicate}`
  if (byKey.has(key)) duplicate.push(key)
  else byKey.set(key,item)
}
const missing=expected.filter((k)=>!byKey.has(k))
const unusable=expected.filter((k)=>byKey.has(k) && (byKey.get(k).value.state!=='CALIBRATION_SAMPLE' || byKey.get(k).value.usable!==true))
const wrongIdentity=expected.filter((k)=>{
  const d=byKey.get(k)?.value
  return d && (d.policySha256!==prepared.policySha256 || d.candidateGitSha!==prepared.candidateGitSha || d.bundleSha256!==prepared.bundle.sha256)
})

if (duplicate.length || missing.length || unusable.length || wrongIdentity.length) {
  const summary={
    schema:'snapdom-r9-hosted-calibration-summary-v1', state:'INCOMPLETE_EVIDENCE', complete:false,
    generatedAt:new Date().toISOString(), policySha256:prepared.policySha256, candidateGitSha:prepared.candidateGitSha,
    expectedSamples:expected.length, discoveredSamples:docs.length, duplicate, missing, unusable, wrongIdentity,
    performanceClaim:false,
  }
  fs.mkdirSync(path.dirname(OUT),{recursive:true}); fs.writeFileSync(OUT,JSON.stringify(summary,null,2)+'\n')
  appendSummary(`### snapDOM R9 hosted calibration\n\n**INCOMPLETE_EVIDENCE** — no performance claim.\n\n- expected samples: ${expected.length}\n- discovered: ${docs.length}\n- missing: ${missing.join(', ')||'none'}\n- unusable: ${unusable.join(', ')||'none'}\n\n`)
  console.error(JSON.stringify(summary,null,2)); process.exit(1)
}

const result={}
for (const engine of ['chromium','firefox','webkit']) {
  const samples=expected.filter((k)=>k.startsWith(engine+':')).map((k)=>byKey.get(k).value)
  const fixtures={}
  for (const name of policy.fixtures) {
    const points=samples.map((d)=>d.fixtures[name].candidate.logPoint)
    const baseNull=samples.map((d)=>d.fixtures[name].baseNull.logPoint)
    const optNull=samples.map((d)=>d.fixtures[name].optNull.logPoint)
    const slot=samples.map((d)=>d.fixtures[name].slotInteraction)
    const withinVars=samples.map((d)=>d.fixtures[name].withinSe**2)
    const runnerVar=variance(points)
    const tau2=Math.max(0, runnerVar-mean(withinVars))
    const weights=withinVars.map((v)=>1/Math.max(v,1e-12))
    const wsum=weights.reduce((a,b)=>a+b,0)
    const fixed=points.reduce((a,x,i)=>a+x*weights[i],0)/wsum
    const Q=points.reduce((a,x,i)=>a+weights[i]*(x-fixed)**2,0)
    const df=points.length-1
    const I2=Q>0?Math.max(0,(Q-df)/Q):0
    const effect=ci(points), bnull=ci(baseNull), onull=ci(optNull), sint=ci(slot)
    fixtures[name]={
      effect,
      baseNull:bnull,
      optNull:onull,
      slotInteraction:sint,
      heterogeneity:{Q,df,I2,tau2,tauLog:Math.sqrt(tau2)},
      within:{medianBlockSd:[...samples.map((d)=>d.fixtures[name].withinBlockSd)].sort((a,b)=>a-b)[Math.floor(samples.length/2)], medianSeLog:[...samples.map((d)=>d.fixtures[name].withinSe)].sort((a,b)=>a-b)[Math.floor(samples.length/2)]},
      diagnostics:{
        maxPairLogSd:Math.max(...samples.map((d)=>d.fixtures[name].maxPairLogSd)),
        maxRawCov:Math.max(...samples.map((d)=>d.fixtures[name].rawMaxCov)),
      },
      runnerPointsPct:points.map(pct),
      runnerImageVersions:[...new Set(samples.map((d)=>d.runner?.imageVersion).filter(Boolean))],
      browserVersions:[...new Set(samples.map((d)=>d.browserVersion).filter(Boolean))],
    }
  }
  result[engine]={replicates:samples.length,fixtures}
}

const allEffectCis=[]
for (const group of Object.values(result)) for (const fx of Object.values(group.fixtures)) allEffectCis.push(...fx.effect.ci95.map(Math.abs))
const summary={
  schema:'snapdom-r9-hosted-calibration-summary-v1',
  state:'CALIBRATION_COMPLETE',
  complete:true,
  performanceClaim:false,
  generatedAt:new Date().toISOString(),
  policySha256:prepared.policySha256,
  candidateGitSha:prepared.candidateGitSha,
  bundleSha256:prepared.bundle.sha256,
  sampling:policy.sampling,
  expectedSamples:expected.length,
  observedSamples:docs.length,
  calibration:{
    engines:result,
    maxAbsoluteSelfNullCiBoundPct:Math.max(...allEffectCis),
  },
  interpretation:'Self-null measurement of hosted-runner noise and bias only. CALIBRATION_COMPLETE is not an optimization or non-regression claim.',
}
fs.mkdirSync(path.dirname(OUT),{recursive:true})
fs.writeFileSync(OUT,JSON.stringify(summary,null,2)+'\n')

const rows=[]
for (const [engine,group] of Object.entries(result)) {
  for (const [name,fx] of Object.entries(group.fixtures)) {
    rows.push(`| ${engine} | ${name} | ${fx.effect.pct.toFixed(2)}% | [${fx.effect.ci95.map((v)=>v.toFixed(2)).join(', ')}]% | ${(fx.effect.runnerSdLog*100).toFixed(2)}% | ${(fx.heterogeneity.I2*100).toFixed(1)}% | [${fx.slotInteraction.ci95.map((v)=>v.toFixed(2)).join(', ')}]% |`)
  }
}
appendSummary([
  '### snapDOM R9 hosted calibration',
  '',
  '**CALIBRATION_COMPLETE** — self-null evidence only; **no performance claim**.',
  '',
  `- samples: ${docs.length}/${expected.length}`,
  `- bundle: \`${prepared.bundle.sha256.slice(0,12)}\``,
  `- maximum absolute self-null 95% CI bound: ${summary.calibration.maxAbsoluteSelfNullCiBoundPct.toFixed(2)}%`,
  '',
  '| engine | fixture | self-null effect | runner 95% CI | runner SD(log) | I² | slot-interaction CI |',
  '|---|---|---:|---:|---:|---:|---:|',
  ...rows,
  '',
].join('\n'))
console.log(JSON.stringify(summary,null,2))
