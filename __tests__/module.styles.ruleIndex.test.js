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

  it('indexes direct subject attributes without treating functional-pseudo attributes as required', async () => {
    let css = ''
    for (let i = 0; i < 600; i++) css += `[data-idx-unused-${i}]{outline-offset:${i % 3}px}`
    // These selectors are semantic traps for an over-aggressive attribute extractor: the
    // subject does NOT need data-blocked/data-choice/data-child to match them.
    css += '.idx-row:not([data-blocked]){text-transform:none}'
    css += '.idx-row:is([data-choice],.idx-hot){text-decoration-line:none}'
    css += '.idx-parent:has([data-kind="hot"]){outline-width:0px}'
    // Pseudo-only forms have no direct subject attribute. If D2 accidentally indexes the
    // attribute nested inside the functional pseudo, these rules disappear from elements that
    // should match and the raw-byte oracle below fails.
    css += ':not([data-blocked]){text-rendering:auto}'
    css += ':is([data-kind="hot"],[data-kind="cold"]){text-decoration-style:solid}'
    css += ':where([data-kind]){text-emphasis-position:over right}'
    css += ':has(> [data-kind="hot"]){outline-style:none}'
    // Direct attributes remain safe when they coexist with functional pseudos, multiple
    // attributes, combinators, and bracket-looking quoted values.
    css += ':where(.idx-row)[data-kind]{font-kerning:auto}'
    css += '.idx-parent > [data-kind][data-optional="x"]{text-transform:none}'
    css += '[data-kind="hot"][data-note="[literal]"]{word-break:normal}'
    // Escaped lowercase names are safe to decode into an attribute key; uppercase HTML
    // attribute selectors deliberately stay unkeyed to avoid cross-namespace case assumptions.
    css += '[\\64 ata-kind="hot"]{word-spacing:0.1px}'
    css += '[DATA-KIND="hot"]{text-indent:0px}'
    installCSS(css)

    const indexedRoot = scene()
    const indexed = await raw(indexedRoot, { __elementRuleIndex: true })
    indexedRoot.remove()
    const linearRoot = scene()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })

  it('indexes exact data-* equality by decoded value without changing selector semantics', async () => {
    let css = ''
    // Large same-name value family: the D2 name bucket must visit every rule, while D3 should
    // visit only the exact value carried by each subject.
    for (let i = 0; i < 600; i++) css += `[data-state="v${i}"]{outline-offset:${i % 3}px}`
    css += '[data-kind="hot"]{letter-spacing:0.2px}'
    css += '[data-kind=hot]{word-spacing:0.3px}'
    css += '[data-kind^="h"]{text-indent:0px}'
    css += '[data-case="ABC" i]{text-transform:none}'
    css += '[data-case="ABC"]{text-decoration-line:none}'
    css += '[data-empty=""]{font-kerning:auto}'
    css += '[data-note="a b"]{text-rendering:auto}'
    // CSS hex escape plus terminator whitespace decodes to the live DOM value "hot".
    css += '[data-escaped="h\\6f t"]{text-decoration-style:solid}'
    installCSS(css)

    const make = () => {
      const root = scene()
      const rows = root.querySelectorAll('.idx-row')
      rows.forEach((row, i) => {
        row.dataset.state = `v${i % 600}`
        row.dataset.case = i & 1 ? 'abc' : 'ABC'
        row.dataset.empty = ''
        row.dataset.note = 'a b'
        row.dataset.escaped = 'hot'
      })
      return root
    }

    const valueRoot = make()
    const valueIndexed = await raw(valueRoot, { __elementRuleIndex: true })
    valueRoot.remove()
    const nameRoot = make()
    const nameIndexed = await raw(nameRoot, {
      __elementRuleIndex: true,
      __elementRuleAttrValueIndex: false,
    })
    nameRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, {
      __elementRuleIndex: false,
      __elementRuleAttrValueIndex: false,
    })

    expect(valueIndexed).toBe(nameIndexed)
    expect(valueIndexed).toBe(linear)
  })

  it('chooses a selective exact-value key over a common class without changing bytes', async () => {
    let css = ''
    for (let i = 0; i < 600; i++) {
      css += `.idx-row[data-state="v${i}"]{outline-offset:${i % 3}px}`
    }
    installCSS(css)
    const make = () => {
      const root = scene()
      root.querySelectorAll('.idx-row').forEach((row, i) => { row.dataset.state = `v${i % 600}` })
      return root
    }

    const selectiveRoot = make()
    const selective = await raw(selectiveRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
    })
    selectiveRoot.remove()
    const fixedRoot = make()
    const fixed = await raw(fixedRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: false,
    })
    fixedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })

    expect(selective).toBe(fixed)
    expect(selective).toBe(linear)
  })

  it('keeps a selective class key when an exact data value is common', async () => {
    let css = ''
    for (let i = 0; i < 240; i++) {
      css += `.selective-${i}[data-state="common"]{outline-offset:${i % 3}px}`
    }
    installCSS(css)
    const make = () => {
      const root = scene()
      root.querySelectorAll('.idx-row').forEach((row, i) => {
        row.classList.add(`selective-${i}`)
        row.dataset.state = 'common'
      })
      return root
    }

    const selectiveRoot = make()
    const selective = await raw(selectiveRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
    })
    selectiveRoot.remove()
    const fixedRoot = make()
    const fixed = await raw(fixedRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: false,
    })
    fixedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })

    expect(selective).toBe(fixed)
    expect(selective).toBe(linear)
  })

  it('does not mistake escaped combinators or hex-escape terminators for subject boundaries', async () => {
    installCSS(`
      .idx\\+escaped { text-transform:uppercase; }
      .idx\\>escaped { text-decoration-line:underline; }
      .idx\\~escaped { word-spacing:0.7px; }
      .hex\\2b escaped { letter-spacing:0.4px; }
    `)
    const make = () => {
      const root = scene()
      const rows = root.querySelectorAll('.idx-row')
      rows[0].classList.add('idx+escaped')
      rows[1].classList.add('idx>escaped')
      rows[2].classList.add('idx~escaped')
      rows[3].classList.add('hex+escaped')
      return root
    }

    const indexedRoot = make()
    const indexed = await raw(indexedRoot, { __elementRuleIndex: true })
    indexedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })

  it('does not mistake escaped bracket/paren code points for selector syntax', async () => {
    installCSS(`
      .idx\\[escaped { text-transform:uppercase; }
      .idx\\]escaped { text-decoration-line:underline; }
      .idx\\(escaped { word-spacing:0.7px; }
      .idx\\)escaped { letter-spacing:0.4px; }
    `)
    const make = () => {
      const root = scene()
      const rows = root.querySelectorAll('.idx-row')
      rows[0].classList.add('idx[escaped')
      rows[1].classList.add('idx]escaped')
      rows[2].classList.add('idx(escaped')
      rows[3].classList.add('idx)escaped')
      return root
    }

    const indexedRoot = make()
    const indexed = await raw(indexedRoot, { __elementRuleIndex: true })
    indexedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })

  it('does not split escaped commas or treat punctuation inside comments as selector structure', async () => {
    installCSS(`
      .idx\\,comma { text-transform:uppercase; }
      .idx-comment/* > + ~ , [data-fake=x] */[data-kind="hot"] { word-spacing:0.8px; }
      .idx-comment/* :is(.fake,.also-fake) */[data-kind="cold"] { letter-spacing:0.6px; }
    `)
    const make = () => {
      const root = scene()
      const rows = root.querySelectorAll('.idx-row')
      rows[0].classList.add('idx,comma')
      rows[1].classList.add('idx-comment')
      rows[2].classList.add('idx-comment')
      rows[1].dataset.kind = 'hot'
      rows[2].dataset.kind = 'cold'
      return root
    }

    const indexedRoot = make()
    const indexed = await raw(indexedRoot, { __elementRuleIndex: true })
    indexedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })
})
