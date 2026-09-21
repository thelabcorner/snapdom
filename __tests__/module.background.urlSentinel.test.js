import { describe, it, expect, afterEach } from 'vitest'
import { inlineBackgroundImages } from '../src/modules/background.js'

const mounted = []
const DATA = 'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")'

afterEach(() => {
  while (mounted.length) mounted.pop().remove()
})

function pair(css = '') {
  const source = document.createElement('div')
  source.style.cssText = `width:40px;height:40px;${css}`
  const clone = document.createElement('div')
  document.body.append(source, clone)
  mounted.push(source, clone)
  return { source, clone }
}

async function run(css, sentinel, sourceBasis = true) {
  const { source, clone } = pair(css)
  const cache = new WeakMap([[source, getComputedStyle(source)]])
  await inlineBackgroundImages(source, clone, cache, {
    __backgroundUrlSentinel: sentinel,
    __backgroundSourceBasis: sourceBasis,
  })
  return clone.style.cssText
}

describe('background late URL source sentinel', () => {
  it('skips inert shorthand/alias reads on a solid background without changing output', async () => {
    const count = async (sentinel) => {
      const { source, clone } = pair('background:rgb(200, 10, 20)')
      const cache = new WeakMap([[source, getComputedStyle(source)]])
      const owner = CSSStyleDeclaration.prototype
      const desc = Object.getOwnPropertyDescriptor(owner, 'getPropertyValue')
      const original = owner.getPropertyValue
      let reads = 0
      Object.defineProperty(owner, 'getPropertyValue', {
        ...desc,
        value(prop) {
          if (prop === 'background-image' || prop === 'mask' || prop === '-webkit-mask' ||
              prop === 'border-image' || prop === 'mask-image' || prop === '-webkit-mask-image' ||
              prop === 'border-image-source') reads++
          return original.apply(this, arguments)
        },
      })
      try {
        await inlineBackgroundImages(source, clone, cache, { __backgroundUrlSentinel: sentinel })
        return { css: clone.style.cssText, reads }
      } finally {
        Object.defineProperty(owner, 'getPropertyValue', desc)
      }
    }

    const historical = await count(false)
    const candidate = await count(true)
    expect(candidate.css).toBe(historical.css)
    expect(candidate.reads).toBeLessThan(historical.reads)
  })

  it('canonical source sentinels cover supported mask/border shorthands', async () => {
    const cases = [
      ['background-image', DATA],
      ['mask', `${DATA} center / cover no-repeat`],
      ['-webkit-mask', `${DATA} center / cover no-repeat`],
      ['mask-border', `${DATA} 30`],
      ['-webkit-mask-box-image', `${DATA} 30`],
      ['border-image', `${DATA} 30`],
    ]
    for (const [prop, value] of cases) {
      const probe = document.createElement('div')
      probe.style.setProperty(prop, value)
      if (!probe.style.getPropertyValue(prop)) continue // unsupported in this engine
      const css = `${prop}:${value}`
      expect(await run(css, true), prop).toBe(await run(css, false))
      expect(await run(css, true, true), `${prop} reduced basis`).toBe(await run(css, true, false))
    }
  })

  it('sees a resource introduced after the computed declaration was retained', async () => {
    const { source, clone } = pair('background:rgb(10, 20, 30)')
    const retained = getComputedStyle(source)
    const cache = new WeakMap([[source, retained]])
    // Models the afterClone / later-page-mutation seam: the style object was retained earlier,
    // but CSSStyleDeclaration is live and the late sentinel must observe the new source.
    source.style.setProperty('mask-image', DATA)
    await inlineBackgroundImages(source, clone, cache, { __backgroundUrlSentinel: true })
    expect(clone.style.getPropertyValue('mask-image') || clone.style.getPropertyValue('-webkit-mask-image'))
      .toContain('data:image/png')
  })
})
