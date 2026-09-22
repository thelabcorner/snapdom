// The pseudo pass snapshots a pseudo-element's computed style the way styles.js snapshots the
// element's: pruned to the property universe, and SHARED between identity twins with only the
// used-value props re-read per twin (pseudoSnapshotFor). Both are byte-exact by construction;
// these pin it, plus the one thing a twin must never inherit — a used width.
import { describe, it, expect, afterEach } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations, pseudoSnapshotFor } from '../src/modules/styles.js'

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

  it('R8-P1 lazy overlay + key reuse is byte-identical to historical pseudo copies and key builds', async () => {
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

  it('admits overlays prospectively: occurrences #2/#3 spread, #4+ overlay', async () => {
    const el = mount(
      '<div class="lazy"></div>'.repeat(4),
      '.lazy::before{content:"x";display:inline-block;width:9px;height:7px;color:#246}',
    )
    await settle()
    const hosts = [...el.querySelectorAll('.lazy')]
    const ids = new WeakMap(hosts.map((host) => [host, 1]))
    const session = { __styleShare: { ids } }
    const options = {
      __styleShare: true,
      __styleSharePseudoOverlay: true,
      __styleSharePseudoKeyCache: false,
    }
    const snaps = hosts.map((host) => pseudoSnapshotFor(
      host,
      '::before',
      getComputedStyle(host, '::before'),
      session,
      options,
    ))
    expect(Object.getPrototypeOf(snaps[1])).toBe(Object.prototype)
    expect(Object.getPrototypeOf(snaps[2])).toBe(Object.prototype)
    expect(Object.getPrototypeOf(snaps[3])).not.toBe(Object.prototype)
  })

  it('keeps overlay and pseudo-key reuse independently byte-identical in the 2x2 factorial', async () => {
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

  it('keeps pair-only and triple-only pseudo identities on byte-identical protected paths', async () => {
    for (const [count, prefix] of [[2, 'pair'], [3, 'triple']]) {
      let html = '<div class="ps">'
      let css = ''
      for (let i = 0; i < 18; i++) {
        for (let j = 0; j < count; j++) html += `<div class="${prefix} p${i}">${j}</div>`
        css += `.p${i}::before{content:"[";display:inline-block;width:${5 + (i % 5)}px;color:rgb(${40 + i},0,0)}`
        css += `.p${i}::after{content:"]";display:inline-block;width:${7 + (i % 6)}px;color:rgb(0,0,${60 + i})}`
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
      expect(optimized, prefix).toBe(historical)
      el.remove()
    }
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

  it('contains pessimistic key-cache breaker state to one capture', async () => {
    let html = '<div class="ps">'
    let css = '.tail::before{content:"<";display:inline-block;width:9px;color:#185}' +
      '.tail::after{content:">";display:inline-block;width:10px;color:#518}'
    for (let i = 0; i < 18; i++) {
      html += `<div class="head h${i}">a</div><div class="head h${i}">b</div>` +
        `<div class="head h${i}">c</div><div class="head h${i}">d</div>`
      css += `.h${i}::before{content:"[";display:inline-block;width:${5 + (i % 5)}px;color:rgb(${70 + i},0,0)}`
      css += `.h${i}::after{content:"]";display:inline-block;width:${7 + (i % 6)}px;color:rgb(0,0,${90 + i})}`
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
    expect(await snapdom.toRaw(el, opts)).toBe(await snapdom.toRaw(el, historicalOpts))
    await dirty(el)
    const optimizedAgain = await snapdom.toRaw(el, opts)
    await dirty(el)
    expect(optimizedAgain).toBe(await snapdom.toRaw(el, historicalOpts))
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
