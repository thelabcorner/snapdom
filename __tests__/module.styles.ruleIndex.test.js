import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  flushStyleInvalidations()
})

function installCSS(extra = '') {
  const style = document.createElement('style')
  style.textContent = `
    .idx-root { width:700px; font:13px/1.3 Arial,sans-serif; }
    .idx-row { display:block; padding:2px 3px; color:rgb(30,41,59); }
    .idx-row.idx-hot { color:rgb(190,18,60); }
    #idx-target { font-weight:700; }
    span[data-kind="hot"] { letter-spacing:0.2px; }
    .idx-parent > .idx-row:nth-child(2n) { background-color:rgb(241,245,249); }
    .utility\\:hover { outline-offset:1px; }
    :is(.idx-never-a,.idx-never-b) { word-spacing:1px; }
    ${extra}
  `
  document.head.appendChild(style)
  mounted.push(style)
  flushStyleInvalidations()
  return style
}

function scene() {
  const root = document.createElement('div')
  root.className = 'idx-root idx-parent'
  for (let i = 0; i < 120; i++) {
    const row = document.createElement('span')
    row.className = `idx-row ${i % 3 === 0 ? 'idx-hot' : ''}`
    row.dataset.kind = i % 5 === 0 ? 'hot' : 'cold'
    if (i === 17) row.id = 'idx-target'
    row.textContent = `row ${i}`
    root.appendChild(row)
  }
  document.body.appendChild(root)
  mounted.push(root)
  flushStyleInvalidations()
  return root
}

async function raw(root, options = {}) {
  return snapdom.toRaw(root, {
    burst: false,
    cache: 'disabled',
    embedFonts: false,
    __styleShare: false,
    ...options,
  })
}

describe('R5-D compiled element-rule subject index', () => {
  it('is byte-identical to the historical linear rule filter', async () => {
    installCSS()
    const indexedRoot = scene()
    // Force the compiled interpreter so this test proves the index itself, independent of
    // the adaptive router's current thresholds.
    const indexed = await raw(indexedRoot, { __elementRuleIndex: true })
    indexedRoot.remove()

    const linearRoot = scene()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })

  it('keeps an irrelevant utility-scale keyed rule corpus semantically inert', async () => {
    let css = ''
    for (let i = 0; i < 2500; i++) css += `.idx-unused-${i}{outline-offset:${i % 3}px}`
    installCSS(css)
    const indexedRoot = scene()
    const indexed = await raw(indexedRoot)
    indexedRoot.remove()

    const linearRoot = scene()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })

  it('rebuilds safely after CSSOM mutation invalidates a compiled index', async () => {
    let css = ''
    for (let i = 0; i < 2500; i++) css += `.idx-unused-${i}{outline-offset:${i % 3}px}`
    const style = installCSS(css)

    // Warm enough nodes to make the adaptive router compile the current style epoch.
    const warmRoot = scene()
    await raw(warmRoot)
    warmRoot.remove()

    style.sheet.insertRule('.idx-hot { text-transform:uppercase; }', style.sheet.cssRules.length)
    flushStyleInvalidations()

    const indexedRoot = scene()
    const indexed = await raw(indexedRoot)
    indexedRoot.remove()
    const linearRoot = scene()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })
})
