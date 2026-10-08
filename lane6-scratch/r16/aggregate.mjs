#!/usr/bin/env node
// R16 fail-closed aggregation. Source, runner and browser identities are first-class.
import fs from 'node:fs'
import path from 'node:path'
const dir='lane6-scratch/r16/results'
const files=fs.readdirSync(dir).filter(f=>/^chromium-r[0-5]\.json$/.test(f)).sort()
if(files.length!==6)throw new Error('R16 needs exactly six hosted Chromium artifacts')
const docs=files.map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')))
const first=docs[0],kinds=['no-background','sparse-background','dense-background']
if(new Set(docs.map(d=>d.replica)).size!==6 ||
   [...docs.map(d=>d.replica)].sort().join(',')!=='0,1,2,3,4,5')
  throw new Error('duplicate/missing runner')
for(const d of docs){
  if(d.schema!=='snapdom-r16-selector-v1'||d.engine!=='chromium'||
     d.pairs!==8||d.runId!==first.runId||d.measurementSha!==first.measurementSha||
     d.baselineSha!==first.baselineSha||d.browserVersion!==first.browserVersion||
     JSON.stringify(d.bundles)!==JSON.stringify(first.bundles))throw new Error('provenance mismatch')
  if(process.env.GITHUB_ACTIONS==='true' &&
     (d.runId!==process.env.GITHUB_RUN_ID||d.measurementSha!==process.env.GITHUB_SHA))
    throw new Error('GitHub run/commit mismatch')
}
const runnerImages=[...new Set(docs.map(d=>d.runnerImage).filter(Boolean))]
const report={
  schema:'snapdom-r16-selector-report-v1',state:'EXPERIMENT_COMPLETE_NO_PROMOTION',
  sourceSha:first.measurementSha,baselineSha:first.baselineSha,runId:first.runId,
  browserVersion:first.browserVersion,bundles:first.bundles,runnerImages,
  runnerCount:6,regimes:{},memoryAccepted:false,threeEngineAccepted:false,
}
const t975df5=2.570582
for(const kind of kinds){
  report.regimes[kind]={}
  for(const metric of ['captureMs','totalMs']){
    const points=docs.map(d=>{
      const arr=d.data[kind]?.pairs
      if(!Array.isArray(arr)||arr.length!==8)throw new Error('incomplete '+kind)
      let sides={candidate:[],baseline:[]}
      for(const p of arr){
        if(!Array.isArray(p.order)||p.order.length!==2)throw new Error('missing order')
        const before=p.order[0]
        if(!['candidate','baseline'].includes(before))throw new Error('invalid order')
        const a=p.candidate?.[metric],b=p.baseline?.[metric]
        if(!Number.isFinite(a)||!Number.isFinite(b)||a<=0||b<=0)
          throw new Error('non-finite timing')
        sides[before].push(Math.log(a/b))
        if(p.candidate.rawHash!==p.baseline.rawHash ||
           p.candidate.pixelHash!==p.baseline.pixelHash ||
           p.candidate.rawLength!==p.baseline.rawLength ||
           p.candidate.width!==p.baseline.width ||
           p.candidate.height!==p.baseline.height)
          throw new Error('R16 output mismatch')
      }
      if(sides.candidate.length!==4||sides.baseline.length!==4)
        throw new Error('AB/BA imbalance')
      return (sides.candidate.reduce((a,b)=>a+b,0)/4 +
        sides.baseline.reduce((a,b)=>a+b,0)/4)/2
    })
    const mean=points.reduce((a,b)=>a+b,0)/6
    const variance=points.reduce((a,b)=>a+(b-mean)**2,0)/5
    const half=t975df5*Math.sqrt(variance/6)
    const percent=x=>100*(Math.exp(x)-1)
    report.regimes[kind][metric]={
      effectPct:percent(mean),ci95Pct:[percent(mean-half),percent(mean+half)],
      runnerEffectsPct:points.map(percent),
      significantFaster:mean+half<0,
      significantSlower:mean-half>0,
    }
  }
}
const primary=report.regimes['no-background'].captureMs
const dense=report.regimes['dense-background'].captureMs
report.result=runnerImages.length===1 && primary.significantFaster && !dense.significantSlower
  ? 'TIMING_SIGNAL_ONLY_NO_MEMORY_OR_PROMOTION'
  : 'NO_TIMING_ACCEPTANCE'
report.threeEngineAccepted=false // Separate 3-engine job is not consumed by this aggregate.
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({
  result:report.result,
  runnerImages,
  noBackground:primary,
  sparseBackground:report.regimes['sparse-background'].captureMs,
  denseBackground:dense,
},null,2))
