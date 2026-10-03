// What this file measures, and what it deliberately refuses to measure.
//
// Every number below is a CALL COUNT into browser CSSOM and selector APIs. A call count is not
// a duration. The standing lesson on this branch is that large CSSOM-read deletions moved no
// wall time on the standing fixtures (SA2 gCS, the BRST scroll census, OFF1 offsets), and the
// accepted artifacts say so in the same breath as the counter deltas. So the amplification
// figure this file exists to reproduce is a statement about the SHAPE of the pipeline: a page
// built from shadow cards pays far more computed-style reads per node than the same page built
// from light-DOM cards, because the identity share cannot see inside a shadow root and every
// shadow node pays its own full read. The test asserts that ORDERING and lets the numbers be
// whatever the engine produces.
//
// It does not assert a magnitude. A "47x" recorded on one engine is not a fact about another,
// and pinning it here would only pin the engine. The one admissible wall claim is the hosted
// A/B in lane6-scratch/r10-shadow (F4), which is preregistered to REJECT the per-root partition
// unless it beats 1% with a clean instrument.
//
// Shares are forced on and off per capture (see arm): these pages measure the share, so the
// share must not be left to captureDOM's gate.
import { describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { READ_KEYS, SHADOW_FIXTURES, census, fixtureByName, fixtureSupported } from './helpers/shadowCards.js'

function arm(share) {
  return { scale: 1, dpr: 1, burst: false, cache: 'disabled', __styleShare: share }
}

/** Every node the capture visits, shadow and document together. */
const totalNodes = (nodes) => nodes.documentNodes + nodes.shadowNodes

describe('shadow read census', () => {
  it('counts the read families it claims to count', async () => {
    const counted = await census(fixtureByName('uniform-shadow-cards'), (root) =>
      snapdom.toRaw(root, arm(true)))
    for (const key of READ_KEYS) expect(typeof counted[key], key).toBe('number')
    // These three are unconditional on any capture: one acquisition and one named read per
    // snapshotted node, and one root probe per universe/scan question.
    expect(counted.getComputedStyle).toBeGreaterThan(0)
    expect(counted.getPropertyValue).toBeGreaterThan(0)
    expect(counted.getRootNode).toBeGreaterThan(0)
    expect(totalNodes(counted.nodes)).toBeGreaterThan(0)
  })

  it('shares never increase reads, and shadow cards pay more per node than light-DOM cards', async () => {
    const control = fixtureByName('document-uniform-cards')
    const rows = []
    for (const fixture of [control, ...SHADOW_FIXTURES.filter((fx) => fx !== control)]) {
      if (!fixtureSupported(fixture)) continue
      const off = await census(fixture, (root) => snapdom.toRaw(root, arm(false)))
      const on = await census(fixture, (root, share) =>
        snapdom.toRaw(root, { ...arm(true), __styleShareCounters: share }))
      rows.push({
        name: fixture.name,
        covers: fixture.covers,
        nodes: totalNodes(on.nodes),
        shadowNodes: on.nodes.shadowNodes,
        gPVperNode: on.getPropertyValue / totalNodes(on.nodes),
        gPVshareOff: off.getPropertyValue,
        gPVshareOn: on.getPropertyValue,
        outOfTree: on.share.outOfTree,
        elementHits: on.share.elementHits,
        pseudoHits: on.share.pseudoHits,
        ...Object.fromEntries(READ_KEYS.map((k) => [k, on[k]])),
      })
    }

    const light = rows.find((r) => r.name === 'document-uniform-cards')
    const shadow = rows.filter((r) => r.shadowNodes > 0)

    // Sharing removes reads; it never adds them.
    for (const row of rows) {
      expect(row.gPVshareOn, row.name).toBeLessThanOrEqual(row.gPVshareOff)
    }
    // The amplification itself, as an ordering. A shadow node is snapshotted in full every
    // time, so its per-node read cost cannot fall below the light-DOM cost of the same capture.
    for (const row of shadow) {
      expect(row.gPVperNode, row.name).toBeGreaterThan(light.gPVperNode)
    }
    // Every shadow node in every shadow fixture was refused an identity: the share is not
    // merely losing races in there, it is not offered them at all.
    for (const row of shadow) {
      expect(row.outOfTree, row.name).toBeGreaterThan(0)
      expect(row.pseudoHits, row.name).toBe(0)
    }

    console.log(`\nshadow read census (share on; CALL COUNTS, not wall time)\n${'fixture'.padEnd(26)}${'nodes'.padStart(6)}${'shadow'.padStart(7)}${'gPV/node'.padStart(9)}${'gCS'.padStart(7)}${'gpv'.padStart(8)}${'match'.padStart(7)}${'root'.padStart(7)}${'mql'.padStart(6)}${'typed'.padStart(7)}${'hit'.padStart(6)}${'refused'.padStart(9)}`)
    for (const row of rows) {
      console.log(
        row.name.padEnd(26)
        + String(row.nodes).padStart(6)
        + String(row.shadowNodes).padStart(7)
        + row.gPVperNode.toFixed(1).padStart(9)
        + String(row.getComputedStyle).padStart(7)
        + String(row.getPropertyValue).padStart(8)
        + String(row.matches).padStart(7)
        + String(row.getRootNode).padStart(7)
        + String(row.matchMedia).padStart(6)
        + String(row.typedOM).padStart(7)
        + String(row.elementHits).padStart(6)
        + String(row.outOfTree).padStart(9)
      )
    }
  })
})
