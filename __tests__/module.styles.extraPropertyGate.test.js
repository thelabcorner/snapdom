import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'

const EXTRA = new Set([
  'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-decoration-thickness', 'text-underline-offset', 'text-decoration-skip-ink',
  '-webkit-text-stroke', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'paint-order',
])
const DECORATION = new Set([
  'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-decoration-thickness', 'text-underline-offset', 'text-decoration-skip-ink',
])
const STROKE = new Set([
  '-webkit-text-stroke', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'paint-order',
])

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  document.head.querySelectorAll('style[data-txt1]').forEach((n) => n.remove())
})

function mount(html, css = '') {
  if (css) {
    const style = document.createElement('style')
    style.dataset.txt1 = ''
    style.textContent = css
    document.head.appendChild(style)
  }
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

async function count(root, gate) {
  const owner = CSSStyleDeclaration.prototype
  const desc = Object.getOwnPropertyDescriptor(owner, 'getPropertyValue')
  const original = owner.getPropertyValue
  let reads = 0, decoration = 0, stroke = 0
  Object.defineProperty(owner, 'getPropertyValue', {
    ...desc,
    value(prop) {
      if (EXTRA.has(prop)) reads++
      if (DECORATION.has(prop)) decoration++
      if (STROKE.has(prop)) stroke++
      return original.apply(this, arguments)
    },
  })
  try {
    const raw = await snapdom.toRaw(root, {
      burst: false,
      cache: 'disabled',
      embedFonts: false,
      __styleShare: false,
      __snapshotDecorationSynthesis: gate,
    })
    return { raw, reads, decoration, stroke }
  } finally {
    Object.defineProperty(owner, 'getPropertyValue', desc)
  }
}

describe('TXT2 representation-preserving text-decoration synthesis', () => {
  it('removes inert fallback reads on ordinary unique descendants without changing bytes', async () => {
    const root = mount(Array.from({ length: 40 }, (_, i) => `<div data-r="${i}">row ${i}</div>`).join(''))
    const historical = await count(root, false)
    const gated = await count(root, true)
    expect(gated.raw).toBe(historical.raw)
    expect(gated.reads).toBeLessThan(historical.reads)
  })

  it('keeps authored text-decoration fallbacks', async () => {
    const root = mount('<span class="u">decorated</span><span class="u">again</span>', '.u{text-decoration:underline wavy rgb(10,20,30)}')
    const historical = await count(root, false)
    const gated = await count(root, true)
    expect(gated.raw).toBe(historical.raw)
  })

  it('keeps inline text-decoration fallbacks', async () => {
    const root = mount('<span style="text-decoration:underline double red">decorated</span>')
    expect((await count(root, true)).raw).toBe((await count(root, false)).raw)
  })

  it('keeps authored and inline stroke fallbacks', async () => {
    const authored = mount('<span class="s">stroke</span><span class="s">again</span>', '.s{-webkit-text-stroke:1px rgb(1,2,3);paint-order:stroke fill}')
    const a0 = await count(authored, false)
    const a1 = await count(authored, true)
    expect(a1.raw).toBe(a0.raw)

    const inline = mount('<span style="-webkit-text-stroke:1px blue;paint-order:stroke fill">inline</span>')
    const i0 = await count(inline, false)
    const i1 = await count(inline, true)
    expect(i1.raw).toBe(i0.raw)
  })

  it('fails closed for matching all resets', async () => {
    const root = mount('<a class="reset" href="#x">link</a><span class="reset">text</span>', '.reset{all:unset}')
    const historical = await count(root, false)
    const gated = await count(root, true)
    expect(gated.raw).toBe(historical.raw)
  })

  it('captures text stroke inherited from outside the capture root', async () => {
    const outer = document.createElement('div')
    outer.style.cssText = '-webkit-text-stroke:2px rgb(12,34,56);paint-order:stroke fill'
    const root = document.createElement('div')
    root.innerHTML = '<span>child</span><span>child2</span>'
    outer.appendChild(root)
    document.body.appendChild(outer)
    mounted.push(outer)
    const historical = await count(root, false)
    const gated = await count(root, true)
    expect(gated.raw).toBe(historical.raw)
    // Root stays historical; descendants may inherit from its cloned class.
    expect(gated.reads).toBeGreaterThanOrEqual(4)
    expect(gated.reads).toBeLessThan(historical.reads)
  })

  it('preserves UA decoration on links', async () => {
    const root = mount('<a href="#x">link</a><span>plain</span>')
    expect((await count(root, true)).raw).toBe((await count(root, false)).raw)
  })

  it('preserves propagated decoration from an ancestor while synthesizing neutral descendants', async () => {
    const root = mount('<div class="parent"><span>child</span><div>child2</div></div>', '.parent{text-decoration:underline red}')
    expect((await count(root, true)).raw).toBe((await count(root, false)).raw)
  })
})
