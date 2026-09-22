import { describe, it, expect, afterEach } from 'vitest'
import { snapdom } from '../src/index.js'
import {
  invalidateStyleCaches, pseudoSnapshotFor, pseudoStyleKeyForSnapshot, extendSnapshotSignature,
} from '../src/modules/styles.js'
import { getStyleKey } from '../src/utils/index.js'

// R8-E2 oracles: break-even pseudo reuse admission.
//
// The lazy-#4 design engaged overlay/signature/Map setup at occurrence #4; a quad-unique
// identity ends at #4, so it paid setup it could never amortize
// (pseudo-quads-unique-style-400 measured +4.16% CI[2.93,5.37]).
//
// E2 counts all occurrences, including the seed, and first admits reuse at #5.
// Past reuse does not guarantee a future cache hit: five-only identities are also protected.
//
// These tests assert EXACT raw-byte parity between the opt-in path and the historical
// counterfactual (BOTH pseudo flags false), across identity cardinalities, with the
// E1 kill cells (pairs/triples/quads) as protected controls. No timing claim.

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  invalidateStyleCaches()
})

const CSS = `
  .e2-root{width:900px;font:13px Arial,sans-serif}
  .e2-row{display:block;box-sizing:border-box;min-height:18px}
  .e2-row::before{content:"#";display:inline-block;width:12px;color:#64748b}
  .e2-row::after{content:"!";display:inline-block;width:8px;color:#94a3b8}
`

// `cardinality` = number of DISTINCT classes, so `nodes/cardinality` occurrences per identity.
function makeFixture(nodes, cardinality) {
  const style = document.createElement('style')
  let css = CSS
  for (let i = 0; i < cardinality; i++) {
    css += `.e2-row.g${i}::before{color:rgb(${(i * 47) % 256},${(i * 83) % 256},${(i * 131) % 256})}`
    css += `.e2-row.g${i}::after{color:rgb(${(i * 29) % 256},${(i * 71) % 256},${(i * 113) % 256})}`
  }
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  root.className = 'e2-root'
  let html = ''
  for (let i = 0; i < nodes; i++) html += `<div class="e2-row g${i % cardinality}">row ${i}</div>`
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

const OPTS = { burst: false, cache: 'disabled', embedFonts: false, scale: 1, dpr: 1 }
const HIST = { ...OPTS, __styleSharePseudoOverlay: false, __styleSharePseudoKeyCache: false }
const CAND = { ...OPTS, __styleSharePseudoOverlay: true, __styleSharePseudoKeyCache: true }

async function assertParity(root) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  invalidateStyleCaches()
  const a = await snapdom.toRaw(root, CAND)
  invalidateStyleCaches()
  const b = await snapdom.toRaw(root, HIST)
  expect(a).toContain('data-snapdom-pseudo')
  expect(a).toBe(b)
  return { a, b }
}

async function parity(nodes, cardinality) {
  return assertParity(makeFixture(nodes, cardinality))
}

