import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
let originalDocumentLang = null

beforeEach(() => {
  // Vitest's browser host carries <html lang="...">. R3 intentionally treats an inherited
  // language context as a conservative escape, so remove that ambient harness state for the
  // narrowing fixtures and restore it after each test. Tests that need language semantics
  // should add the attribute explicitly to their own fixture.
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

function mountScene(extraCSS = '', { rtl = false } = {}) {
  const scope = '.eu-root'
  const style = document.createElement('style')
  style.textContent = `
    ${scope} { width: 900px; font: 13px/1.35 Arial, sans-serif; color: #222; }
    ${scope} .grid { display:grid; grid-template-columns:repeat(8,1fr); gap:5px; }
    ${scope} .card { padding:5px 6px; border:1px solid #d8dee9; background:#f8fafc; }
    ${scope} .label { color:inherit; }
    ${scope} .value { color:rgb(37,99,235); font-weight:700; padding-left:var(--x, 0px); }
    ${scope} .card:nth-child(3n) { background-color:#eef4ff; color:rgb(190,18,60); --x:7px; }
    ${extraCSS}
  `
  document.head.appendChild(style)
  mounted.push(style)

  const root = document.createElement('div')
  root.className = 'eu-root'
  if (rtl) root.dir = 'rtl'
  let html = '<div class="grid">'
  for (let i = 0; i < 400; i++) {
    html += `<div class="card"><span class="label">metric ${i}: </span><span class="value" data-metric="${i}">${1000 + i}</span></div>`
  }
  root.innerHTML = html + '</div>'
  document.body.appendChild(root)
  mounted.push(root)
  flushStyleInvalidations()
  return root
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
      __styleShare: false,
      ...options,
    })
    return { raw, reads }
  } finally {
    proto.getPropertyValue = original
  }
}

describe('per-element property universe', () => {
  it('narrows structurally unsafe captures while preserving the full-universe bytes', async () => {
    const narrowRoot = mountScene()
    const narrow = await captureReads(narrowRoot)
    narrowRoot.remove()

    // Same DOM/CSS, with only R3's internal narrowing disabled. This makes the parity oracle
    // engine-independent instead of relying on a DOM/CSS mutation to trigger a fallback.
    const fullRoot = mountScene()
    const full = await captureReads(fullRoot, { __elementUniverse: false })

    expect(narrow.raw).toBe(full.raw)
    expect(narrow.reads).toBeLessThan(full.reads * 0.75)
  })

  it('keeps inherited values and custom-property effects from structural ancestors exact', async () => {
    const narrowRoot = mountScene(`
      .eu-root .card:nth-child(5n) { text-transform:uppercase; letter-spacing:0.2px; }
      .eu-root .card:nth-child(7n + 1) .label { font-style:italic; }
    `)
    const narrow = await captureReads(narrowRoot)
    narrowRoot.remove()

    const fullRoot = mountScene(`
      .eu-root .card:nth-child(5n) { text-transform:uppercase; letter-spacing:0.2px; }
      .eu-root .card:nth-child(7n + 1) .label { font-style:italic; }
    `)
    const full = await captureReads(fullRoot, { __elementUniverse: false })

    expect(narrow.raw).toBe(full.raw)
    expect(narrow.reads).toBeLessThan(full.reads * 0.8)
  })

  it('retains properties consumed by downstream snapshot users without widening every element', async () => {
    const style = document.createElement('style')
    style.textContent = `
      .eu-deps { width:120px; height:80px; background-color:rgb(10, 20, 30); }
      .eu-deps { border:4px solid transparent; border-image-source:linear-gradient(red, blue); }
      /* These rules deliberately match nothing. They put the properties in the document
         universe so the full path snapshots their defaults on .eu-deps; background.js then
         consumes those cached values. R3 must preserve that downstream dependency edge. */
      .eu-never { mask-position:17px 19px; background-blend-mode:multiply; border-image-repeat:round; }
    `
    document.head.appendChild(style)
    mounted.push(style)

    const make = () => {
      const root = document.createElement('div')
      root.className = 'eu-deps'
      root.textContent = 'dependency contract'
      document.body.appendChild(root)
      mounted.push(root)
      flushStyleInvalidations()
      return root
    }

    const narrowRoot = make()
    const narrow = await captureReads(narrowRoot)
    narrowRoot.remove()
    const fullRoot = make()
    const full = await captureReads(fullRoot, { __elementUniverse: false })

    // This is a dependency-contract oracle, not a microbenchmark. On one element the
    // once-per-style-epoch selector/UA setup is intentionally more expensive than a full read;
    // the 400-card fixtures above are where narrowing is expected to amortize.
    expect(narrow.raw).toBe(full.raw)
  })

  it('falls back for non-LTR context instead of applying the logical-property shortcut', async () => {
    const fallbackRoot = mountScene('', { rtl: true })
    const fallback = await captureReads(fallbackRoot)
    fallbackRoot.remove()

    const fullRoot = mountScene('', { rtl: true })
    const full = await captureReads(fullRoot, { __elementUniverse: false })

    expect(fallback.raw).toBe(full.raw)
    // Both arms are deliberately on the same conservative path. Small once-per-scan
    // differences are allowed, but a real narrowing collapse here would be a regression.
    expect(fallback.reads).toBeGreaterThan(full.reads * 0.9)
  })
})
