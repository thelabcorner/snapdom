// Regression invariants taken directly from Juan's review of PR #492. That PR targeted v2 and
// is intentionally not reused here; these tests pin the failure modes so v3/R5 optimizations
// cannot buy speed by reopening them.
import { afterEach, describe, expect, it } from 'vitest'
import { commands } from '@vitest/browser/context'
import { snapdom } from '../src/index.js'
import { scanAuthorStyles } from '../src/modules/styleScan.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop().remove() })

function mount(el, parent = document.body) {
  parent.appendChild(el)
  mounted.push(el)
  return el
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushStyleInvalidations()
}

async function rawText(el, options = {}) {
  const raw = await snapdom.toRaw(el, { burst: false, cache: 'disabled', embedFonts: false, ...options })
  return decodeURIComponent(raw.split(',')[1])
}

describe('Juan PR #492 review invariants on v3', () => {
  it('fails closed to a full style read when any stylesheet is unreadable', async () => {
    const href = await commands.serveCrossOriginCss(`
      .juan-xo {
        letter-spacing: 3px;
        text-transform: uppercase;
        font-style: italic;
        text-indent: 17px;
      }
    `)
    const link = mount(document.createElement('link'), document.head)
    link.rel = 'stylesheet'
    await new Promise((resolve, reject) => {
      link.onload = resolve
      link.onerror = reject
      link.href = href
    })
    expect(() => link.sheet.cssRules).toThrow()

    const el = mount(document.createElement('div'))
    el.className = 'juan-xo'
    el.textContent = 'Juan cross origin fallback'
    await settle()

    const live = getComputedStyle(el)
    expect(live.letterSpacing).toBe('3px')
    expect(live.textTransform).toBe('uppercase')
    expect(live.fontStyle).toBe('italic')
    expect(live.textIndent).toBe('17px')
    expect(scanAuthorStyles(document).universe).toBeNull()

    const raw = await rawText(el)
    expect(raw).toMatch(/letter-spacing:\s*3px/)
    expect(raw).toMatch(/text-transform:\s*uppercase/)
    expect(raw).toMatch(/font-style:\s*italic/)
    expect(raw).toMatch(/text-indent:\s*17px/)
  })

  it('preserves UA defaults with no author CSS for pre/th/em/ol', async () => {
    const root = mount(document.createElement('div'))
    root.innerHTML = `
      <pre>alpha    beta</pre>
      <table><tbody><tr><th>heading</th></tr></tbody></table>
      <em>emphasis</em>
      <ol><li>ordered</li></ol>
    `
    await settle()

    // Pin both the browser premise and the capture integration. The exact default values are
    // the cases Juan found missing when the v2 UA-diff loop was accidentally dead code.
    const pre = root.querySelector('pre')
    const th = root.querySelector('th')
    const em = root.querySelector('em')
    const ol = root.querySelector('ol')
    expect(getComputedStyle(pre).whiteSpace).toBe('pre')
    expect(Number.parseInt(getComputedStyle(th).fontWeight, 10)).toBeGreaterThanOrEqual(600)
    expect(getComputedStyle(th).textAlign).toBe('center')
    expect(getComputedStyle(em).fontStyle).toBe('italic')
    expect(getComputedStyle(ol).listStyleType).toBe('decimal')

    const raw = await rawText(root)
    expect(raw).toMatch(/white-space:\s*pre/)
    expect(raw).toMatch(/font-style:\s*italic/)
    expect(raw).toMatch(/list-style-type:\s*decimal/)
    expect(raw).toMatch(/text-align:\s*center/)
  })

  it('never merges nth-child siblings into one shared style identity', async () => {
    const style = mount(document.createElement('style'), document.head)
    style.textContent = `
      .juan-li { display:block; width:20px; height:20px; background:rgb(0,0,255) }
      .juan-li:nth-child(even) { background:rgb(255,0,0) }
    `
    const root = mount(document.createElement('div'))
    root.innerHTML = '<i class="juan-li"></i><i class="juan-li"></i><i class="juan-li"></i><i class="juan-li"></i>'
    await settle()

    const optimized = await rawText(root)
    root.dataset.juanDirty = '1'; delete root.dataset.juanDirty
    await settle()
    const noShare = await rawText(root, { __styleShare: false })
    expect(optimized).toBe(noShare)
  })

  it('keeps content-dependent geometry per sibling instead of reusing the first card', async () => {
    const style = mount(document.createElement('style'), document.head)
    style.textContent = '.juan-card{display:block;width:160px;padding:4px;font:16px/20px Arial;overflow:visible}'
    const root = mount(document.createElement('div'))
    root.innerHTML = `
      <div class="juan-card">short</div>
      <div class="juan-card">one line<br>two lines<br>three lines<br>four lines</div>
    `
    await settle()

    const cards = root.querySelectorAll('.juan-card')
    expect(cards[1].getBoundingClientRect().height).toBeGreaterThan(cards[0].getBoundingClientRect().height)

    const optimized = await rawText(root)
    root.dataset.juanDirty = '1'; delete root.dataset.juanDirty
    await settle()
    const noShare = await rawText(root, { __styleShare: false })
    expect(optimized).toBe(noShare)
  })
})
