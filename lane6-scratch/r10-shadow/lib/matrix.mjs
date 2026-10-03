// Exact-matrix completeness for F4. Fail-closed by construction: a stage is admissible only when
// every preregistered cell for that stage is present exactly once, is a usable sample, and
// carries the identity the run was frozen with.
//
// "Exactly once" matters for reruns. A rerun of a failed job keeps the same run_id and overwrites
// that cell's artifact, so the aggregate sees one file per cell. If two documents ever claim the
// same cell the aggregate refuses rather than picking one, because picking one would make the
// verdict depend on directory iteration order.

export const USABLE_STATE = 'SAMPLE_VALID'

export function cellKey(doc) {
  return doc.browser + ':' + doc.replicate
}

export function expectedCells(policy, engines) {
  const cells = []
  for (const engine of engines) {
    for (let replicate = 0; replicate < policy.replicates[engine]; replicate++) {
      cells.push(engine + ':' + replicate)
    }
  }
  return cells
}

/**
 * @param {object} input
 * @param {object[]} input.docs decision documents found on disk
 * @param {string[]} input.expected exact cell list for the stage
 * @param {{policySha256: string, candidateGitSha: string, bundleSha256: string}} input.identity
 * @returns {{complete: boolean, byKey: Map<string, object>, missing: string[], duplicate: string[],
 *   unusable: string[], wrongIdentity: string[], stray: string[]}}
 */
export function auditCells({ docs, expected, identity }) {
  const byKey = new Map()
  const duplicate = []
  for (const doc of docs) {
    const key = cellKey(doc)
    if (byKey.has(key)) duplicate.push(key)
    else byKey.set(key, doc)
  }
  const missing = expected.filter((key) => !byKey.has(key))
  const unusable = expected.filter((key) => byKey.has(key) && byKey.get(key).state !== USABLE_STATE)
  const wrongIdentity = expected.filter((key) => {
    const doc = byKey.get(key)
    if (!doc) return false
    return doc.policySha256 !== identity.policySha256 ||
      doc.candidateGitSha !== identity.candidateGitSha ||
      doc.bundleSha256 !== identity.bundleSha256
  })
  const stray = [...byKey.keys()].filter((key) => !expected.includes(key))
  return {
    complete: !missing.length && !duplicate.length && !unusable.length && !wrongIdentity.length && !stray.length,
    byKey,
    missing,
    duplicate,
    unusable,
    wrongIdentity,
    stray,
  }
}

