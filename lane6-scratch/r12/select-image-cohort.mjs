/**
 * Metadata-only GitHub image-stratum selection. Must never inspect outcomes/timing/PSS.
 * Strictly prospective for R12 12-runner image-cohort experiment.
 */
export function selectImageCohort(docs, minimum = 6) {
  if (!Array.isArray(docs) || !Number.isInteger(minimum) || minimum < 2) {
    throw new TypeError('invalid cohort selection input')
  }
  const byImage = new Map()
  const seen = new Set()
  for (const doc of docs) {
    const replicate = doc?.replicate
    const os = doc?.provenance?.runner?.imageOs
    const version = doc?.provenance?.runner?.imageVersion
    if (!Number.isInteger(replicate) || replicate < 0 || seen.has(replicate)) {
      throw new Error('invalid or duplicated cohort runner identifier')
    }
    if (typeof os !== 'string' || !os.trim() || typeof version !== 'string' || !version.trim()) {
      throw new Error('missing exact hosted runner image identity for r'+replicate)
    }
    seen.add(replicate)
    const key = os+'@'+version
    if (!byImage.has(key)) byImage.set(key,[])
    byImage.get(key).push(doc)
  }
  const strata=[...byImage].map(([image,group])=>({
    image, runnerIds:group.map(x=>x.replicate).sort((a,b)=>a-b),
    docs:group,
  })).sort((a,b)=>b.docs.length-a.docs.length || b.image.localeCompare(a.image))
  const winner=strata.find(x=>x.docs.length>=minimum)
  return {
    valid:!!winner,
    requiredMinimum:minimum,
    totalRunners:docs.length,
    selectedImage:winner?.image||null,
    selectedDocs:winner?.docs||[],
    selectedRunnerIds:winner?.runnerIds||[],
    excludedRunnerIds:docs.filter(d=>!winner?.runnerIds.includes(d.replicate)).map(d=>d.replicate).sort((a,b)=>a-b),
    strata:strata.map(({image,runnerIds})=>({image,count:runnerIds.length,runnerIds})),
  }
}
