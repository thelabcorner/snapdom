import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapdom } from '../src/index.js'
import { snapshotFor } from '../src/modules/styles.js'

const mounted = []
afterEach(() => {
  vi.restoreAllMocks()
  while (mounted.length) mounted.pop().remove()
})

function fixture(inline = false) {
  const style = document.createElement('style')
  style.textContent = `.auto-margin-card{width:200px;height:40px;background:rgb(255,0,0);${inline ? '' : 'margin-inline:auto'}}`
  document.head.append(style)
  mounted.push(style)
  const root = document.createElement('div')
  root.style.cssText = 'width:300px;height:80px;background:white'
  root.innerHTML = `<div class="auto-margin-card"${inline ? ' style="margin-inline:auto"' : ''}></div>`
  document.body.append(root)
  mounted.push(root)
  const card = root.querySelector('.auto-margin-card')
  // Model Chromium's partial-layout failure: used CSSOM margins are zero, although
  // the box and the browser's resolved Typed OM declaration still say centered/auto.
  const native = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = native(el, pseudo)
    if (el !== card || pseudo) return style
    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') return (prop) =>
          /^(margin-(left|right|inline-start|inline-end))$/.test(prop) ? '0px' : target.getPropertyValue(prop)
        if (['marginLeft', 'marginRight', 'marginInlineStart', 'marginInlineEnd'].includes(key)) return '0px'
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
  return { root, card }
}

async function expectCentered(result, left) {
  const canvas = await result.toCanvas({ scale: 1, dpr: 1 })
  const ctx = canvas.getContext('2d')
  const pixel = (x) => Array.from(ctx.getImageData(x, 10, 1, 1).data).slice(0, 3)
  expect(pixel(left - 5)).toEqual([255, 255, 255])
  expect(pixel(left + 5)).toEqual([255, 0, 0])
}

describe.skipIf(typeof Element.prototype.computedStyleMap !== 'function')('auto margins after partial layout', () => {
  it('keeps a centered relative box aligned after its absolute child gains shadow content', async () => {
    const style = document.createElement('style')
    style.textContent = '.native-margin-card{width:200px;height:40px;background:rgb(255,0,0);margin:auto;position:relative}.native-margin-host{position:absolute}'
    document.head.append(style)
    mounted.push(style)
    const root = document.createElement('div')
    root.style.cssText = 'width:300px;height:80px;background:white'
    root.innerHTML = '<div class="native-margin-card"><div class="native-margin-host"></div></div>'
    document.body.append(root)
    mounted.push(root)
    const card = root.firstElementChild
    const before = card.getBoundingClientRect().x
    expect(getComputedStyle(card).marginLeft).toBe('50px')

    // Native Chromium repro, without mocks, observers or component libraries. Adding
    // this shadow child can change the reported used margin to 0px without moving
    // the card. The capture must preserve its position even if Chromium later fixes it.
    card.firstElementChild.attachShadow({ mode: 'open' }).innerHTML = '<div></div>'
    expect(card.getBoundingClientRect().x).toBe(before)
    expect(card.computedStyleMap().get('margin-left').toString()).toBe('auto')
    await expectCentered(await snapdom(root, { embedFonts: false, burst: false, __autoMarginProbeGate: true }), 50)
  })

  it('keeps centering through a cold capture, a memo hit, and a width edit', async () => {
    const { root, card } = fixture()
    const first = await snapdom(root, { embedFonts: false, __autoMarginProbeGate: true })
    await expectCentered(first, 50)
    const second = await snapdom(root, { embedFonts: false, __autoMarginProbeGate: true })
    expect(second.url).toBe(first.url)
    await expectCentered(second, 50)

    card.style.width = '180px'
    const changed = await snapdom(root, { embedFonts: false, __autoMarginProbeGate: true })
    expect(changed.url).not.toBe(first.url)
    await expectCentered(changed, 60)
  })

  it('preserves an inline logical auto margin through inline-style normalization', async () => {
    const { root } = fixture(true)
    await expectCentered(await snapdom(root, { embedFonts: false, burst: false, __autoMarginProbeGate: true }), 50)
  })

  it('does not restore excluded margin properties', async () => {
    const { root, card } = fixture()
    let snapshot
    await snapdom(root, {
      embedFonts: false,
      __autoMarginProbeGate: true,
      excludeStyleProps: /^margin-/,
      plugins: [{ name: 'margin-snapshot', pure: true, afterClone() { snapshot = snapshotFor(card) } }],
    })
    expect(Object.keys(snapshot).filter(prop => prop.startsWith('margin-'))).toEqual([])
  })

  it('skips Typed-OM margin recovery when neither author, inline nor UA styles can produce auto', async () => {
    const root = document.createElement('div')
    root.style.width = '300px'
    const card = document.createElement('div')
    card.className = 'plain-margin-card'
    card.textContent = 'plain'
    root.appendChild(card)
    document.body.append(root)
    mounted.push(root)
    const map = card.computedStyleMap.bind(card)
    const spy = vi.spyOn(card, 'computedStyleMap').mockImplementation(() => map())
    await snapdom(root, { embedFonts: false, burst: false, cache: 'disabled', __autoMarginProbeGate: true })
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps legacy table align presentational auto margins on the historical probe path', async () => {
    const root = document.createElement('div')
    root.style.cssText = 'width:300px;height:120px;background:white'
    root.innerHTML = '<table align="center" style="width:100px"><tbody><tr><td>x</td></tr></tbody></table>'
    document.body.append(root)
    mounted.push(root)
    const table = root.querySelector('table')

    // Chromium/WebKit expose the presentational hint as `auto` through Typed OM while ordinary
    // computed style reports its used pixel margin. That is precisely the state the recovery
    // pass exists to preserve. Firefox currently lacks computedStyleMap in this test lane.
    const typed = table.computedStyleMap().get('margin-left').toString()
    expect(typed).toBe('auto')

    const gated = await snapdom.toRaw(root, {
      embedFonts: false, burst: false, cache: 'disabled', __autoMarginProbeGate: true,
    })
    const historical = await snapdom.toRaw(root, {
      embedFonts: false, burst: false, cache: 'disabled', __autoMarginProbeGate: false,
    })
    expect(gated).toBe(historical)
  })

  it('keeps inline all:inherit/revert on the conservative Typed-OM path', async () => {
    const root = document.createElement('div')
    root.style.width = '300px'
    const card = document.createElement('div')
    card.style.cssText = 'all:inherit;width:100px'
    card.textContent = 'inherit probe'
    root.appendChild(card)
    document.body.append(root)
    mounted.push(root)

    const map = card.computedStyleMap.bind(card)
    const spy = vi.spyOn(card, 'computedStyleMap').mockImplementation(() => map())
    await snapdom(root, {
      embedFonts: false, burst: false, cache: 'disabled', __autoMarginProbeGate: true,
    })
    expect(spy).toHaveBeenCalled()
  })
})
