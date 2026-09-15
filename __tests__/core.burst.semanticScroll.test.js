import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.remove?.()
})

function mount(html, css = '') {
  if (css) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    mounted.push(style)
  }
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  mounted.push(host)
  return host
}

const burst = { burst: true, cache: 'disabled', embedFonts: false, __burstSemanticScrollTracking: true }
const fresh = { burst: false, cache: 'disabled', embedFonts: false }

async function expectMatchesFresh(target) {
  const automatic = await snapdom(target, burst)
  const oracle = await snapdom(target, fresh)
  expect(automatic.url).toBe(oracle.url)
  return automatic
}

describe('R7-BRST1 semantic scroll-state tracking', () => {
  it('tracks overflow:hidden because it accepts programmatic scroll offsets', async () => {
    const host = mount('<div class="pane"><div class="a"></div><div class="b"></div></div>',
      '.pane{width:160px;height:60px;overflow:hidden}.a,.b{height:60px}.a{background:red}.b{background:blue}')
    const pane = host.firstElementChild
    await snapdom(pane, burst)
    pane.scrollTop = 60
    expect(pane.scrollTop).toBe(60)
    await expectMatchesFresh(pane)
  })

  it('does not manufacture state for overflow:clip, which cannot retain a scroll offset', async () => {
    const host = mount('<div class="pane"><div></div></div>',
      '.pane{width:160px;height:60px;overflow:clip}.pane>div{width:400px;height:300px;background:red}')
    const pane = host.firstElementChild
    const memo = await snapdom(pane, burst)
    expect(await snapdom(pane, burst)).toBe(memo)
    pane.scrollTop = 40
    pane.scrollLeft = 30
    expect(pane.scrollTop).toBe(0)
    expect(pane.scrollLeft).toBe(0)
    expect(await snapdom(pane, burst)).toBe(memo)
  })

  it('refreshes admission after visible becomes auto, then catches same-task scrolling', async () => {
    const host = mount('<div class="pane"><div class="a"></div><div class="b"></div></div>',
      '.pane{width:160px;height:60px;overflow:visible}.pane.scroll{overflow:auto}.a,.b{height:60px}.a{background:red}.b{background:blue}')
    const pane = host.firstElementChild
    await snapdom(pane, burst)
    pane.classList.add('scroll')
    await snapdom(pane, burst) // commits a fresh style-derived watch set
    pane.scrollTop = 60
    expect(pane.scrollTop).toBe(60)
    await expectMatchesFresh(pane)
  })

  it('catches same-task scroll inside an open shadow root without waiting for the event task', async () => {
    const host = mount('<div class="component"></div>').firstElementChild
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<div id="pane" style="width:160px;height:60px;overflow:auto"><div style="height:60px;background:red"></div><div style="height:60px;background:blue"></div></div>'
    const pane = root.getElementById('pane')
    await snapdom(host, burst)
    pane.scrollTop = 60
    expect(pane.scrollTop).toBe(60)
    await expectMatchesFresh(host)
  })

  it('keeps the captured root ancestor chain in the synchronous scroll signature', async () => {
    const host = mount('<div class="outer"><div class="pad"></div><div class="target">target</div><div class="tail"></div></div>',
      '.outer{width:180px;height:70px;overflow:auto}.pad,.tail{height:100px}.target{height:50px;background:rgb(12,34,56)}')
    const outer = host.firstElementChild
    const target = outer.querySelector('.target')
    await snapdom(target, burst)
    outer.scrollTop = 90
    expect(outer.scrollTop).toBeGreaterThan(80)
    await expectMatchesFresh(target)
  })
  it('does not publish a first frame whose scroll offset changed after capture observation, even with no event', async () => {
    const host = mount('<div class="pane"><div style="height:300px"></div></div>',
      '.pane{width:160px;height:60px;overflow:auto}')
    const pane = host.firstElementChild
    let top = 0
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get() { return top },
      set(value) { top = Number(value) || 0 },
    })
    let armed = true
    const plugin = {
      name: 'brst3-mid-capture-scroll-no-event',
      pure: true,
      beforeRender() {
        if (!armed) return
        armed = false
        pane.scrollTop = 40
      },
    }

    const options = { ...burst, plugins: [plugin], __burstCaptureScrollBaseline: true }
    const during = await snapdom(pane, options)
    expect(pane.scrollTop).toBe(40)
    const after = await snapdom(pane, options)
    expect(after).not.toBe(during)
    expect(await snapdom(pane, options)).toBe(after)
  })

})
