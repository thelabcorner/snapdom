#!/usr/bin/env node
// 6 fresh-runner matched estimates, with conservative Student-t interval across runner effects.
import fs from 'node:fs'
import path from 'node:path'
const dir='lane6-scratch/r12/results'
const files=fs.readdirSync(dir).filter(f=>/^replica-[1-6]\.json$/.test(f)).sort()
if(files.length!==6)throw new Error('require six independent hosted runner artifacts, got '+files.length)
const docs=files.map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')))
const ref=docs[0]
if(new Set(docs.map(d=>d.replica)).size!==6)throw new Error('replica duplicate')
for(const d of docs){
  if(d.schema!==ref.schema||d.candidateSha!==ref.candidateSha||
     d.baselineSha!==ref.baselineSha||d.runId!==ref.runId||
     JSON.stringify(d.bundleSha)!==JSON.stringify(ref.bundleSha)||
     JSON.stringify(d.fixtureSha)!==JSON.stringify(ref.fixtureSha))throw new Error('provenance mismatch')
}
const report={schema:'snapdom-r12-paired-report-v1',
 runId:ref.runId,candidateSha:ref.candidateSha,baselineSha:ref.baselineSha,
 bundleSha:ref.bundleSha,runnerCount:6,regimes:{},fidelity:'EXACT_PAIRWISE_FOR_ALL_SAMPLES',
 state:'EXPERIMENT_COMPLETE_NO_PROMOTION',performanceClaim:false}
for(const arm of Object.keys(ref.arms)){
 const data=[]
 for(const d of docs){
  const s=d.arms[arm]?.samples
  if(s?.length!==8)throw new Error('incomplete '+arm+' replica '+d.replica)
  const effects={}
  for(const field of ['captureMs','totalMs']){
   const strata=[[],[]]
   s.forEach((p,i)=>{
    const sideFirst=p.order[0]==='candidate'?1:0
    if(![p.candidate[field],p.baseline[field]].every(x=>Number.isFinite(x)&&x>0))
      throw new Error('invalid timing')
    strata[sideFirst].push(Math.log(p.candidate[field]/p.baseline[field]))
   })
   if(strata[0].length!==4||strata[1].length!==4)throw new Error('unbalanced pairing')
   effects[field]=0.5*(strata[0].reduce((a,b)=>a+b,0)/4+strata[1].reduce((a,b)=>a+b,0)/4)
  }
  data.push({replica:d.replica,...effects})
 }
 const stats={}
 for(const field of ['captureMs','totalMs']){
  const vals=data.map(x=>x[field])
  const avg=vals.reduce((a,b)=>a+b,0)/6
  const sd=Math.sqrt(vals.reduce((a,b)=>a+(b-avg)**2,0)/5)
  const critical=2.570582
  const half=critical*sd/Math.sqrt(6)
  stats[field]={effectPercent:100*(Math.exp(avg)-1),
    CI95Percent:[100*(Math.exp(avg-half)-1),100*(Math.exp(avg+half)-1)],
    runnerEffectsPercent:vals.map(x=>100*(Math.exp(x)-1))}
 }
 report.regimes[arm]=stats
 console.log('[r12] '+arm+' capture='+stats.captureMs.effectPercent.toFixed(2)+'% CI=['+
   stats.captureMs.CI95Percent.map(n=>n.toFixed(2)).join(',')+'] total='+
   stats.totalMs.effectPercent.toFixed(2)+'%')
}
const out='lane6-scratch/r12/results/summary.json'
fs.writeFileSync(out,JSON.stringify(report,null,2))
console.log('[r12] EVIDENCE_ONLY '+out+'; no performance promotion or PSS/fidelity acceptance')
