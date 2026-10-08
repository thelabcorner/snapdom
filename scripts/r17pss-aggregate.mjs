// R17 process-PSS corroboration. Do not pool unrelated GitHub runner images;
// retain per-image cohort results and all raw paired observations.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
const input=resolve(process.argv.find(a=>a.startsWith('--dir='))?.slice(6)||'r17-pss-evidence')
const output=resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||'r17-pss-evidence/summary.json')
const paths=[]
async function walk(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const p=join(directory,entry.name)
    if(entry.isDirectory())await walk(p)
    else if(/^runner-\d+\.json$/.test(entry.name))paths.push(p)
  }
}
await walk(input)
const issues=[],reports=[]
for(const p of paths)reports.push(JSON.parse(await readFile(p,'utf8')))
const ids=new Set(reports.map(r=>r.runner))
if(reports.length!==6||ids.size!==6||[1,2,3,4,5,6].some(i=>!ids.has(i)))issues.push('require exactly six unique runner records')
for(const r of reports){
  if(r.baselineSha!==process.env.BASELINE_SHA||r.candidateSha!==process.env.CANDIDATE_SHA)issues.push('frozen-source identity mismatch runner '+r.runner)
  if(!r.imageVersion)issues.push('missing host image identity runner '+r.runner)
  if(r.observations?.length!==2)issues.push('missing paired isolated-process trials runner '+r.runner)
  if(!['AB','BA'].every(order=>r.observations?.some(p=>p.order===order)))issues.push('unbalanced order on runner '+r.runner)
  for(const o of r.observations||[]){
    for(const key of ['warmProcessDeltaMiB','sweptProcessDeltaMiB','sweptRendererDeltaMiB']){
      if(!Number.isFinite(o[key]))issues.push('nonfinite native PSS '+key+' runner '+r.runner)
    }
    for(const side of ['A','B'])for(const stage of ['alreadyWarmed','afterUniqueSweep']){
      if(!Number.isFinite(o[side]?.[stage]?.processMiB)||o[side][stage].processMiB<=0||
         o[side][stage].processes<2)
        issues.push('incomplete process tree '+side+' '+stage+' runner '+r.runner)
    }
    if(JSON.stringify(o.A?.warmHashes)!==JSON.stringify(o.B?.warmHashes)||
       JSON.stringify(o.A?.sweepHashes)!==JSON.stringify(o.B?.sweepHashes))
      issues.push('source raw SHA-256 mismatch runner '+r.runner)
  }
}
const median=x=>[...x].sort((a,b)=>a-b)[Math.floor(x.length/2)]
const groups=new Map()
for(const r of reports){
  if(!groups.has(r.imageVersion))groups.set(r.imageVersion,[])
  groups.get(r.imageVersion).push(r)
}
const cohorts=[...groups].map(([imageVersion,rs])=>{
  const rows=rs.map(r=>({
    runner:r.runner,
    warmMiB:median(r.observations.map(o=>o.warmProcessDeltaMiB)),
    sweptMiB:median(r.observations.map(o=>o.sweptProcessDeltaMiB)),
    rendererSweptMiB:median(r.observations.map(o=>o.sweptRendererDeltaMiB))
  }))
  return{
    imageVersion,count:rows.length,
    medianWarmDeltaMiB:median(rows.map(x=>x.warmMiB)),
    medianSweptDeltaMiB:median(rows.map(x=>x.sweptMiB)),
    medianRendererSweptDeltaMiB:median(rows.map(x=>x.rendererSweptMiB)),
    maxSweptDeltaMiB:Math.max(...rows.map(x=>x.sweptMiB)),
    rows,
    observationalOnly:rows.length<3
  }
})
const verdict={
  schema:'snapdom-r17-pss-summary-v1',
  state:issues.length?'INCOMPLETE_EVIDENCE':'STRATIFIED_MEMORY_OBSERVATIONS',
  issues,
  baselineSha:process.env.BASELINE_SHA,
  candidateSha:process.env.CANDIDATE_SHA,
  imageCohorts:cohorts,
  pooledCrossImageEstimate:null,
  memoryPromotionAccepted:false,
  reason:'Process-set PSS is observational; require performance gate, parity and explicit memory tradeoff review before production promotion.'
}
await mkdir(dirname(output),{recursive:true})
await writeFile(output,JSON.stringify(verdict,null,2))
console.log(JSON.stringify(verdict,null,2))
if(issues.length)process.exitCode=1
