import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'

const mounted = []
afterEach(() => {
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
})
