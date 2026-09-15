import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop().remove() })

function mount(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  mounted.push(root)
  return root
}

describe('R6 retained scroll observations', () => {
  it.each(['visible', 'clip'])('%s cannot acquire a programmatic scroll offset', (overflow) => {
    const root = mount(`<div class="s" style="width:100px;height:40px;overflow:${overflow}"><div style="width:300px;height:100px"></div></div>`)
    const scroller = root.firstElementChild
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth)
    scroller.scrollLeft = 50
    scroller.scrollTop = 20
    expect(scroller.scrollLeft).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it.each(['hidden', 'auto', 'scroll'])('%s remains a retained scroll candidate', async (overflow) => {
    const root = mount(`<div class="s" style="width:100px;height:40px;overflow:${overflow}"><div style="width:300px;height:100px"></div></div>`)
    const scroller = root.firstElementChild
    const first = await snapdom(root, { embedFonts: false, __burstRetainedScrollObservations: true })

    // Same-task write: the scroll event may not have been delivered yet, so correctness must
    // come from the synchronous retained render-state watch list.
    scroller.scrollLeft = 50
    scroller.scrollTop = 20
    expect(scroller.scrollLeft).toBe(50)
    expect(scroller.scrollTop).toBe(20)
    const changed = await snapdom(root, { embedFonts: false, __burstRetainedScrollObservations: true })
    expect(changed.url).not.toBe(first.url)
  })

  it('is byte-identical to the historical census on a mixed scroll tree', async () => {
    const root = mount(`
      <div style="width:140px;height:50px;overflow:visible"><div style="width:300px;height:80px"></div></div>
      <div style="width:140px;height:50px;overflow:hidden"><div style="width:300px;height:80px"></div></div>
      <div style="width:140px;height:50px;overflow:auto"><div style="width:300px;height:80px"></div></div>
    `)
    const historical = await snapdom.toRaw(root, {
      burst: false, cache: 'disabled', embedFonts: false, __burstRetainedScrollObservations: false,
    })
    const optimized = await snapdom.toRaw(root, {
      burst: false, cache: 'disabled', embedFonts: false, __burstRetainedScrollObservations: true,
    })
    expect(optimized).toBe(historical)
  })

  it('tracks a same-task scroll inside an open shadow root', async () => {
    const host = mount('<div class="host"></div>').firstElementChild
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<div class="scroller" style="width:100px;height:40px;overflow:hidden"><div style="width:300px;height:100px"></div></div>'
    const scroller = shadow.querySelector('.scroller')

    const first = await snapdom(host, { embedFonts: false, __burstRetainedScrollObservations: true })
    scroller.scrollTop = 20
    expect(scroller.scrollTop).toBe(20)
    const changed = await snapdom(host, { embedFonts: false, __burstRetainedScrollObservations: true })
    expect(changed.url).not.toBe(first.url)
  })

  it('reclassifies a node that becomes scrollable after a diff mutation', async () => {
    const root = mount('<div class="s" style="width:100px;height:40px;overflow:visible"><div style="width:300px;height:100px"></div></div>')
    const scroller = root.firstElementChild
    const opts = { embedFonts: false, __burstRetainedScrollObservations: true }

    const first = await snapdom(root, opts)
    expect(await snapdom(root, opts)).toBe(first)

    // The optimized full-capture path deliberately omits this visible box. A later mutation
    // can make it a real scroll container; the differential commit must rebuild membership
    // using the historical census before another memo can be published.
    scroller.style.overflow = 'auto'
    const reclassified = await snapdom(root, opts)
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)

    scroller.scrollTop = 20
    expect(scroller.scrollTop).toBe(20)
    const scrolled = await snapdom(root, opts)
    expect(scrolled.url).not.toBe(reclassified.url)
    expect(await snapdom(root, opts)).toBe(scrolled)
  })

  it('does not memoize when a scroll offset changes after clone preparation without an event', async () => {
    const root = mount('<div class="s" style="width:100px;height:40px;overflow:hidden"><div style="width:300px;height:100px"></div></div>')
    const scroller = root.firstElementChild
    let syntheticTop = 0
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() { return syntheticTop },
      set(value) { syntheticTop = Number(value) || 0 },
    })

    let flipOnce = true
    const opts = {
      embedFonts: false,
      __burstRetainedScrollObservations: true,
      plugins: [{
        name: 'r6-mid-capture-scroll',
        pure: true,
        afterClone() {
          // prepareClone has already read scrollTop=0 into the retained observation, but no
          // native scroll event is dispatched by this synthetic source property. The commit
          // must therefore reject the torn frame from the retained offset comparison itself.
          if (flipOnce) { flipOnce = false; syntheticTop = 20 }
        },
      }],
    }

    const torn = await snapdom(root, opts)
    const fresh = await snapdom(root, opts)
    expect(fresh).not.toBe(torn)
    expect(fresh.url).not.toBe(torn.url)
    expect(await snapdom(root, opts)).toBe(fresh)
  })

  it('retains mixed-axis overflow that computes visible to a scrollable value', async () => {
    const root = mount('<div class="s" style="width:100px;height:40px;overflow-x:visible;overflow-y:hidden"><div style="width:300px;height:100px"></div></div>')
    const scroller = root.firstElementChild
    const cs = getComputedStyle(scroller)
    expect(['auto', 'hidden', 'scroll']).toContain(cs.overflowX)
    const opts = { embedFonts: false, __burstRetainedScrollObservations: true }

    const first = await snapdom(root, opts)
    scroller.scrollLeft = 40
    expect(scroller.scrollLeft).toBe(40)
    const changed = await snapdom(root, opts)
    expect(changed.url).not.toBe(first.url)
  })

  it('rejects a frame when the capture root itself scrolls after clone preparation', async () => {
    const root = mount('<div class="root-scroll" style="width:120px;height:50px;overflow:hidden"><div style="height:300px"></div></div>').firstElementChild
    let syntheticTop = 0
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get() { return syntheticTop },
      set(value) { syntheticTop = Number(value) || 0 },
    })
    let flipOnce = true
    const opts = {
      embedFonts: false,
      __burstRetainedScrollObservations: true,
      plugins: [{
        name: 'r6-root-mid-capture-scroll',
        pure: true,
        afterClone() { if (flipOnce) { flipOnce = false; syntheticTop = 25 } },
      }],
    }

    const torn = await snapdom(root, opts)
    const fresh = await snapdom(root, opts)
    expect(fresh).not.toBe(torn)
    expect(fresh.url).not.toBe(torn.url)
    expect(await snapdom(root, opts)).toBe(fresh)
  })
})
