import { afterEach, describe, expect, it } from 'vitest'
import { inlinePseudoElements } from '../src/modules/pseudo.js'

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.remove?.()
})

function scene(css, html) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const source = document.createElement('div')
  source.innerHTML = html
  document.body.appendChild(source)
  mounted.push(source)
  return source.firstElementChild
}

async function materialize(source, reuse, cached = getComputedStyle(source)) {
  const clone = source.cloneNode(true)
  const session = {
    styleMap: new Map(),
    styleCache: new WeakMap([[source, cached]]),
    nodeMap: new Map([[clone, source]]),
  }
  await inlinePseudoElements(source, clone, session, {
    cache: 'disabled',
    embedFonts: false,
    __pseudoHostStyleReuse: reuse,
  })
  return clone.outerHTML
}

describe('R7-SA5 pseudo host style reuse', () => {
  it('matches the historical host read for an ordinary ::before', async () => {
    const source = scene(
      '.host{display:block;font:14px/20px Arial}.host::before{content:"prefix text";display:inline-block;width:22px}',
      '<span class="host">body</span>',
    )
    expect(await materialize(source, true)).toBe(await materialize(source, false))
  })

  it('uses the live declaration after host display changes', async () => {
    const source = scene(
      '.host{display:block}.host.flex{display:flex}.host::before{content:"";display:block;width:24px;min-width:auto}',
      '<span class="host">body</span>',
    )
    const cached = getComputedStyle(source)
    source.classList.add('flex')
    expect(await materialize(source, true, cached)).toBe(await materialize(source, false, cached))
  })

  it('fails closed when the capture-local declaration is empty/unknown', async () => {
    const source = scene(
      '.host{display:grid}.host::before{content:"x";display:block;width:20px}',
      '<span class="host">body</span>',
    )
    const unknown = { length: 0 }
    expect(await materialize(source, true, unknown)).toBe(await materialize(source, false, unknown))
  })
})
