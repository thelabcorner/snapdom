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
  flushStyleInvalidations()
})

function scene(extraCSS = '') {
  const style = document.createElement('style')
  style.textContent = `
    .r4-root { width:800px; font:13px Arial,sans-serif; }
    .r4-row { display:block; color:rgb(20,30,40); padding:2px 4px; }
    ${extraCSS}
  `
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  root.className = 'r4-root'
  let html = ''
  for (let i = 0; i < 160; i++) html += `<span class="r4-row" data-metric="${i}">row ${i}</span>`
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  flushStyleInvalidations()
  return root
}

async function capture(root, options = {}) {
  const proto = CSSStyleDeclaration.prototype
  const original = proto.getPropertyValue
  let reads = 0
  proto.getPropertyValue = function (...args) {
    reads++
    return original.apply(this, args)
  }
  try {
    const raw = await snapdom.toRaw(root, { burst: false, cache: 'disabled', ...options })
    return { raw, reads }
  } finally {
    proto.getPropertyValue = original
  }
}

describe('CSS-unobservable data-* style identity', () => {
  it('shares style snapshots across unique metadata without changing output bytes', async () => {
    const fastRoot = scene()
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene()
    const full = await capture(fullRoot, { __styleShare: false })

    expect(fast.raw).toBe(full.raw)
    expect(fast.reads).toBeLessThan(full.reads * 0.55)
  })

  it('keeps a data attribute in identity when an attribute selector observes it', async () => {
    const css = '.r4-row[data-metric="17"] { color:rgb(200,10,20); }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleShare: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('keeps a data attribute in identity when :has() observes a descendant', async () => {
    const css = '.r4-root:has(.r4-row[data-metric="17"]) .r4-row { font-weight:700; }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleShare: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('keeps a data attribute in identity when attr() observes its value', async () => {
    const css = '.r4-row::before { content:attr(data-metric); margin-right:2px; }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleShare: false })
    expect(fast.raw).toBe(full.raw)
  })
})
