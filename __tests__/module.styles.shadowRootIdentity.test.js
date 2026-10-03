// The identity share mints one id per NODE SHAPE per capture, and those ids are the key of
// every shared snapshot: the element share (getSnapshot) and the pseudo share
// (pseudoSnapshotFor). The namespace therefore has to be the tree the scan actually read, and
// the document scan reads DOCUMENT sheets only. Before this file, identityFor still minted an
// id for a node inside a shadow root, keyed 'R|<tag>|<attrs>' — the same key the capture root
// and every other root's top-level children get. Two roots with identical subtrees therefore
// interned to ONE id, and pseudoSnapshotFor handed the second root a pseudo snapshot computed
// under the first root's sheets.
//
// The element share was never exposed: inlineAllStyles refuses shadow hosts, shadow content and
// slotted nodes before a snapshot record is written, so the collision could only surface through
// the pseudo path, which had no root check of its own. identityFor now refuses every node
// outside the document tree, which fixes both consumers by construction.
//
// Every capture below forces __styleShare true/false instead of letting captureDOM decide: these
// pages exist to exercise the share, and a document sheet that trips styleSharePlan's gate would
// otherwise switch the share off and make a broken arm look correct. Each arm builds its own
// tree, so no arm reads another arm's snapshot cache.
//
// Pinned: two roots with different ::before rules produce one payload and each paints its own
// block; the capture root and a shadow root's top-level child do too; every shadow node is
// refused an identity and no pseudo snapshot is served across roots; light-DOM twins still share.
// Nothing here is a wall-time claim.
import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { SHADOW_FIXTURES, census, fixtureByName, fixtureSupported } from './helpers/shadowCards.js'

const cleanups = []
afterEach(() => { while (cleanups.length) cleanups.pop()() })

/** Capture options for one share arm. cache and burst off so a payload difference is the share
 *  and nothing else. */
function arm(share) {
  return { scale: 1, dpr: 1, burst: false, cache: 'disabled', __styleShare: share }
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0))
}

function pixel(canvas, x, y) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data
  return [d[0], d[1], d[2]]
}

/** Payloads from two independent mounts of the same builder, one per arm. */
async function payloadPerArm(build, on, off) {
  const first = build()
  const withShare = await snapdom.toRaw(first.root, arm(on))
  first.dispose()
  const second = build()
  const withoutShare = await snapdom.toRaw(second.root, arm(off))
  second.dispose()
  return { withShare, withoutShare }
}

/** The capture root is a document card whose ::before comes from the DOCUMENT sheet, and it
 *  holds a host whose shadow root contains a card of the same class whose ::before comes from
 *  that root's OWN sheet. Before the namespace fix both cards interned to the same 'R' id. */
function mountRootVersusShadowChild() {
  const style = document.createElement('style')
  style.textContent = '.vr{display:block;width:200px;background:rgb(255,255,255);margin:0;padding:0}'
    + '.vr::before{content:"D";display:block;width:40px;height:20px;background:rgb(255,0,0)}'
    + '.vsh{display:block;width:100px;height:20px}'
  document.head.appendChild(style)
  cleanups.push(() => style.remove())

  const root = document.createElement('div')
  root.className = 'vr'
  const host = document.createElement('div')
  host.className = 'vsh'
  host.attachShadow({ mode: 'open' }).innerHTML =
    '<style>.vr{display:block;width:100px;height:20px;margin:0;padding:0}'
    + '.vr::before{content:"S";display:block;width:40px;height:20px;background:rgb(0,0,255)}</style>'
    + '<div class="vr"></div>'
  root.appendChild(host)
  document.body.appendChild(root)
  cleanups.push(() => root.remove())
  return root
}

describe('cross-shadow-root identity sharing', () => {
  it('two roots with different ::before rules produce one payload and paint their own block', async () => {
    const build = fixtureByName('pseudo-split-shadow-cards').build
    const { withShare, withoutShare } = await payloadPerArm(build, true, false)
    // The payload is the oracle: the two subtrees are structural twins, so before the fix the
    // second root's ::before was handed the first root's snapshot and two letters and two
    // background colors collapsed onto one.
    expect(withShare).toBe(withoutShare)

    const { root, dispose } = build()
    cleanups.push(dispose)
    await settle()
    const canvas = await snapdom.toCanvas(root, arm(true))
    // Two 60x20 blocks side by side: root A red over x 0..60, root B blue over x 80..140.
    expect(pixel(canvas, 30, 10)).toEqual([255, 0, 0])
    expect(pixel(canvas, 110, 10)).toEqual([0, 0, 255])
  })

  it('the capture root and a shadow root\'s top-level child never share a pseudo key', async () => {
    const { withShare, withoutShare } = await payloadPerArm(mountRootVersusShadowChild, true, false)
    expect(withShare).toBe(withoutShare)

    const root = mountRootVersusShadowChild()
    await settle()
    const canvas = await snapdom.toCanvas(root, arm(true))
    // The root's own document-sheet ::before sits at 0,0 and the shadow card's ::before below
    // it. Before the fix the shadow block inherited the root's red snapshot.
    expect(pixel(canvas, 10, 10)).toEqual([255, 0, 0])
    expect(pixel(canvas, 10, 30)).toEqual([0, 0, 255])
  })

  it('refuses every shadow node an identity and serves no pseudo snapshot across roots', async () => {
    for (const fixture of SHADOW_FIXTURES) {
      if (!fixtureSupported(fixture)) continue
      const counted = await census(fixture, (root, share) =>
        snapdom.toRaw(root, { ...arm(true), __styleShareCounters: share }))
      // Every shadow node in the fixture was refused, which is what scopes the identity
      // namespace to the document tree.
      expect(counted.share.outOfTree, fixture.name).toBe(counted.nodes.shadowNodes)
      // A miss is one document node's own first snapshot, so more misses than document nodes
      // would mean a refused shadow node reached the share anyway.
      expect(counted.share.elementMisses, fixture.name)
        .toBeLessThanOrEqual(counted.nodes.documentNodes)
      // The pseudo share never fires inside a shadow root, so it can never cross one.
      expect(counted.share.pseudoHits, fixture.name).toBe(0)
    }
  })

  it('still shares light-DOM twins, so the refusal is scoped to other trees', async () => {
    const counted = await census(fixtureByName('document-uniform-cards'), (root, share) =>
      snapdom.toRaw(root, { ...arm(true), __styleShareCounters: share }))
    expect(counted.share.outOfTree).toBe(0)
    expect(counted.nodes.shadowNodes).toBe(0)
    // Nothing was pre-shared: every document node paid its own first snapshot, and every twin
    // after the first of each shape found one.
    expect(counted.share.elementMisses).toBe(counted.nodes.documentNodes)
    expect(counted.share.elementHits).toBe(counted.nodes.documentNodes - 2)
    // Exactly two distinct keys: the wrapper and the card.
    expect(counted.share.identities).toBe(2)
  })
})
