import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
const script=resolve('scripts/r23-ancestor-memory-aggregate.mjs')
function row(i){
  const a={hashes:Array.from({length:7},(_,k)=>({sha:String(k),summaryUses:0}))}
  const b={hashes:a.hashes.map(x=>({...x,summaryUses:3}))}
  const obs=order=>({order,A:a,B:b,retainedDifferenceMiB:4,
    growthDifferenceMiB:2,rendererGrowthDifferenceMiB:1})
  const nullObs=order=>({order,X:a,Y:a,retainedDifferenceMiB:0,
    growthDifferenceMiB:0,rendererGrowthDifferenceMiB:0})
  return {schema:'r23-memory-v1',host:i,imageOS:'ubuntu24',
    nullObservations:[nullObs('XY'),nullObs('YX')],
    imageVersion:i<8?'build-old':'build-new',
    frozenBaseline:'cac07a4108086718bc9511663346e1b9fcf4e226',
    sameSourceNull:{retainedDifferenceMiB:0,growthDifferenceMiB:0,
      rendererGrowthDifferenceMiB:0},
    observations:[obs('AB'),obs('BA')]}
}
function execute(edit){
  const dir=mkdtempSync(join(tmpdir(),'r23-test-'))
  try{
    const rows=Array.from({length:12},(_,i)=>row(i));edit?.(rows)
    for(const x of rows){
      mkdirSync(join(dir,String(x.host)),{recursive:true})
      writeFileSync(join(dir,String(x.host),'data.json'),JSON.stringify(x))
    }
    return spawnSync(process.execPath,[script,dir],{encoding:'utf8'})
  }finally{rmSync(dir,{recursive:true,force:true})}
}
test('8-host image-only cohort and same-source null',()=>{
  const r=execute()
  assert.equal(r.status,0,r.stderr)
  const o=JSON.parse(r.stdout)
  assert.deepEqual(o.includedHosts,[0,1,2,3,4,5,6,7])
  assert.equal(o.excludedHosts.length,4)
  assert.equal(o.treatment.retainedDifferenceMiB.meanMiB,4)
  assert.deepEqual(o.sameSourceAANull.retainedDifferenceMiB.ci95MiB,[0,0])
  assert.equal(o.decision,'EVIDENCE_ONLY_NO_AUTO_PROMOTION')
})
test('fails closed on incomplete hosts',()=>{
  assert.notEqual(execute(x=>x.pop()).status,0)
})
test('fails closed on unbalanced source order',()=>{
  assert.notEqual(execute(x=>{x[2].observations[1].order='AB'}).status,0)
})
test('fails closed on memo not engaged',()=>{
  assert.notEqual(execute(x=>{x[1].observations[0].B.hashes[0].summaryUses=0}).status,0)
})
test('fails closed on byte mismatch',()=>{
  assert.notEqual(execute(x=>{x[3].observations[0].B.hashes[0].sha='different'}).status,0)
})

test('fails closed on unbalanced same-source null',()=>{
  assert.notEqual(execute(x=>{x[3].nullObservations[1].order='XY'}).status,0)
})
test('fails closed on tampered same-source null statistics',()=>{
  assert.notEqual(execute(x=>{x[4].sameSourceNull.retainedDifferenceMiB=4}).status,0)
})
