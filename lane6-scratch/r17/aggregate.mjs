#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const dir='lane6-scratch/r17/results'
const names=fs.readdirSync(dir).filter(x=>/^chromium-r[0-5]\.json$/.test(x)).sort()
if(names.length!==6)throw Error('six distinct hosted Chromium artifacts required')
const docs=names.map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8')))
const ref=docs[0],arms=['html-only','mixed-assets','svg-background-only','no-compress']
if([...new Set(docs.map(d=>d.replica))].sort().join(',')!=='0,1,2,3,4,5')throw Error('missing or duplicate replica')
for(const d of docs){
 if(d.schema!=='snapdom-r17-mixed-asset-v1'||d.engine!=='chromium'||
    d.runId!==ref.runId||d.measurementSha!==ref.measurementSha||
    d.baselineSha!==ref.baselineSha||d.browserVersion!==ref.browserVersion||
    JSON.stringify(d.bundles)!==JSON.stringify(ref.bundles)||
    JSON.stringify(d.fixtures)!==JSON.stringify(ref.fixtures))
  throw Error('provenance mismatch')
 if(process.env.GITHUB_ACTIONS==='true'&&
    (d.runId!==process.env.GITHUB_RUN_ID||d.measurementSha!==process.env.GITHUB_SHA))
  throw Error('workflow identity mismatch')
}
const result={schema:'snapdom-r17-aggregate-v1',runId:ref.runId,candidate:ref.measurementSha,baseline:ref.baselineSha,runnerImages:[...new Set(docs.map(d=>d.runnerImage||'MISSING'))],runners:6,regimes:{},memoryAccepted:false,threeEngineAccepted:false,productionPromotion:false}
const t=2.570582
for(const arm of arms){
 result.regimes[arm]={}
 for(const metric of ['captureMs','totalMs']){
  const points=docs.map(d=>{
   const samples=d.arms[arm]?.samples
   if(!Array.isArray(samples)||samples.length!==8)throw Error('incomplete samples '+arm)
   const strata={candidate:[],baseline:[]}
   for(const p of samples){
    const k=p.order?.[0]
    if(k!=='candidate'&&k!=='baseline')throw Error('invalid order')
    const a=p.candidate?.[metric],b=p.baseline?.[metric]
    if(!Number.isFinite(a)||!Number.isFinite(b)||a<=0||b<=0)throw Error('invalid time')
    for(const field of ['rawHash','pixelHash','width','height','rawLength','compressedAssets'])
     if(p.baseline?.[field]!==p.candidate?.[field])throw Error('cross-side fidelity mismatch '+arm+'/'+field)
    if(arm==='mixed-assets'&&p.candidate.compressedAssets<3)throw Error('mixed mechanism not observed')
    strata[k].push(Math.log(a/b))
   }
   if(strata.candidate.length!==4||strata.baseline.length!==4)throw Error('ABBA imbalance')
   const mean=x=>x.reduce((a,b)=>a+b,0)/x.length
   return (mean(strata.candidate)+mean(strata.baseline))/2
  })
  const m=points.reduce((a,b)=>a+b,0)/6
  const sd=Math.sqrt(points.reduce((a,b)=>a+(b-m)**2,0)/5)
  const h=t*sd/Math.sqrt(6)
  const pct=x=>100*(Math.exp(x)-1)
  result.regimes[arm][metric]={pct:pct(m),ci95Pct:[pct(m-h),pct(m+h)],runnerEffectsPct:points.map(pct),significantlyFaster:m+h<0,significantlySlower:m-h>0}
 }
}
const homogeneous=result.runnerImages.length===1&&!result.runnerImages.includes('MISSING')
const mixed=result.regimes['mixed-assets'].captureMs
const html=result.regimes['html-only'].captureMs
const nullArm=result.regimes['no-compress'].captureMs
result.result=homogeneous&&mixed.significantlyFaster&&!html.significantlySlower&&!nullArm.significantlySlower
 ? 'TIMING_SIGNAL_ONLY_FIDELITY_AND_PSS_STILL_REQUIRED'
 : 'NO_TIMING_ACCEPTANCE'
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({result:result.result,runnerImages:result.runnerImages,regimes:result.regimes},null,2))
