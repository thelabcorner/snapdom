#!/usr/bin/env node
/**
 * R21 PSS aggregate. Each hosted VM contributes ONE independent point: the mean
 * of its two AB/BA process-set contrasts. Within-host captures are correlated.
 * This is memory evidence, never proof of a whole-library speed improvement.
 */
import fs from 'node:fs'
import path from 'node:path'
const root=process.argv[2]||'lane6-scratch/r21/pss-results'
const files=fs.readdirSync(root,{recursive:true}).filter(x=>x.endsWith('.json'))
const byHost=new Map()
for(const file of files){
  const data=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'))
  if(data.schema!=='r21-memory-v1' ||
     data.frozenBaseline!=='cac07a4108086718bc9511663346e1b9fcf4e226' ||
     data.observations?.length!==2)throw Error('Invalid R21 memory sample '+file)
  if(byHost.has(data.host))throw Error('Duplicate host '+data.host)
  const arms=new Set(data.observations.map(x=>x.order))
  if(!arms.has('AB')||!arms.has('BA'))throw Error('Missing balanced AB/BA host '+data.host)
  byHost.set(data.host,data.observations)
}
if(byHost.size!==6)throw Error('Incomplete six-independent-host PSS cohort: '+byHost.size)
const vars=['growthDifferenceMiB','retainedDifferenceMiB','rendererGrowthDifferenceMiB']
let seed=0x83218a17
function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
function interval(points){
  const mean=points.reduce((a,b)=>a+b,0)/points.length
  const draws=[]
  for(let k=0;k<20000;k++){
    let sum=0
    for(let i=0;i<points.length;i++)sum+=points[Math.floor(rand()*points.length)]
    draws.push(sum/points.length)
  }
  draws.sort((a,b)=>a-b)
  return {meanMiB:mean,ci95MiB:[draws[500],draws[19500]],byHostMiB:points}
}
const stats={}
for(const k of vars)stats[k]=interval([...byHost.values()].map(obs=>
  obs.reduce((a,b)=>a+b[k],0)/obs.length))
const out={schema:'r21-pss-aggregate-v1',independentHosts:byHost.size,
  comparisonsPerHost:2,stats,
  verdict:'MEMORY_EVIDENCE_ONLY: image versions and cross-engine fidelity gates must be reviewed before production promotion.'}
console.log(JSON.stringify(out,null,2))
if(process.env.SNAPDOM_R21_MEMORY_SUMMARY)
  fs.writeFileSync(process.env.SNAPDOM_R21_MEMORY_SUMMARY,JSON.stringify(out,null,2))
