#!/usr/bin/env node
// Source-identity-pinned R13 end-to-end capture timing evidence, one log point per hosted runner.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root = 'lane6-scratch/r13/capture-results'
const SHA = 'ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b'
const arms = ['six-shared-source','six-distinct-sources','single-image-control']
const files = []
function scan(dir,level=0) {
  if (level > 5) throw new Error('unsupported artifact nesting')
  for (const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const p=path.join(dir,item.name)
    if (item.isDirectory()) scan(p,level+1)
    else if (/^replica-[1-6]\.json$/.test(item.name)) files.push(p)
  }
}
scan(root)
const evidence=files.map(f=>JSON.parse(fs.readFileSync(f,'utf8')))
const issues=[]
if(evidence.length!==6) issues.push('require exactly six independent fresh runner artifacts')
const indices=new Set()
let identity=null
const cohorts=new Map()
const means=(array)=>array.reduce((sum,x)=>sum+x,0)/array.length
for(const e of evidence) {
  if(e.schema!=='snapdom-r13-capture-singleflight-v1') issues.push('unknown runner schema')
  if(!Number.isInteger(e.replica)||e.replica<1||e.replica>6||indices.has(e.replica)) issues.push('duplicate or illegal replica '+e.replica)
  indices.add(e.replica)
  if(e.candidateSha!==process.env.GITHUB_SHA||e.baselineSha!==SHA) issues.push('candidate or baseline identity drift')
  const fixed=JSON.stringify([e.bundleSha,e.fixtureSha,e.browserVersion,e.baselineSha])
  if(identity===null) identity=fixed
  else if(identity!==fixed) issues.push('compiled bundle, fixture, or Chromium version drift')
  const image=e.runnerImageVersion||'unknown'
  cohorts.set(image,[...(cohorts.get(image)||[]),e.replica])
  for(const id of arms) {
    const entry=e.arms?.[id], rows=entry?.samples
    if(!Array.isArray(rows)||rows.length!==8) {
      issues.push('missing arm/steps '+id+' at runner '+e.replica)
      continue
    }
    const expectedPosts=id==='single-image-control'?1:6
    let baselineFirst=0,candidateFirst=0
    for(let i=0;i<rows.length;i++) {
      const pair=rows[i]
      if(pair.index!==i) issues.push('step index drift '+id)
      if(JSON.stringify(pair.order)===JSON.stringify(['baseline','candidate'])) baselineFirst++
      else if(JSON.stringify(pair.order)===JSON.stringify(['candidate','baseline'])) candidateFirst++
      else issues.push('invalid pairing order '+id)
      const b=pair.baseline,c=pair.candidate
      if(b?.rawSha!==c?.rawSha||b?.pixelsSha!==c?.pixelsSha ||
        b?.width!==c?.width||b?.height!==c?.height) issues.push('raw or pixel mismatch '+id)
      if(!b||!c||b.posts<expectedPosts||c.posts<expectedPosts||b.errors!==0||c.errors!==0)
        issues.push('Worker route not reached '+id)
      if(id==='six-shared-source' && !(c.hits>=4)) issues.push('candidate bitmap reuse not reached')
      if(![b.captureMs,c.captureMs,b.totalMs,c.totalMs].every(v=>Number.isFinite(v)&&v>0))
        issues.push('invalid paired capture/total latency '+id)
    }
    if(baselineFirst!==4||candidateFirst!==4) issues.push('unbalanced A/B order '+id)
  }
}
if(cohorts.size!==1||cohorts.has('unknown'))issues.push('heterogeneous hosted image identity')
const t95=2.5705818356
function verdict(vals) {
  const avg=means(vals)
  const stdev=Math.sqrt(vals.reduce((sum,x)=>sum+(x-avg)**2,0)/(vals.length-1))
  const margin=t95*stdev/Math.sqrt(vals.length)
  const percent=x=>(Math.exp(x)-1)*100
  return { n:vals.length, pct:percent(avg), ci95Pct:[percent(avg-margin),percent(avg+margin)],
    runnerLogPoints:vals, isFaster:avg+margin<0 }
}
const logpoints={}
for(const id of arms) {
  logpoints[id]={}
  for(const key of ['captureMs','totalMs']) {
    if(evidence.length!==6||evidence.some(e=>e.arms?.[id]?.samples?.length!==8))continue
    const vals=evidence.map(e=>{
      const pairs=e.arms[id].samples
      const left=pairs.filter(x=>x.order[0]==='baseline')
      const right=pairs.filter(x=>x.order[0]==='candidate')
      const log=x=>Math.log(x.candidate[key]/x.baseline[key])
      return 0.5*(means(left.map(log))+means(right.map(log)))
    })
    logpoints[id][key]=verdict(vals)
  }
}
const improvement=(x,y)=>x.map((a,i)=>a-y[i])
const shared=logpoints['six-shared-source']?.captureMs?.runnerLogPoints
const distinct=logpoints['six-distinct-sources']?.captureMs?.runnerLogPoints
const single=logpoints['single-image-control']?.captureMs?.runnerLogPoints
const contrasts=shared&&distinct&&single?{
 sharedMinusDistinct:verdict(improvement(shared,distinct)),
 sharedMinusSingle:verdict(improvement(shared,single)),
}:null
const summary={
 schema:'snapdom-r13-capture-aggregation-v1',
 state:issues.length?'INCOMPLETE_EVIDENCE':'MEASURED',
 disclaimer:'Mixed hosted images invalidate an official combined inference. Observed points remain exploratory.',
 measurementSha:process.env.GITHUB_SHA||null,
 baselineSha:SHA, expectedRunners:6, observedRunners:evidence.length, replicateIds:[...indices].sort(),
 imageCohorts:Object.fromEntries(cohorts), issues, armStats:logpoints, contrasts,
 hashes:Object.fromEntries(files.map(f=>[path.basename(f),crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')])),
}
fs.mkdirSync(root,{recursive:true})
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify(summary,null,2))
if(issues.length)process.exitCode=1
