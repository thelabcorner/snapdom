// Juan's PR #492 review exposed the exact class of failure a performance pass must keep
// adversarially pinned: unreadable CSSOM must fail closed, UA defaults must survive a pruned
// property universe, and structural identity must never be mistaken for computed-style/geometry
// identity. These are v3 public-pipeline reproductions rather than copies of the old v2 internals.
import { afterEach, describe, expect, it } from 'vitest'
import { commands } from '@vitest/browser/context'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []

afterEach(async () => {
  while (mounted.length) mounted.pop().remove()
  // Stylesheet add/remove invalidation is MutationObserver-driven. Give the browser one task
  // boundary before the next case so an unreadable cross-origin sheet from this test cannot
  // poison the next test's scan epoch.
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushStyleInvalidations()
})

function mount(node) {
  document.body.appendChild(node)
  mounted.push(node)
  return node
}

function style(css) {
  const node = document.createElement('style')
  node.textContent = css
  document.head.appendChild(node)
  mounted.push(node)
  flushStyleInvalidations()
  return node
}

async function crossOriginSheet(css) {
  const href = await commands.serveCrossOriginCss(css)
  const link = mount(document.createElement('link'))
  link.rel = 'stylesheet'
  await new Promise((resolve, reject) => {
    link.onload = resolve
    link.onerror = reject
    link.href = href
  })
  expect(() => link.sheet.cssRules).toThrow()
  flushStyleInvalidations()
  return link
}

const raw = (el, extra = {}) => snapdom.toRaw(el, {
  burst: false,
  cache: 'disabled',
  embedFonts: false,
  ...extra,
})

const decoded = async (el, extra = {}) => decodeURIComponent((await raw(el, extra)).split(',')[1])

function expectPreWhitespaceSemantics(svg) {
  // Engines may serialize `white-space:pre` directly or as its computed longhands.
  if (/white-space:\s*pre(?:;|})/.test(svg)) return
  expect(svg).toMatch(/white-space-collapse:\s*preserve/)
  expect(svg).toMatch(/text-wrap-mode:\s*nowrap/)
}

describe('v3 adversarial regressions from PR #492 review', () => {
  it('fails closed to full style reads when a cross-origin stylesheet is CSSOM-inaccessible', async () => {
    await crossOriginSheet(`
      .juan-xorigin {
        letter-spacing: 7px;
        text-transform: uppercase;
        font-style: italic;
        text-indent: 11px;
      }
    `)
    const el = mount(document.createElement('p'))
    el.className = 'juan-xorigin'
    el.textContent = 'cross origin styles'

    const live = getComputedStyle(el)
    expect(live.letterSpacing).toBe('7px')
    expect(live.textTransform).toBe('uppercase')
    expect(live.fontStyle).toBe('italic')
    expect(live.textIndent).toBe('11px')

    const svg = await decoded(el, { invalidate: true })
    expect(svg).toMatch(/letter-spacing:\s*7px/)
    expect(svg).toMatch(/text-transform:\s*uppercase/)
    expect(svg).toMatch(/font-style:\s*italic/)
    expect(svg).toMatch(/text-indent:\s*11px/)
  })

  it('keeps UA defaults when pruning is enabled and after an unreadable sheet forces full reads', async () => {
    const root = mount(document.createElement('div'))
    root.innerHTML = '<pre>a  b\n c</pre><em>emphasis</em>' +
      '<table><tbody><tr><th>heading</th></tr></tbody></table>' +
      '<ol><li>numbered</li></ol>'

    const pre = root.querySelector('pre')
    const em = root.querySelector('em')
    const th = root.querySelector('th')
    const ol = root.querySelector('ol')
    expect(getComputedStyle(pre).whiteSpace).toBe('pre')
    expect(getComputedStyle(em).fontStyle).toBe('italic')
    expect(parseInt(getComputedStyle(th).fontWeight, 10)).toBeGreaterThanOrEqual(700)
    expect(getComputedStyle(ol).listStyleType).toBe('decimal')

    const narrowed = decodeURIComponent((await raw(root)).split(',')[1])
    expectPreWhitespaceSemantics(narrowed)
    expect(narrowed).toMatch(/font-style:\s*italic/)
    expect(narrowed).toMatch(/list-style-type:\s*decimal/)
    expect(narrowed).toMatch(/text-align:\s*center/)
    expect(narrowed).toMatch(/font-weight:\s*(?:700|bold)/)

    // An irrelevant cross-origin sheet changes only scan reliability. The second capture must
    // therefore take the conservative full computed-style path while preserving the same UA
    // semantics. Its payload may contain additional inert/default properties by construction.
    await crossOriginSheet('.juan-never-matches-ua-probe { ruby-position: over }')
    const full = decodeURIComponent((await raw(root, { invalidate: true })).split(',')[1])
    expectPreWhitespaceSemantics(full)
    expect(full).toMatch(/font-style:\s*italic/)
    expect(full).toMatch(/list-style-type:\s*decimal/)
    expect(full).toMatch(/text-align:\s*center/)
    expect(full).toMatch(/font-weight:\s*(?:700|bold)/)
  })

  it('does not share a structural snapshot across siblings distinguished by :nth-child', async () => {
    style('.juan-pos>li:nth-child(even){color:rgb(255,0,0);letter-spacing:5px}')
    const root = mount(document.createElement('ul'))
    root.className = 'juan-pos'
    root.innerHTML = '<li>odd</li><li>even</li><li>odd</li><li>even</li>'
    const [odd, even] = root.children
    expect(getComputedStyle(odd).color).not.toBe(getComputedStyle(even).color)

    // Production must recognize the structural selector and decline unsafe sharing. `true` is
    // an internal counterfactual that deliberately forces the mechanism past its admission gate,
    // so it is not a valid fidelity oracle here.
    const shared = await raw(root)
    const full = await raw(root, { __styleShare: false })
    expect(shared).toBe(full)
    expect(decodeURIComponent(shared.split(',')[1])).toMatch(/letter-spacing:\s*5px/)
  })

  it('re-reads used geometry for same-class siblings whose content produces different heights', async () => {
    style('.juan-card{width:100px;background:#eee;font:16px/20px Arial}')
    const root = mount(document.createElement('div'))
    root.innerHTML = '<div class="juan-card">one</div>' +
      '<div class="juan-card">one<br>two<br>three</div>'
    const [shortCard, tallCard] = root.children
    expect(tallCard.getBoundingClientRect().height).toBeGreaterThan(shortCard.getBoundingClientRect().height)

    const shared = await raw(root)
    const full = await raw(root, { __styleShare: false })
    expect(shared).toBe(full)
  })
})
