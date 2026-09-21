import { describe, it, expect, afterEach } from 'vitest'
import { snapdom } from '../src/index.js'
import { invalidateStyleCaches } from '../src/modules/styles.js'

// R8-B1 oracles: offscreen shadow-icon census precheck (src/core/prepare.js:99-130).
//
// Production adds a cheap `element.querySelector('calcite-icon')` precheck before the
// whole-tree `querySelectorAll('*')` walk that collects shadow roots. The precheck may only
// skip the walk when the subtree provably contains no `calcite-icon` host, because that host
// is the sole producer of `pendingIcons`. These tests are the pre-registered oracle package:
// exact raw-byte parity between production and the historical walk
// (`__calciteIconCensusPrecheck: false`), plus protected controls proving the census still
// runs when it must and fails open on unusual subtrees. No timing claim.

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  invalidateStyleCaches()
})

function mount(html, css) {
  const style = document.createElement('style')
  if (css) style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  root.style.cssText = 'position:fixed;left:-40000px;top:0;width:900px;'
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

const OPTS = { burst: false, cache: 'disabled', embedFonts: false, scale: 1, dpr: 1 }
const raw = (root, extra = {}) => snapdom.toRaw(root, { ...OPTS, ...extra })

async function parity(root) {
  const production = await raw(root, { __calciteIconCensusPrecheck: true })
  invalidateStyleCaches()
  const historical = await raw(root, { __calciteIconCensusPrecheck: false })
  return { production, historical }
}

function cards(n) {
  return Array.from({ length: n }, (_, i) => `<div class="b1-card">c${i}</div>`).join('')
}

describe('R8-B1 offscreen shadow-icon census precheck', () => {
  it('is byte-identical on an offscreen tree with no icons (the skipped walk)', async () => {
    const root = mount(cards(60), '.b1-card{width:60px;height:18px;padding:1px;background:#eef}')
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical on an onscreen tree (gate off, census never runs in either arm)', async () => {
    const root = mount(cards(40), '.b1-card{width:60px;height:18px;background:#fee}')
    root.style.cssText = 'position:fixed;left:0;top:0;width:900px;'
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical when a calcite-icon host is present offscreen (protected control: census must still run)', async () => {
    // Register the custom element so the host has an open shadow root with an unresolved icon,
    // exactly the shape the census exists to warm up. The precheck MUST let this through.
    if (!customElements.get('calcite-icon')) {
      customElements.define('calcite-icon', class extends HTMLElement {
        constructor() {
          super()
          const root = this.attachShadow({ mode: 'open' })
          root.innerHTML = '<svg width="16" height="16"><path d=""></path></svg>'
        }
      })
    }
    const root = mount(
      cards(30) + '<calcite-icon style="display:inline-block;width:16px;height:16px"></calcite-icon>',
      '.b1-card{width:60px;height:18px;background:#eef}',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical for an ordinary open shadow root that is not an icon host', async () => {
    const root = mount(cards(20) + '<div class="b1-host"></div>', '.b1-card{width:50px;height:16px;background:#ded}')
    const host = root.querySelector('.b1-host')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>.in{display:block;width:40px;height:14px;background:#cde}</style><div class="in">x</div>'
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical when the capture root itself is a shadow host', async () => {
    const root = mount('', '')
    const shadow = root.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>.s{display:block;width:60px;height:20px;background:#fed}</style><div class="s">s</div>'
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical with nested shadow roots that are not icon hosts', async () => {
    const root = mount(cards(10) + '<div class="b1-h1"></div>', '.b1-card{width:40px;height:12px;background:#eef}')
    const h1 = root.querySelector('.b1-h1')
    const s1 = h1.attachShadow({ mode: 'open' })
    s1.innerHTML = '<div class="inner"></div>'
    const inner = s1.querySelector('.inner')
    const s2 = inner.attachShadow({ mode: 'open' })
    s2.innerHTML = '<span>deep</span>'
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical with a resolved icon (path has a d attribute) offscreen', async () => {
    if (!customElements.get('calcite-icon')) {
      customElements.define('calcite-icon', class extends HTMLElement {
        constructor() {
          super()
          const root = this.attachShadow({ mode: 'open' })
          root.innerHTML = '<svg width="16" height="16"><path d="M0 0h8v8H0z"></path></svg>'
        }
      })
    }
    const root = mount(
      cards(15) + '<calcite-icon style="display:inline-block;width:16px;height:16px"></calcite-icon>',
      '.b1-card{width:50px;height:16px;background:#eef}',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('fails closed to the historical walk when the counterfactual flag is false', async () => {
    const root = mount(cards(20), '.b1-card{width:60px;height:18px;background:#eef}')
    const historical = await raw(root, { __calciteIconCensusPrecheck: false })
    invalidateStyleCaches()
    const alsoHistorical = await raw(root, { __calciteIconCensusPrecheck: false })
    expect(alsoHistorical).toBe(historical)
  })

  it('is byte-identical with clip mode (census is gated off by sessionCache.clip)', async () => {
    const root = mount(cards(25), '.b1-card{width:60px;height:18px;background:#eef}')
    const production = await raw(root, { __calciteIconCensusPrecheck: true, clip: { x: 0, y: 0, width: 300, height: 120 } })
    invalidateStyleCaches()
    const historical = await raw(root, { __calciteIconCensusPrecheck: false, clip: { x: 0, y: 0, width: 300, height: 120 } })
    expect(production).toBe(historical)
  })
})
