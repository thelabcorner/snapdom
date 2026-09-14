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

  it('plans additional direct class/id keys without treating functional-pseudo classes as required', async () => {
    let css = ''
    for (let i = 0; i < 240; i++) {
      css += `.idx-row.state-${i}{outline-offset:${i % 3}px}`
    }
    css += '.idx-row#idx-target{text-transform:uppercase}'
    css += '.idx-row.state\\+hot{word-spacing:0.4px}'
    // These nested classes are alternatives, not necessary subject conditions. A planner that
    // extracts them as direct keys will silently drop matching rules when the other branch wins.
    css += '.idx-row:is(.idx-hot,.never-nested){text-decoration-line:none}'
    css += '.idx-row:not(.never-nested){text-rendering:auto}'
    installCSS(css)

    const make = () => {
      const root = scene()
      const rows = root.querySelectorAll('.idx-row')
      rows.forEach((row, i) => row.classList.add(`state-${i % 240}`))
      rows[0].classList.add('state+hot')
      return root
    }

    const plannedRoot = make()
    const planned = await raw(plannedRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: true,
    })
    plannedRoot.remove()
    const d4Root = make()
    const d4 = await raw(d4Root, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: false,
    })
    d4Root.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })

    expect(planned).toBe(d4)
    expect(planned).toBe(linear)
  })

  it('keeps a selective first class when a second direct class is common', async () => {
    let css = ''
    for (let i = 0; i < 240; i++) css += `.state-${i}.idx-row{outline-offset:${i % 3}px}`
    installCSS(css)
    const make = () => {
      const root = scene()
      root.querySelectorAll('.idx-row').forEach((row, i) => row.classList.add(`state-${i % 240}`))
      return root
    }

    const plannedRoot = make()
    const planned = await raw(plannedRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: true,
    })
    plannedRoot.remove()
    const d4Root = make()
    const d4 = await raw(d4Root, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: false,
    })
    d4Root.remove()
    expect(planned).toBe(d4)
  })

  it('survives a Juan-style adversarial compound-selector corpus against the linear oracle', async () => {
    installCSS(`
      .idx-row.direct-a.direct-b { outline-offset:1px; }
      .idx-row.direct-a:is(.branch-never,.branch-live).direct-c { word-spacing:0.31px; }
      .idx-row.direct-a:not(.blocked-never).direct-d { letter-spacing:0.32px; }
      .idx-row.direct-a:where(.branch-never,.branch-live).direct-e { text-indent:0.33px; }
      .idx-row.direct-a:nth-child(2n of .idx-row).direct-f { border-top-width:1px; }
      .idx-row.direct-a[data-plan="yes"].direct-g { border-right-width:1px; }
      .idx-row.direct-a#idx-target.direct-h { border-bottom-width:1px; }
      .idx-row.direct-a/* > + ~ , .fake #fake [data-fake=x] */.direct-i { border-left-width:1px; }
      .idx-row.direct-a.direct\\+plus { padding-left:7px; }
      .idx-row.direct-a.direct\\,comma { padding-right:8px; }
      .idx-row.direct-a.direct\\[bracket { padding-top:9px; }
      .idx-row.direct-a.direct\\:colon { padding-bottom:10px; }
      .idx-row.direct-a.hex\\2b class { margin-left:11px; }
      :where(.idx-parent) > .idx-row.direct-a.direct-j { margin-right:12px; }
      [data-parent="yes"] .idx-row.direct-a.direct-k { margin-top:13px; }
      span.idx-row.direct-a.direct-l { margin-bottom:14px; }
      .idx-row.direct-a:has(+ .idx-row).direct-m { outline-width:1px; }
      .idx-row.direct-a:is(.branch-live,[data-other="x"]).direct-n { text-transform:none; }
      .idx-row.direct-a:not(:is(.blocked-never,.also-never)).direct-o { text-rendering:auto; }
    `)

    const make = () => {
      const root = scene()
      root.dataset.parent = 'yes'
      const rows = root.querySelectorAll('.idx-row')
      for (const row of rows) row.classList.add('direct-a')
      const names = ['direct-b','direct-c','direct-d','direct-e','direct-f','direct-g','direct-h','direct-i',
        'direct+plus','direct,comma','direct[bracket','direct:colon','hex+class','direct-j','direct-k','direct-l',
        'direct-m','direct-n','direct-o']
      names.forEach((name, i) => rows[i].classList.add(name))
      rows[1].classList.add('branch-live')
      rows[3].classList.add('branch-live')
      rows[5].dataset.plan = 'yes'
      rows[17].classList.add('branch-live')
      return root
    }

    const plannedRoot = make()
    const planned = await raw(plannedRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: true,
    })
    plannedRoot.remove()
    const d4Root = make()
    const d4 = await raw(d4Root, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: false,
    })
    d4Root.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })

    expect(planned).toBe(d4)
    expect(planned).toBe(linear)
  })

  it('does not reinterpret escaped dot/hash punctuation as new class or ID selectors', async () => {
    installCSS(`
      #idx\\.dot { text-transform:uppercase; }
      .idx-row.class\\#hash { word-spacing:0.41px; }
      .idx-row.class\\.dot { letter-spacing:0.42px; }
      #idx\\#hash { text-indent:0.43px; }
    `)
    const make = () => {
      const root = scene()
      const rows = root.querySelectorAll('.idx-row')
      rows[0].id = 'idx.dot'
      rows[1].classList.add('class#hash')
      rows[2].classList.add('class.dot')
      rows[3].id = 'idx#hash'
      return root
    }

    const plannedRoot = make()
    const planned = await raw(plannedRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: true,
    })
    plannedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(planned).toBe(linear)
  })

  it('does not let logarithmic planner sampling hide a minority necessary key', async () => {
    let css = ''
    // Old scout positions 0,1,2,4,8,last all expose no alternative. Position 3 is the only
    // selective direct class. If the planner re-keys some later-discovered rules while missing
    // this one, the retained common bucket is no longer a complete candidate set.
    const second = [null, null, null, 'needle', null, null, 'other-a', 'other-b', null]
    for (let i = 0; i < second.length; i++) {
      css += second[i]
        ? `.idx-row.${second[i]}{outline-offset:${i + 1}px}`
        : `.idx-row{outline-offset:${i + 1}px}`
    }
    installCSS(css)
    const make = () => {
      const root = scene()
      root.querySelector('.idx-row').classList.add('needle')
      return root
    }

    const plannedRoot = make()
    const planned = await raw(plannedRoot, {
      __elementRuleIndex: true,
      __elementRuleKeySelectivity: true,
      __elementRuleCompoundKeyPlanner: true,
    })
    plannedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(planned).toBe(linear)
  })

  it('keeps non-ASCII class identifiers exact instead of truncating a necessary key', async () => {
    installCSS(`
      .café { letter-spacing:3px; }
      .日本語 { word-spacing:4px; }
      .emoji-😀 { text-indent:5px; }
    `)
    const make = () => {
      const root = scene()
      const rows = root.querySelectorAll('.idx-row')
      rows[0].classList.add('café')
      rows[1].classList.add('日本語')
      rows[2].classList.add('emoji-😀')
      return root
    }

    const indexedRoot = make()
    const indexed = await raw(indexedRoot, { __elementRuleIndex: true })
    indexedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })

  it('fails closed for namespace and mixed-case type selectors', async () => {
    installCSS(`
      @namespace svg url(http://www.w3.org/2000/svg);
      svg|path { stroke-width:7px; }
      linearGradient { color:rgb(17, 34, 51); }
    `)
    const make = () => {
      const root = scene()
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
      const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M0 0L10 10')
      defs.appendChild(gradient)
      svg.append(defs, path)
      root.appendChild(svg)
      return root
    }

    const indexedRoot = make()
    const indexed = await raw(indexedRoot, { __elementRuleIndex: true })
    indexedRoot.remove()
    const linearRoot = make()
    const linear = await raw(linearRoot, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })

  it('uses the linear browser oracle in quirks mode rather than assuming case-sensitive keys', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    mounted.push(iframe)
    const doc = iframe.contentDocument
    // about:blank initially inherits the outer document's mode. Reparse the child document
    // explicitly without a doctype so the browser really enters quirks mode.
    doc.open()
    doc.write('<html><head><style>.QuIrK{letter-spacing:6px}</style></head><body><div id="root"><span class="quirk">x</span></div></body></html>')
    doc.close()
    expect(doc.compatMode).toBe('BackCompat')
    const root = doc.getElementById('root')
    const subject = root.firstElementChild

    // Chromium currently exposes the legacy quirks fold through selector matching. The assertion
    // documents why a classList/id-key shortcut is not a valid replacement in this mode.
    expect(subject.matches('.QuIrK')).toBe(true)
    expect(subject.classList.contains('QuIrK')).toBe(false)

    const indexed = await raw(root, { __elementRuleIndex: true })
    const linear = await raw(root, { __elementRuleIndex: false })
    expect(indexed).toBe(linear)
  })
})
