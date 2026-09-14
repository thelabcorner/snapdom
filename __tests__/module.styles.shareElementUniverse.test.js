import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
let originalDocumentLang = null

beforeEach(() => {
  // The Vitest browser host carries <html lang="...">. R3 deliberately treats inherited
  // language as a conservative escape because UA/language-sensitive style can exist outside
  // the author stylesheet model. Neutralize that harness-only state so this experiment actually
  // exercises R3 composition; dedicated fallback tests keep the language escape covered.
  originalDocumentLang = document.documentElement.getAttribute('lang')
  document.documentElement.removeAttribute('lang')
})

afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  if (originalDocumentLang === null) document.documentElement.removeAttribute('lang')
  else document.documentElement.setAttribute('lang', originalDocumentLang)
  originalDocumentLang = null
  flushStyleInvalidations()
})

function mount(css, build) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  build(root)
  document.body.appendChild(root)
  mounted.push(root)
  flushStyleInvalidations()
  return root
}

async function capture(root, compose, extra = {}) {
  const proto = CSSStyleDeclaration.prototype
  const original = proto.getPropertyValue
  let reads = 0
  proto.getPropertyValue = function (...args) {
    reads++
    return original.apply(this, args)
  }
  try {
    const raw = await snapdom.toRaw(root, {
      burst: false,
      cache: 'disabled',
      __styleShare: true,
      __styleShareElementUniverse: compose,
      ...extra,
    })
    return { raw, reads }
  } finally {
    proto.getPropertyValue = original
  }
}

