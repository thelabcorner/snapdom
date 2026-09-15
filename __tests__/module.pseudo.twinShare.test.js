// The pseudo pass snapshots a pseudo-element's computed style the way styles.js snapshots the
// element's: pruned to the property universe, and SHARED between identity twins with only the
// used-value props re-read per twin (pseudoSnapshotFor). Both are byte-exact by construction;
// these pin it, plus the one thing a twin must never inherit — a used width.
import { describe, it, expect, afterEach } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop().remove() })

function mount(html, css) {
  const st = document.createElement('style')
  st.textContent = css
  document.head.appendChild(st)
  mounted.push(st)
  const el = document.createElement('div')
  el.style.cssText = 'width:480px;background:#fff;font:14px Arial'
  el.innerHTML = html
  document.body.appendChild(el)
  mounted.push(el)
  return el
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0))
  flushStyleInvalidations()
}

async function dirty(el) {
  el.setAttribute('data-probe-dirty', '1')
  el.removeAttribute('data-probe-dirty')
  await settle()
}

describe('pseudo snapshots shared between identity twins', () => {
  it('a list of twin ::before is byte-identical with the share off', async () => {
    const el = mount(
      '<ul class="ps">' + '<li>item</li>'.repeat(40) + '</ul>',
      '.ps li::before{content:"\\2022";display:inline-block;width:12px;color:#c00;font-weight:700;margin-right:4px}')
    await settle()
    await snapdom.toRaw(el, { burst: false })
    await dirty(el)
    const on = await snapdom.toRaw(el, { burst: false })
    await dirty(el)
    const off = await snapdom.toRaw(el, { burst: false, __styleShare: false })
    expect(on).toBe(off)
  })

  it('R7-P overlay + key reuse is byte-identical to historical pseudo copies and key builds', async () => {
    const el = mount(
      '<div class="ps">' + '<div class="pt">item</div>'.repeat(80) + '</div>',
      '.pt::before{content:"[";display:inline-block;width:8px;color:#c00}' +
      '.pt::after{content:"]";display:inline-block;width:8px;color:#00c}',
    )
    await settle()
    const opts = { burst: false, cache: 'disabled', embedFonts: false }
    const optimized = await snapdom.toRaw(el, opts)
    const historical = await snapdom.toRaw(el, {
      ...opts,
      __styleSharePseudoOverlay: false,
      __styleSharePseudoKeyCache: false,
    })
    expect(optimized).toBe(historical)
  })

  it('R7-P overlay and pseudo-key reuse are independently byte-identical in the full 2x2 factorial', async () => {
    const el = mount(
      '<div class="ps">' + '<div class="pt">item</div>'.repeat(64) + '</div>',
      '.pt::before{content:"[";display:inline-block;width:8px;color:#c00}' +
      '.pt::after{content:"]";display:inline-block;width:11px;color:#00c}',
    )
    await settle()
    const opts = { burst: false, cache: 'disabled', embedFonts: false }
    const cells = []
    for (const pseudoOverlay of [false, true]) {
      for (const pseudoKeyCache of [false, true]) {
        cells.push(await snapdom.toRaw(el, {
          ...opts,
          __styleSharePseudoOverlay: pseudoOverlay,
          __styleSharePseudoKeyCache: pseudoKeyCache,
        }))
      }
    }
    expect(new Set(cells).size).toBe(1)
  })

  it('pair-only unique pseudo styles stay byte-identical when key caching waits for a third occurrence', async () => {
    let html = '<div class="ps">'
    let css = ''
    for (let i = 0; i < 12; i++) {
      html += `<div class="pair p${i}">a</div><div class="pair p${i}">b</div>`
      css += `.p${i}::before{content:"[";display:inline-block;width:${6 + (i % 3)}px;color:rgb(${20 + i},0,0)}`
      css += `.p${i}::after{content:"]";display:inline-block;width:${8 + (i % 4)}px;color:rgb(0,0,${40 + i})}`
    }
    html += '</div>'
    const el = mount(html, css)
    await settle()
    const opts = { burst: false, cache: 'disabled', embedFonts: false }
    const optimized = await snapdom.toRaw(el, opts)
    const historical = await snapdom.toRaw(el, {
      ...opts,
      __styleSharePseudoOverlay: false,
      __styleSharePseudoKeyCache: false,
    })
    expect(optimized).toBe(historical)
  })

  it('triple-only unique pseudo styles stay byte-identical when the miss circuit breaker falls back', async () => {
    let html = '<div class="ps">'
    let css = ''
    for (let i = 0; i < 18; i++) {
      html += `<div class="triple t${i}">a</div><div class="triple t${i}">b</div><div class="triple t${i}">c</div>`
      css += `.t${i}::before{content:"[";display:inline-block;width:${5 + (i % 5)}px;color:rgb(${40 + i},0,0)}`
      css += `.t${i}::after{content:"]";display:inline-block;width:${7 + (i % 6)}px;color:rgb(0,0,${60 + i})}`
    }
    html += '</div>'
    const el = mount(html, css)
    await settle()
    const opts = { burst: false, cache: 'disabled', embedFonts: false }
    const optimized = await snapdom.toRaw(el, opts)
    const historical = await snapdom.toRaw(el, {
      ...opts,
      __styleSharePseudoOverlay: false,
      __styleSharePseudoKeyCache: false,
    })
    expect(optimized).toBe(historical)
  })

  it('a pessimistic miss-breaker decision only forfeits later reuse and never leaks across captures', async () => {
    let html = '<div class="ps">'
    let css = '.tail::before{content:"<";display:inline-block;width:9px;color:#185}.tail::after{content:">";display:inline-block;width:10px;color:#518}'
    // Put enough heterogeneous triples first to trip the 16-miss breaker before the homogeneous
    // tail. A false pessimistic routing decision is allowed to lose optimization, never bytes.
    for (let i = 0; i < 18; i++) {
      html += `<div class="head h${i}">a</div><div class="head h${i}">b</div><div class="head h${i}">c</div>`
      css += `.h${i}::before{content:"[";width:${5 + (i % 5)}px;color:rgb(${70 + i},0,0)}`
      css += `.h${i}::after{content:"]";width:${7 + (i % 6)}px;color:rgb(0,0,${90 + i})}`
    }
    html += '<div class="tail">tail</div>'.repeat(80) + '</div>'
    const el = mount(html, css)
    await settle()
    const opts = { burst: false, cache: 'disabled', embedFonts: false }
    const historicalOpts = {
      ...opts,
      __styleSharePseudoOverlay: false,
      __styleSharePseudoKeyCache: false,
    }
    const optimized = await snapdom.toRaw(el, opts)
    const historical = await snapdom.toRaw(el, historicalOpts)
    expect(optimized).toBe(historical)

    // A second capture owns a fresh session. The first capture's disabled cache state must not
    // escape into it; output parity is the semantic guard while the deterministic probe pins the
    // renewed cache hits separately.
    await dirty(el)
    const optimizedAgain = await snapdom.toRaw(el, opts)
    await dirty(el)
    const historicalAgain = await snapdom.toRaw(el, historicalOpts)
    expect(optimizedAgain).toBe(historicalAgain)
  })

  it('repairs the compact pseudo signature after the flex/grid min-width floor', async () => {
    const el = mount(
      '<div class="ps">' + '<div class="flex-host">item</div>'.repeat(60) + '</div>',
      '.flex-host{display:flex;width:120px}.flex-host::before{' +
      'content:"";display:inline-block;box-sizing:border-box;width:8px;height:8px;background:#26f}',
    )
    await settle()
    const opts = { burst: false, cache: 'disabled', embedFonts: false }
    const optimized = await snapdom.toRaw(el, opts)
    const historical = await snapdom.toRaw(el, {
      ...opts,
      __styleSharePseudoOverlay: false,
      __styleSharePseudoKeyCache: false,
    })
    expect(optimized).toBe(historical)
  })

  it('a %-wide ::before keeps its own used width under a wider twin', async () => {
    // Twins under 120px and 320px grid columns; `width:50%` on the pseudo resolves to 60px
    // and 160px. A shared width would give the wide twin a 60px bar.
    const el = mount(
      '<div class="pg"><div class="pc"><div class="pt"></div></div><div class="pc"><div class="pt"></div></div></div>',
      '.pg{display:grid;grid-template-columns:120px 320px}.pt{height:20px}' +
      '.pt::before{content:"";display:block;width:50%;height:20px;background:#0000e0}')
    await settle()
    const c = await snapdom.toCanvas(el, { scale: 1, dpr: 1, burst: false })
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    // Blue run on the pseudo's row inside the WIDE column (x from 120 on): expect ~160px.
    let wide = 0
    for (let x = 120; x < c.width; x++) {
      const i = (10 * c.width + x) * 4
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0xe0) wide++
    }
    expect(wide).toBeGreaterThan(150)
    expect(wide).toBeLessThan(170)
  })
})
