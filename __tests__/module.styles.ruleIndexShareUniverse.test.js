import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
let originalDocumentLang = null

beforeEach(() => {
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

function installCSS() {
  const style = document.createElement('style')
  let css = `
    .r5dsu-root { width:820px; font:13px/1.35 Arial,sans-serif; }
    .r5dsu-row { display:block; padding:2px 4px; color:rgb(51,65,85); }
  `
  for (let i = 0; i < 400; i++) css += `.r5dsu-unused-${i}{outline-offset:${i % 3}px}`
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  flushStyleInvalidations()
}

function scene() {
  const root = document.createElement('div')
  root.className = 'r5dsu-root'
  for (let i = 0; i < 96; i++) {
    const row = document.createElement('span')
    // Deliberately style-unobserved entropy: SU must compose R2 with R3 rather than rely on hits.
    row.className = `r5dsu-row entropy-${i}`
    row.textContent = `row ${i}`
    root.appendChild(row)
  }
  document.body.appendChild(root)
  mounted.push(root)
  flushStyleInvalidations()
  return root
}

async function raw(options) {
  const root = scene()
  try {
    return await snapdom.toRaw(root, {
      burst: false,
      cache: 'disabled',
      embedFonts: false,
      __styleShare: true,
      ...options,
    })
  } finally {
    root.remove()
  }
}

describe('R5-D × R5-SU interaction', () => {
  it('keeps all four factorial cells byte-identical when both optimized interpreters are exercised', async () => {
    installCSS()
    const base = await raw({ __elementRuleIndex: false, __styleShareElementUniverse: false })
    const dOnly = await raw({ __elementRuleIndex: true, __styleShareElementUniverse: false })
    const suOnly = await raw({ __elementRuleIndex: false, __styleShareElementUniverse: true })
    const both = await raw({ __elementRuleIndex: true, __styleShareElementUniverse: true })

    expect(dOnly).toBe(base)
    expect(suOnly).toBe(base)
    expect(both).toBe(base)
  })
})
