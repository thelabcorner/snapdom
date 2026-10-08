#!/usr/bin/env node
// R22 preregistered native PSS analysis. Full cohort first; image-only stratum
// selection second; runner-level inference last. No automatic promotion.
import fs from 'node:fs'
import path from 'node:path'
const dir=process.argv[2]||'lane6-scratch/r22/memory-artifacts'
const paths=fs.readdirSync(dir,{recursive:true}).filter(x=>x.endsWith('.json'))
const hosts=[]
const seen=new Set()
const metrics=['retainedDifferenceMiB','growthDifferenceMiB','rendererGrowthDifferenceMiB']
for(const file of paths){
  const x=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))
  if(x.schema!=='r22-memory-v1' || x.frozenBaseline!=='cac07a4108086718bc9511663346e1b9fcf4e226' ||
    !x.imageVersion||!x.imageOS||!Number.isInteger(x.host)||x.host<0||x.host>=12 ||
    x.observations?.length!==2||!x.sameSourceNull||seen.has(x.host))
    throw Error('Invalid/duplicate R22 artifact '+file)
  seen.add(x.host)
  if(new Set(x.observations.map(o=>o.order)).size!==2||
    !x.observations.some(o=>o.order==='AB')||!x.observations.some(o=>o.order==='BA'))
    throw Error('Unbalanced AB/BA for host '+x.host)
  for(const k of metrics) {
    if(!Number.isFinite(x.sameSourceNull[k]) ||
      x.observations.some(o=>!Number.isFinite(o[k])))throw Error('Bad PSS metric '+k)
  }
  for(const o of x.observations){
    if(o.A?.hashes?.length!==7||o.B?.hashes?.length!==7 ||
      JSON.stringify(o.A.hashes.map(q=>q.sha))!==JSON.stringify(o.B.hashes.map(q=>q.sha))||
      !o.B.hashes.every(q=>q.summaryUses>0))throw Error('Digest/engagement failure host '+x.host)
  }
  hosts.push(x)
}
if(hosts.length!==12)throw Error('Incomplete 12-host cohort: '+hosts.length)
const groups=new Map()
for(const h of hosts){
  const key=h.imageOS+'@'+h.imageVersion
  if(!groups.has(key))groups.set(key,[])
  groups.get(key).push(h)
}
const allImages=[...groups].map(([image,rows])=>({image,hostIDs:rows.map(x=>x.host).sort((a,b)=>a-b)}))
  .sort((a,b)=>b.hostIDs.length-a.hostIDs.length||a.image.localeCompare(b.image))
const selected=allImages[0]
if(selected.hostIDs.length<6)throw Error('No homogeneous >=6 runner stratum')
const cohort=groups.get(selected.image)
let state=0x22a911de
function rand(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296}
function ci(fn){
  const vals=cohort.map(fn),n=vals.length
  const average=vals.reduce((a,b)=>a+b,0)/n
  const draws=[]
  for(let i=0;i<20000;i++){
    let sum=0
    for(let j=0;j<n;j++)sum+=vals[Math.floor(rand()*n)]
    draws.push(sum/n)
  }
  draws.sort((a,b)=>a-b)
  const p=v=>Number(v.toFixed(4))
  return {meanMiB:p(average),ci95MiB:[p(draws[500]),p(draws[19500])],
    hosts:cohort.map((r,i)=>({id:r.host,MiB:p(vals[i])}))}
}
const effects={},nulls={}
for(const key of metrics){
  effects[key]=ci(x=>(x.observations[0][key]+x.observations[1][key])/2)
  nulls[key]=ci(x=>x.sameSourceNull[key])
}
const noisy=metrics.some(k=>{
  const [lo,hi]=nulls[k].ci95MiB
  return lo>0||hi<0||Math.max(Math.abs(lo),Math.abs(hi))>=
    Math.max(...effects[k].ci95MiB.map(Math.abs))
})
const report={schema:'r22-memory-aggregate-v1',decision:'EVIDENCE_ONLY_NO_AUTO_PROMOTION',
  warning:noisy?'SAME_SOURCE_NOISE_REQUIRES_REVIEW':'MEMORY_BUDGET_REVIEW_REQUIRED',
  totalHosts:hosts.length,selection:'largest image-only stratum; >=6 hosts; lexical tie break',
  chosenImage:selected.image,includedHosts:selected.hostIDs,
  excludedHosts:hosts.filter(x=>!selected.hostIDs.includes(x.host))
    .map(x=>({host:x.host,image:x.imageOS+'@'+x.imageVersion})),
  allImages,treatment:effects,sameSourceAANull:nulls}
console.log(JSON.stringify(report,null,2))
if(process.env.SNAPDOM_R22_SUMMARY)
  fs.writeFileSync(process.env.SNAPDOM_R22_SUMMARY,JSON.stringify(report,null,2))
