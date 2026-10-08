#!/usr/bin/env node
/**
 * R20 independent-host inference. One POINT per GitHub-hosted runner, regardless of
 * pairs per runner. Repeated captures inside one browser are not independent replicates.
 * A/A is mandatory. This is a scoped scout report, never a production gate by itself.
 */
import fs from 'node:fs'
import path from 'node:path'
const folder=process.argv[2]||'lane6-scratch/r20/host-results'
const files=fs.readdirSync(folder,{recursive:true}).filter(x=>x.endsWith('.json'))
const entries=[]
for(const file of files){
  const p=JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'))
  if(p.schema!==1 || !Array.isArray(p.results)) throw new Error('Invalid R20 result '+file)
  if(p.baseline!=='cac07a4108086718bc9511663346e1b9fcf4e226') throw new Error('Baseline mismatch '+file)
  entries.push(p)
}
if(!entries.length) throw new Error('No results')
if(process.env.SNAPDOM_R20_EXPECTED && entries.length!==Number(process.env.SNAPDOM_R20_EXPECTED))
  throw new Error('Incomplete independent-host cohort: '+entries.length+' results')
const byHost=new Set()
const groups=new Map()
for (const h of entries){
  const hk=h.engine+':'+h.host
  if(byHost.has(hk))throw new Error('Duplicate independent host '+hk)
  byHost.add(hk)
  for(const r of h.results){
    if(!r.parity || !r.baselineSamplesMs?.length || r.baselineSamplesMs.length!==r.candidateSamplesMs?.length)
      throw new Error('Missing full A/B paired fidelity evidence '+hk+' '+r.regime)
    if(r.sourceB==='candidate' && !r.telemetry?.summaryUses && r.regime!=='nested-style-veto')
      throw new Error('Candidate was never exercised '+hk+' '+r.regime)
    const logs=r.baselineSamplesMs.map((x,i)=>{
      const y=r.candidateSamplesMs[i]
      if(!(x>0 && y>0))throw new Error('Invalid timing')
      return Math.log(y/x)
    })
    const point=logs.reduce((x,y)=>x+y,0)/logs.length
    const key=h.engine+':'+r.sourceA+'->'+r.sourceB+':'+r.regime
    if(!groups.has(key))groups.set(key,[])
    groups.get(key).push({host:h.host,point,ms:r.baselineMedianMs,candidateMs:r.candidateMedianMs})
  }
}
function seeded(seed){let x=seed>>>0;return ()=>{x=(x*1664525+1013904223)>>>0;return x/4294967296}}
const result=[]
for(const [key,values] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const mean=values.reduce((x,y)=>x+y.point,0)/values.length
  const rng=seeded(0x915aa6f3)
  const draws=[]
  for(let i=0;i<12000;i++){
    let sum=0
    for(let j=0;j<values.length;j++)sum+=values[Math.floor(rng()*values.length)].point
    draws.push(sum/values.length)
  }
  draws.sort((a,b)=>a-b)
  const pct=x=>Number(((Math.exp(x)-1)*100).toFixed(3))
  result.push({key,nIndependentHosts:values.length,effectPct:pct(mean),
    ci95Pct:[pct(draws[300]),pct(draws[11700])],
    hostPoints:values.map(x=>({host:x.host,effectPct:pct(x.point)}))})
}
const out={schema:1,independentHosts:entries.length,results:result,
  interpretation:'Runner-level bootstrap CI. Strict raw SVG/pixel parity and memo engagement tested in each job. Scoped synthetic fresh-style workloads; no promotion verdict without memory and application-fidelity evidence.'}
console.log(JSON.stringify(out,null,2))
if(process.env.SNAPDOM_R20_AGGREGATE)fs.writeFileSync(process.env.SNAPDOM_R20_AGGREGATE,JSON.stringify(out,null,2))