describe('R8-E2 break-even pseudo reuse admission', () => {
  // cardinality === nodes/2 -> exactly 2 occurrences per identity (pair-only)
  it('is byte-identical for pair-only identities (occurrence #2)', async () => {
    const { a, b } = await parity(40, 20)
    expect(a).toBe(b)
  })

  // cardinality === nodes/3 -> exactly 3 occurrences (triple-only)
  it('is byte-identical for triple-only identities (occurrence #3) — E1 protected control', async () => {
    const { a, b } = await parity(60, 20)
    expect(a).toBe(b)
  })

  // cardinality === nodes/4 -> exactly 4 occurrences (quad-unique) — THE E1 KILL CELL
  it('is byte-identical for quad-unique identities (occurrence #4) — the E1 kill cell', async () => {
    const { a, b } = await parity(80, 20)
    expect(a).toBe(b)
  })

  // cardinality === nodes/5 -> 5 occurrences, machinery engages exactly at #5
  it('is byte-identical at the break-even boundary (occurrence #5, first engaged hit)', async () => {
    const { a, b } = await parity(100, 20)
    expect(a).toBe(b)
  })

  it('is byte-identical for long runs well past the threshold (many reuses)', async () => {
    const { a, b } = await parity(400, 20)
    expect(a).toBe(b)
  })

  it('is byte-identical for a single identity repeated many times', async () => {
    const { a, b } = await parity(200, 1)
    expect(a).toBe(b)
  })

  it('is byte-identical for unique-per-node identities (no reuse at all)', async () => {
    const { a, b } = await parity(120, 120)
    expect(a).toBe(b)
  })

  it('is byte-identical for a mixed-cardinality tree (pairs, triples, quads and long runs together)', async () => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    mounted.push(style)
    const root = document.createElement('div')
    root.className = 'e2-root'
    let html = ''
    for (let i = 0; i < 20; i++) html += `<div class="e2-row g0">pair ${i}</div>`     // 20x -> long run
    for (let i = 0; i < 6; i++) html += `<div class="e2-row g1">triple ${i}</div>`    // 6x
    for (let i = 0; i < 4; i++) html += `<div class="e2-row g2">quad ${i}</div>`      // 4x
    for (let i = 0; i < 2; i++) html += `<div class="e2-row g3">pair ${i}</div>`      // 2x
    root.innerHTML = html
    document.body.appendChild(root)
    mounted.push(root)
    await assertParity(root)
  })

  it('keeps ::before-only and ::after-only pseudos byte-identical', async () => {
    const style = document.createElement('style')
    style.textContent = `
      .e2b-root{width:900px;font:13px Arial}
      .e2b-row{display:block;min-height:18px}
      .e2b-row.b::before{content:"B";display:inline-block;width:10px}
      .e2b-row.a::after{content:"A";display:inline-block;width:10px}
    `
    document.head.appendChild(style)
    mounted.push(style)
    const root = document.createElement('div')
    root.className = 'e2b-root'
    let html = ''
    for (let i = 0; i < 40; i++) html += `<div class="e2b-row b">b${i}</div>`
    for (let i = 0; i < 40; i++) html += `<div class="e2b-row a">a${i}</div>`
    root.innerHTML = html
    document.body.appendChild(root)
    mounted.push(root)
    await assertParity(root)
  })

  it('fails closed for shadow-host pseudo sources regardless of occurrence count', async () => {
    const style = document.createElement('style')
    style.textContent = `
      .e2s-root{width:600px;font:13px Arial}
      .e2s-host{display:block;width:200px;height:40px}
    `
    document.head.appendChild(style)
    mounted.push(style)
    const root = document.createElement('div')
    root.className = 'e2s-root'
    root.innerHTML = '<div class="e2s-host"></div><div class="e2s-host"></div><div class="e2s-host"></div><div class="e2s-host"></div>'
    document.body.appendChild(root)
    mounted.push(root)
    for (const host of root.querySelectorAll('.e2s-host')) {
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML = '<style>.in{display:block;min-height:18px}.in::before{content:"S";display:inline-block;width:9px}</style><div class="in">s</div>'
    }
    await assertParity(root)
  })

  it('is byte-identical when the key-cache leg is disabled independently', async () => {
    const { a, b } = await parity(200, 20)
    expect(a).toBe(b)
    invalidateStyleCaches()
    const root = makeFixture(200, 20)
    const c = await snapdom.toRaw(root, { ...CAND, __styleSharePseudoKeyCache: false })
    expect(c).toBe(b)
  })

  it('proves #1-#4 allocate no overlay or key cache; #5 seeds and #6 actually hits', () => {
    const root = makeFixture(6, 1)
    const hosts = [...root.children]
    const session = { __styleShare: { ids: new WeakMap(hosts.map((host) => [host, 1])) } }
    for (let i = 0; i < hosts.length; i++) {
      const snap = pseudoSnapshotFor(hosts[i], '::before', getComputedStyle(hosts[i], '::before'),
        session, { ...CAND, __styleShare: true })
      const key = pseudoStyleKeyForSnapshot(snap, true, false, session)
      expect(key).toBe(getStyleKey(snap, 'span', true, false))
      if (i < 4) {
        expect(Object.getPrototypeOf(snap)).toBe(Object.prototype)
        expect(session.__pseudoStyleKeyCache).toBeUndefined()
      } else {
        expect(Object.getPrototypeOf(snap)).not.toBe(Object.prototype)
        expect(session.__pseudoStyleKeyCache.size).toBe(1)
        expect(session.__pseudoStyleKeyMissStreak).toBe(i === 4 ? 1 : 0)
      }
    }
  })

  it('keeps defaults and all four overlay/key-cache flag combinations byte-identical', async () => {
    const root = makeFixture(80, 2)
    const { b } = await assertParity(root)
    for (const overlay of [false, true]) {
      for (const keyCache of [false, true]) {
        invalidateStyleCaches()
        expect(await snapdom.toRaw(root, {
          ...OPTS, __styleSharePseudoOverlay: overlay, __styleSharePseudoKeyCache: keyCache,
        })).toBe(b)
      }
    }
    invalidateStyleCaches()
    expect(await snapdom.toRaw(root, OPTS)).toBe(b)
  })

  it('leaves default (no pseudo flags) byte-identical to historical R7 behavior', async () => {
    const root = makeFixture(120, 3)
    invalidateStyleCaches()
    const def = await snapdom.toRaw(root, OPTS)
    invalidateStyleCaches()
    const hist = await snapdom.toRaw(root, HIST)
    expect(def).toBe(hist)
  })

  it('keeps five-only and six-only unique-style identities byte-identical', async () => {
    await parity(100, 20)
    await parity(120, 20)
  })

  it.each(['flex', 'grid', 'percent', 'state-veto'])('preserves the %s adversary with real pseudos', async (mode) => {
    const root = makeFixture(80, 2)
    const sheet = document.createElement('style')
    sheet.textContent = mode === 'percent'
      ? '.e2-row{width:var(--w)}.e2-row::before{width:50%;padding-left:5%}'
      : mode === 'state-veto'
        ? '.e2-row:not(:hover)::before{outline-offset:0px}'
        : `.e2-row{display:${mode};width:180px}.e2-row::before{content:"";height:8px;min-width:auto}`
    document.head.appendChild(sheet)
    mounted.push(sheet)
    if (mode === 'percent') {
      for (const [i, host] of [...root.children].entries()) {
        host.style.setProperty('--w', i % 2 ? '420px' : '180px')
      }
    }
    await assertParity(root)
  })

  it('invalidates admitted signatures between captures after CSSOM mutation', async () => {
    const root = makeFixture(40, 1)
    const { a } = await assertParity(root)
    const sheet = mounted[mounted.length - 2].sheet
    sheet.insertRule('.e2-row::before{width:31px;color:rgb(19,29,39)}', sheet.cssRules.length)
    const { a: changed } = await assertParity(root)
    expect(changed).not.toBe(a)
  })

  it('uses empty rider tombstones without exposing the base and repairs post-snapshot signatures', () => {
    const root = makeFixture(7, 1)
    const hosts = [...root.children]
    const session = { __styleShare: { ids: new WeakMap(hosts.map((host) => [host, 1])) } }
    const options = { ...CAND, __styleShare: true }
    for (let i = 0; i < 4; i++) {
      pseudoSnapshotFor(hosts[i], '::before', getComputedStyle(hosts[i], '::before'), session, options)
    }
    const style = getComputedStyle(hosts[4], '::before')
    const snap = pseudoSnapshotFor(hosts[4], '::before', {
      getPropertyValue: (name) => name === 'width' ? '' : style.getPropertyValue(name),
    }, session, options)
    expect(snap.width).toBe('')
    expect(Object.getPrototypeOf(snap).width).not.toBe('')
    expect(pseudoStyleKeyForSnapshot(snap, false, true, session))
      .toBe(getStyleKey(snap, 'span', false, true))
    for (let i = 5; i < 7; i++) {
      const next = pseudoSnapshotFor(hosts[i], '::before', getComputedStyle(hosts[i], '::before'), session, options)
      next['min-width'] = i === 5 ? '0px' : '13px'
      extendSnapshotSignature(next, `pm\u0001min-width\u0001${next['min-width']}`)
      for (const content of [false, true]) {
        for (const flex of [false, true]) {
          expect(pseudoStyleKeyForSnapshot(next, content, flex, session))
            .toBe(getStyleKey(next, 'span', content, flex))
        }
      }
    }
    expect(pseudoStyleKeyForSnapshot(snap, false, true, null))
      .toBe(getStyleKey(snap, 'span', false, true))
  })

  it('trips the miss breaker, recovers for a hot tail, and starts the next capture clean', () => {
    const root = makeFixture(90, 18)
    const hosts = [...root.children]
    const options = { ...CAND, __styleShare: true }
    const ids = new WeakMap(hosts.map((host, i) => [host, i % 18]))
    const session = { __styleShare: { ids } }
    for (const host of hosts) {
      const snap = pseudoSnapshotFor(host, '::before', getComputedStyle(host, '::before'), session, options)
      expect(pseudoStyleKeyForSnapshot(snap, true, false, session))
        .toBe(getStyleKey(snap, 'span', true, false))
    }
    expect(session.__pseudoStyleKeyCacheDisabled).toBe(true)
    expect(session.__pseudoStyleKeyBreakerEpoch).toBe(1)
    const tail = makeFixture(8, 1)
    for (const host of tail.children) {
      ids.set(host, 100)
      const snap = pseudoSnapshotFor(host, '::before', getComputedStyle(host, '::before'), session, options)
      expect(pseudoStyleKeyForSnapshot(snap, true, false, session))
        .toBe(getStyleKey(snap, 'span', true, false))
    }
    expect(session.__pseudoStyleKeyCacheDisabled).toBe(false)
    expect(session.__pseudoStyleKeyMissStreak).toBe(0)
    const fresh = { __styleShare: { ids } }
    const host = tail.firstElementChild
    const snap = pseudoSnapshotFor(host, '::before', getComputedStyle(host, '::before'), fresh, options)
    pseudoStyleKeyForSnapshot(snap, true, false, fresh)
    expect(fresh.__pseudoStyleKeyCache).toBeUndefined()
    expect(fresh.__pseudoStyleKeyCacheDisabled).toBeUndefined()
  })
})
