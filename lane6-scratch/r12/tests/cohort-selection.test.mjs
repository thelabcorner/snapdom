import test from 'node:test'
import assert from 'node:assert/strict'
import {selectImageCohort} from '../select-image-cohort.mjs'
const make=(id,image,score=0)=>({replicate:id,provenance:{runner:{imageOs:'ubuntu24',imageVersion:image}},conditions:{fakeOutcome:{memory:{pssKb:score},timing:{logPoint:score}}}})
test('chooses largest host stratum, independent of outcomes',()=>{
  const docs=[...Array.from({length:7},(_,i)=>make(i,'old',i)), ...Array.from({length:5},(_,i)=>make(i+7,'new',5000))]
  const a=selectImageCohort(docs)
  assert.equal(a.valid,true)
  assert.equal(a.selectedImage,'ubuntu24@old')
  assert.deepEqual(a.selectedRunnerIds,[0,1,2,3,4,5,6])
  assert.deepEqual(a.excludedRunnerIds,[7,8,9,10,11])
  const inverted=docs.map(x=>({...x,conditions:{fakeOutcome:{memory:{pssKb:-999999},timing:{logPoint:Infinity}}}}))
  assert.deepEqual(selectImageCohort(inverted).selectedRunnerIds,a.selectedRunnerIds)
})
test('exact six-six tie uses stable lexicographic-newer image, not outcomes',()=>{
 const docs=Array.from({length:12},(_,i)=>make(i,i%2?'20261004.327.1':'20260927.320.1',i%2?999999:-999999))
 const r=selectImageCohort(docs)
 assert.equal(r.valid,true)
 assert.equal(r.selectedImage,'ubuntu24@20261004.327.1')
 assert.deepEqual(r.selectedRunnerIds,[1,3,5,7,9,11])
})
test('three four-runner images yield no valid stratum',()=>{
 const r=selectImageCohort(Array.from({length:12},(_,i)=>make(i,'v'+Math.floor(i/4))))
 assert.equal(r.valid,false)
 assert.equal(r.selectedDocs.length,0)
 assert.equal(r.excludedRunnerIds.length,12)
})
test('rejects missing revision, duplicate replicate and malformed inputs',()=>{
 assert.throws(()=>selectImageCohort([make(0,'v'),make(0,'w')]),/duplicated/)
 assert.throws(()=>selectImageCohort([{replicate:0,provenance:{runner:{imageOs:'u'}}}]),/missing exact/)
 assert.throws(()=>selectImageCohort([make(0,'v')],1),/invalid cohort/)
 assert.throws(()=>selectImageCohort(null),/invalid cohort/)
})
