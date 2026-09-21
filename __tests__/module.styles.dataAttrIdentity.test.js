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

function scene(extraCSS = '', inlineStyle = '', {
  attrName = 'data-metric',
  attrValue = (i) => String(i),
} = {}) {
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
  const styleAttr = inlineStyle ? ` style="${inlineStyle}"` : ''
  for (let i = 0; i < 160; i++) {
    html += `<span class="r4-row" ${attrName}="${attrValue(i)}"${styleAttr}>row ${i}</span>`
  }
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
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })

    expect(fast.raw).toBe(full.raw)
    expect(fast.reads).toBeLessThan(full.reads * 0.55)
  })

  it('keeps a data attribute in identity when an attribute selector observes it', async () => {
    const css = '.r4-row[data-metric="17"] { color:rgb(200,10,20); }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('keeps a data attribute in identity when :has() observes a descendant', async () => {
    const css = '.r4-root:has(.r4-row[data-metric="17"]) .r4-row { font-weight:700; }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('keeps a data attribute in identity when attr() observes its value', async () => {
    const css = '.r4-row::before { content:attr(data-metric); margin-right:2px; }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('does not disable R4 because an unrelated selector token is escaped', async () => {
    const css = '.utility\\:hover[data-mode="on"] { outline:1px solid red; }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })

    expect(fast.raw).toBe(full.raw)
    // This specifically catches the old document-wide "selector has a backslash" bailout.
    expect(fast.reads).toBeLessThan(full.reads * 0.55)
  })

  it('decodes an escaped data attribute name in an attribute selector', async () => {
    const css = '.r4-row[\\64 ata-metric="17"] { color:rgb(200,10,20); }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('decodes escaped attr() and escaped data attribute names', async () => {
    const css = '.r4-row::before { content:\\61 ttr(\\64 ata-metric); margin-right:2px; }'
    const fastRoot = scene(css)
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene(css)
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('treats inline attr(data-*) as an element-local identity dependency', async () => {
    const fastRoot = scene('', 'content:attr(data-metric)')
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene('', 'content:attr(data-metric)')
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('retains a data attribute observed by an ancestor selector', async () => {
    const css = '[data-theme="hot"] .r4-child { color:rgb(190,18,60); }'
    const make = () => {
      const style = document.createElement('style')
      style.textContent = `.r4-ancestor-root{width:700px}.r4-child{display:block}${css}`
      document.head.appendChild(style)
      mounted.push(style)
      const root = document.createElement('div')
      root.className = 'r4-ancestor-root'
      for (let i = 0; i < 100; i++) {
        const parent = document.createElement('div')
        parent.setAttribute('data-theme', i & 1 ? 'cold' : 'hot')
        const child = document.createElement('span')
        child.className = 'r4-child'
        child.textContent = `child ${i}`
        parent.appendChild(child)
        root.appendChild(parent)
      }
      document.body.appendChild(root)
      mounted.push(root)
      flushStyleInvalidations()
      return root
    }
    const fastRoot = make()
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = make()
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('retains a data attribute observed by a sibling selector', async () => {
    const style = document.createElement('style')
    style.textContent = '.r4-trigger[data-state="hot"] + .r4-row { color:rgb(21,128,61); }'
    document.head.appendChild(style)
    mounted.push(style)
    const make = () => {
      const root = document.createElement('div')
      root.className = 'r4-root'
      for (let i = 0; i < 100; i++) {
        const trigger = document.createElement('span')
        trigger.className = 'r4-trigger'
        trigger.setAttribute('data-state', i & 1 ? 'cold' : 'hot')
        const row = document.createElement('span')
        row.className = 'r4-row'
        row.textContent = `row ${i}`
        root.append(trigger, row)
      }
      document.body.appendChild(root)
      mounted.push(root)
      flushStyleInvalidations()
      return root
    }
    const fastRoot = make()
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = make()
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('tracks data dependencies in adopted stylesheets', async () => {
    if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('.r4-row[data-adopt="hot"] { color:rgb(124,58,237); }')
    const previous = document.adoptedStyleSheets
    document.adoptedStyleSheets = [...previous, sheet]
    try {
      const fastRoot = scene('', '', { attrName: 'data-adopt', attrValue: (i) => i & 1 ? 'cold' : 'hot' })
      const fast = await capture(fastRoot)
      fastRoot.remove()
      const fullRoot = scene('', '', { attrName: 'data-adopt', attrValue: (i) => i & 1 ? 'cold' : 'hot' })
      const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
      expect(fast.raw).toBe(full.raw)
    } finally {
      document.adoptedStyleSheets = previous
    }
  })

  it('tracks data dependencies added through CSSOM insertRule()', async () => {
    const style = document.createElement('style')
    document.head.appendChild(style)
    mounted.push(style)
    style.sheet.insertRule('.r4-row[data-dyn="hot"] { color:rgb(180,83,9); }', 0)
    flushStyleInvalidations()
    const fastRoot = scene('', '', { attrName: 'data-dyn', attrValue: (i) => i & 1 ? 'cold' : 'hot' })
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene('', '', { attrName: 'data-dyn', attrValue: (i) => i & 1 ? 'cold' : 'hot' })
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('tracks data dependencies in an @scope prelude', async () => {
    const css = '@scope ([data-scope="hot"]) { .r4-row { color:rgb(190,18,60); } }'
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    mounted.push(style)
    // If this engine drops @scope entirely there is no live dependency to test.
    if (!style.sheet?.cssRules?.length) return
    const make = () => {
      const root = document.createElement('div')
      root.className = 'r4-root'
      for (let i = 0; i < 100; i++) {
        const parent = document.createElement('div')
        parent.setAttribute('data-scope', i & 1 ? 'cold' : 'hot')
        const child = document.createElement('span')
        child.className = 'r4-row'
        child.textContent = `scoped ${i}`
        parent.appendChild(child)
        root.appendChild(parent)
      }
      document.body.appendChild(root)
      mounted.push(root)
      flushStyleInvalidations()
      return root
    }
    const fastRoot = make()
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = make()
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
  })

  it('never elides engine-owned data markers from style identity', async () => {
    const fastRoot = scene('', '', { attrName: 'data-snapdom-user', attrValue: (i) => String(i) })
    const fast = await capture(fastRoot)
    fastRoot.remove()
    const fullRoot = scene('', '', { attrName: 'data-snapdom-user', attrValue: (i) => String(i) })
    const full = await capture(fullRoot, { __styleIdentityDataAttrs: false })
    expect(fast.raw).toBe(full.raw)
    // Marker values remain unique, so this intentionally cannot collapse to the R4 sharing floor.
    expect(fast.reads).toBeGreaterThan(full.reads * 0.8)
  })
})