describe('R5 R2/R3 composition', () => {
  it('removes the high-entropy full-universe pessimization without changing bytes', async () => {
    const make = () => mount(`
      .r5c-root { width: 900px; font: 13px/1.35 Arial, sans-serif; }
      .r5c-row { display:block; padding:2px 4px; color:#334155; }
    `, (root) => {
      root.className = 'r5c-root'
      for (let i = 0; i < 400; i++) {
        const el = document.createElement('span')
        // Unique, deliberately unused class token makes every R2 identity distinct.
        el.className = `r5c-row entropy-${i}`
        el.textContent = `row ${i}`
        root.appendChild(el)
      }
    })

    const composedRoot = make()
    const composed = await capture(composedRoot, undefined)
    composedRoot.remove()

    const historicalRoot = make()
    const historical = await capture(historicalRoot, false)

    expect(composed.raw).toBe(historical.raw)
    // This is intentionally a coarse mechanism gate, not an acceptance benchmark. P1 measured
    // ~69k reads on the historical share path and ~36k with R3. Composition should recover a
    // substantial fraction of that headroom before we spend timing budget.
    expect(composed.reads).toBeLessThan(historical.reads * 0.8)
  })

  it('keeps real identity twins byte-identical while sharing a narrowed first snapshot', async () => {
    const make = () => mount(`
      .r5c-twins { width: 720px; font: 14px Arial, sans-serif; }
      .r5c-twin { display:block; color:rgb(37,99,235); padding:3px 5px; }
    `, (root) => {
      root.className = 'r5c-twins'
      for (let i = 0; i < 300; i++) {
        const el = document.createElement('span')
        el.className = 'r5c-twin'
        // R4 proves this metadata CSS-unobservable, so all rows intentionally share one identity.
        el.dataset.metric = String(i)
        el.textContent = `value ${i}`
        root.appendChild(el)
      }
    })

    const composedRoot = make()
    const composed = await capture(composedRoot, undefined)
    composedRoot.remove()
    const historicalRoot = make()
    const historical = await capture(historicalRoot, false)

    expect(composed.raw).toBe(historical.raw)
    // One identity miss followed by 299 hits must never activate R3. Exact counts can move by
    // a handful of once-per-capture cache/probe reads between fresh fixtures, so gate on a tight
    // no-regression band rather than pretending those six reads are deterministic semantics.
    expect(composed.reads).toBeLessThanOrEqual(historical.reads * 1.01)
  })

  it('preserves selector-partitioned structural differences', async () => {
    const css = `
      .r5c-struct { width: 700px; }
      .r5c-item { display:block; padding:2px; color:rgb(15,23,42); }
      .r5c-item:nth-child(odd) { color:rgb(190,18,60); }
      .r5c-item + .r5c-item { border-top:1px solid rgb(203,213,225); }
    `
    const make = () => mount(css, (root) => {
      root.className = 'r5c-struct'
      for (let i = 0; i < 80; i++) {
        const el = document.createElement('span')
        el.className = 'r5c-item'
        el.textContent = `item ${i}`
        root.appendChild(el)
      }
    })

    const composedRoot = make()
    const composed = await capture(composedRoot, undefined)
    composedRoot.remove()
    const historicalRoot = make()
    const historical = await capture(historicalRoot, false)

    expect(composed.raw).toBe(historical.raw)
  })

  it('keeps the adaptive router on pure R2 for one-identity trees', async () => {
    const make = () => mount(`
      .r5c-card-root { width: 720px; font: 14px Arial, sans-serif; }
      .r5c-card-row { display:block; color:rgb(37,99,235); padding:3px 5px; }
    `, (root) => {
      root.className = 'r5c-card-root'
      for (let i = 0; i < 300; i++) {
        const el = document.createElement('span')
        el.className = 'r5c-card-row'
        el.dataset.metric = String(i)
        el.textContent = `value ${i}`
        root.appendChild(el)
      }
    })

    const routedRoot = make()
    const routed = await capture(routedRoot, undefined)
    routedRoot.remove()
    const historicalRoot = make()
    const historical = await capture(historicalRoot, false)

    expect(routed.raw).toBe(historical.raw)
    expect(routed.reads).toBeLessThanOrEqual(historical.reads * 1.01)
  })

  it('is insensitive to clustered vs interleaved arrival order at the same identity cardinality', async () => {
    const make = (interleaved) => mount(`
      .r5c-order-root { width: 820px; font: 13px Arial, sans-serif; }
      .r5c-order-row { display:block; color:#334155; padding:2px 4px; }
    `, (root) => {
      root.className = 'r5c-order-root'
      const n = 320
      const k = 32
      for (let i = 0; i < n; i++) {
        const el = document.createElement('span')
        const group = interleaved ? i % k : Math.min(k - 1, Math.floor(i * k / n))
        el.className = `r5c-order-row entropy-${group}`
        el.textContent = `row ${i}`
        root.appendChild(el)
      }
    })

    for (const interleaved of [false, true]) {
      const routedRoot = make(interleaved)
      const routed = await capture(routedRoot, undefined)
      routedRoot.remove()
      const historicalRoot = make(interleaved)
      const historical = await capture(historicalRoot, false)
      historicalRoot.remove()

      expect(routed.raw).toBe(historical.raw)
      expect(routed.reads).toBeLessThan(historical.reads * 0.9)
    }
  })

  it('keeps adaptive SU on R2 when residual unkeyed selector work exceeds its safety budget', async () => {
    let unused = ''
    // Keep these deliberately outside D2's direct-attribute key domain. A functional-pseudo
    // argument is not treated as a necessary subject key, so this remains a true residual-rule
    // budget test even when direct `[data-*]` selectors become indexable.
    for (let i = 0; i < 300; i++) unused += `:is([data-r5c-never-${i}]){outline-offset:${i % 3}px}`
    const make = () => mount(`
      .r5c-budget-root { width:820px; font:13px Arial,sans-serif; }
      .r5c-budget-row { display:block; color:#334155; padding:2px 4px; }
      ${unused}
    `, (root) => {
      root.className = 'r5c-budget-root'
      for (let i = 0; i < 120; i++) {
        const el = document.createElement('span')
        el.className = `r5c-budget-row entropy-${i}`
        el.textContent = `row ${i}`
        root.appendChild(el)
      }
    })

    const adaptiveRoot = make()
    const adaptive = await capture(adaptiveRoot, undefined)
    adaptiveRoot.remove()
    const historicalRoot = make()
    const historical = await capture(historicalRoot, false)
    historicalRoot.remove()
    const forcedRoot = make()
    const forced = await capture(forcedRoot, true)

    expect(adaptive.raw).toBe(historical.raw)
    expect(forced.raw).toBe(historical.raw)
    // Adaptive routing should preserve the R2 read profile, while the forced semantic
    // counterfactual still proves R3 composition is capable of narrowing this exact scene.
    expect(adaptive.reads).toBeLessThanOrEqual(historical.reads * 1.01)
    expect(forced.reads).toBeLessThan(adaptive.reads * 0.8)
  })
})
