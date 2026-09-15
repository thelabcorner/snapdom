import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
let originalLang = null

beforeEach(() => {
  originalLang = document.documentElement.getAttribute('lang')
  document.documentElement.removeAttribute('lang')
})

afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  if (originalLang === null) document.documentElement.removeAttribute('lang')
  else document.documentElement.setAttribute('lang', originalLang)
  originalLang = null
  flushStyleInvalidations()
})

function mountScene(extraCSS = '', count = 240) {
  const style = document.createElement('style')
  style.textContent = `
    .r4-root { width:900px; font:13px/1.35 Arial,sans-serif; }
    .r4-grid { display:grid; grid-template-columns:repeat(8,1fr); gap:4px; }
    .r4-card { padding:4px; color:#222; background:#fafafa; }
    .r4-value { color:rgb(37,99,235); font-weight:700; }
    ${extraCSS}
  `
  document.head.appendChild(style)
  mounted.push(style)

  const root = document.createElement('div')
  root.className = 'r4-root'
  let html = '<div class="r4-grid">'
  for (let i = 0; i < count; i++) {
    html += `<div class="r4-card" data-row="${i}"><span class="r4-value" data-metric="${i}">${1000 + i}</span></div>`
  }
  root.innerHTML = html + '</div>'
  document.body.appendChild(root)
  mounted.push(root)
  flushStyleInvalidations()
  return { root, style }
}

async function captureReads(root, options = {}) {
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
      ...options,
    })
    return { raw, reads }
  } finally {
    proto.getPropertyValue = original
  }
}

describe('CSS-unobserved data-* style-share identity', () => {
  it('shares across unique metadata without removing that metadata from the output', async () => {
    const a = mountScene()
    const narrowed = await captureReads(a.root)
    a.root.remove()
    a.style.remove()

    const b = mountScene()
    const fullIdentity = await captureReads(b.root, { __styleShareDataAttrs: false })

    expect(narrowed.raw).toBe(fullIdentity.raw)
    expect(narrowed.raw).toContain('data-metric%3D%220%22')
    expect(narrowed.raw).toContain('data-metric%3D%22239%22')
    expect(narrowed.reads).toBeLessThan(fullIdentity.reads * 0.45)
  })

  it('retains metadata that an attribute selector can observe', async () => {
    const css = `
      .r4-value[data-metric="17"] { color:rgb(220,38,38); }
      .r4-card[data-row] { --r4-observed:1; }
    `
    const a = mountScene(css)
    const r4 = await captureReads(a.root)
    a.root.remove()
    a.style.remove()

    const b = mountScene(css)
    const fullIdentity = await captureReads(b.root, { __styleShareDataAttrs: false })

    expect(r4.raw).toBe(fullIdentity.raw)
    expect(r4.reads).toBeGreaterThan(fullIdentity.reads * 0.9)
  })

  it('refreshes the dependency proof after an explicit CSSOM invalidation', async () => {
    const { root, style } = mountScene('', 80)
    await snapdom.toRaw(root, { burst: false })
    style.sheet.insertRule('.r4-value[data-metric="17"] { color:rgb(220,38,38); }')

    const r4 = await snapdom.toRaw(root, { burst: false, invalidate: true, __styleShare: true })
    const fullIdentity = await snapdom.toRaw(root, {
      burst: false,
      invalidate: true,
      __styleShare: true,
      __styleShareDataAttrs: false,
    })
    expect(r4).toBe(fullIdentity)
  })

  it('keeps data metadata when an inline declaration contains attr()', async () => {
    const css = '.r4-card[data-row] { --r4-observed:1; }'
    const a = mountScene(css, 120)
    for (const el of a.root.querySelectorAll('.r4-value')) {
      // Custom properties preserve attr() syntax even on engines that do not support typed
      // attr() in ordinary properties, so this pins the identity boundary cross-browser.
      el.style.setProperty('--r4-inline', 'attr(data-metric)')
    }
    const r4 = await captureReads(a.root)
    a.root.remove()
    a.style.remove()

    const b = mountScene(css, 120)
    for (const el of b.root.querySelectorAll('.r4-value')) {
      el.style.setProperty('--r4-inline', 'attr(data-metric)')
    }
    const fullIdentity = await captureReads(b.root, { __styleShareDataAttrs: false })

    expect(r4.raw).toBe(fullIdentity.raw)
    expect(r4.reads).toBeGreaterThan(fullIdentity.reads * 0.9)
  })
})
