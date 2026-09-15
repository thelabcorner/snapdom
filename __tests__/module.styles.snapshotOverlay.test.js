import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapdom } from '../src/index.js'

const mounted = []
afterEach(() => {
  vi.restoreAllMocks()
  while (mounted.length) mounted.pop().remove()
})

function mount(css, html) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

const raw = (root, overlay) => snapdom.toRaw(root, {
  burst: false,
  cache: 'disabled',
  embedFonts: false,
  __styleShareSnapshotOverlay: overlay,
})

describe('shared snapshot overlays', () => {
  it('is byte-identical to full copies when one twin strips inherited height and another keeps it', async () => {
    const root = mount(
      '.host{width:240px;font:16px/20px Arial}.twin{position:relative;background:#eee}.abs{position:absolute}',
      '<div class="host">' +
        '<div class="twin"><span class="abs">out of flow</span></div>' +
        '<div class="twin">in flow text</div>' +
      '</div>',
    )
    const historical = await raw(root, false)
    const overlay = await raw(root, true)
    expect(overlay).toBe(historical)
  })

  it('is byte-identical when the first twin strips height and a later twin must restore its own used height', async () => {
    const root = mount(
      '.host{width:240px;font:16px/20px Arial}.twin{position:relative;background:#eee}.abs{position:absolute}',
      '<div class="host">' +
        '<div class="twin">in flow text</div>' +
        '<div class="twin"><span class="abs">out of flow</span></div>' +
      '</div>',
    )
    const historical = await raw(root, false)
    const overlay = await raw(root, true)
    expect(overlay).toBe(historical)
  })

  it('preserves inherited snapshot riders consumed by the background pass', async () => {
    const root = mount(
      '.host{width:240px}.twin{width:100px;height:30px;background:linear-gradient(90deg,#000,#fff) 25% 50%/50px 20px no-repeat}',
      '<div class="host"><div class="twin"></div><div class="twin"></div><div class="twin"></div></div>',
    )
    const historical = await raw(root, false)
    const overlay = await raw(root, true)
    expect(overlay).toBe(historical)
  })

  it.skipIf(typeof Element.prototype.computedStyleMap !== 'function')(
    'is byte-identical when a later twin restores a zero used margin back to auto',
    async () => {
      const root = mount(
        '.host{width:300px}.twin{width:100px;height:24px;margin-inline:auto}',
        '<div class="host"><div class="twin">a</div><div class="twin">b</div><div class="twin">c</div></div>',
      )
      const twins = [...root.querySelectorAll('.twin')]
      const target = twins[1]
      const native = window.getComputedStyle.bind(window)
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
        const style = native(el, pseudo)
        if (el !== target || pseudo) return style
        return new Proxy(style, {
          get(obj, key) {
            if (key === 'getPropertyValue') return (prop) =>
              /^(margin-(left|right|inline-start|inline-end))$/.test(prop) ? '0px' : obj.getPropertyValue(prop)
            if (['marginLeft', 'marginRight', 'marginInlineStart', 'marginInlineEnd'].includes(key)) return '0px'
            const value = Reflect.get(obj, key, obj)
            return typeof value === 'function' ? value.bind(obj) : value
          },
        })
      })

      const historical = await raw(root, false)
      const overlay = await raw(root, true)
      expect(overlay).toBe(historical)
    },
  )

  it('is byte-identical through the flex/grid min-width:auto repair', async () => {
    const root = mount(
      '.host{display:flex;width:240px}.twin{flex:1 1 0;min-width:auto;white-space:nowrap}',
      '<div class="host"><div class="twin">alpha</div><div class="twin">beta</div><div class="twin">gamma</div></div>',
    )
    const historical = await raw(root, false)
    const overlay = await raw(root, true)
    expect(overlay).toBe(historical)
  })
})
