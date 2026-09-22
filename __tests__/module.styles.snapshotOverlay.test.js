import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { invalidateStyleCaches, snapshotFor } from '../src/modules/styles.js'

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

  it('does not share a flex-item min-width correction across structurally split parent layouts', async () => {
    // The children are intentionally identical. Only their parents differ by structural CSS:
    // the first parent is flex (so inlineAllStyles applies the min-width:0 foreignObject floor),
    // while the second is block. If ancestor partitioning ever stops feeding the child identity,
    // the first child's node-local correction can become the later child's inherited R7 base.
    const root = mount(
      '.wrap{width:220px}.parent{width:180px}.parent:first-child{display:flex}.child{display:block;width:120px}',
      '<div class="wrap">' +
        '<div class="parent"><div class="child">flex child</div></div>' +
        '<div class="parent"><div class="child">block child</div></div>' +
      '</div>',
    )
    const production = await snapdom.toRaw(root, {
      burst: false,
      cache: 'disabled',
      embedFonts: false,
      __styleShareSnapshotOverlay: true,
    })
    const conservative = await snapdom.toRaw(root, {
      burst: false,
      cache: 'disabled',
      embedFonts: false,
      __styleShare: false,
      __styleShareSnapshotOverlay: true,
    })
    expect(production).toBe(conservative)
  })

  it('rebuilds warm overlays before a changed first twin can leak through their prototype', async () => {
    const root = mount(
      '.host{width:180px;font:16px/20px Arial}.twin{display:block;width:180px;background:#eee}',
      '<div class="host">' +
        '<div class="twin">short</div>' +
        '<div class="twin">short</div>' +
        '<div class="twin">short</div>' +
      '</div>',
    )
    const twins = root.querySelectorAll('.twin')
    const opts = { burst: false, embedFonts: false, __styleShareSnapshotOverlay: true }

    await snapdom.toRaw(root, opts)
    const oldOverlay = snapshotFor(twins[2])
    expect(oldOverlay).toBeTruthy()
    expect(Object.getPrototypeOf(oldOverlay)).not.toBe(Object.prototype)

    // Text is intentionally absent from the structural identity. The first twin becomes much
    // taller while the identity remains the same. A stale overlay would therefore observe that
    // changed canonical base through its prototype unless normal DOM invalidation rebuilds it.
    twins[0].textContent = 'long content '.repeat(30)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const warmOverlay = await snapdom.toRaw(root, opts)
    const rebuiltOverlay = snapshotFor(twins[2])
    expect(rebuiltOverlay).toBeTruthy()
    expect(rebuiltOverlay).not.toBe(oldOverlay)
    expect(Object.getPrototypeOf(rebuiltOverlay)).not.toBe(Object.prototype)

    // Force a completely fresh historical-copy oracle after the warm R7 recapture. The output
    // must stay byte-identical even though the first twin is now the tall canonical base.
    invalidateStyleCaches()
    const historical = await snapdom.toRaw(root, {
      ...opts,
      __styleShareSnapshotOverlay: false,
    })
    expect(warmOverlay).toBe(historical)
  })

  it('rebuilds remaining overlays after the canonical twin is removed', async () => {
    const root = mount(
      '.host{width:200px;font:16px/20px Arial}.twin{display:block;width:200px;padding:2px;background:#eef}',
      '<div class="host">' +
        '<div class="twin">first</div>' +
        '<div class="twin">second</div>' +
        '<div class="twin">third</div>' +
        '<div class="twin">fourth</div>' +
      '</div>',
    )
    const twins = [...root.querySelectorAll('.twin')]
    const opts = { burst: false, embedFonts: false, __styleShareSnapshotOverlay: true }

    await snapdom.toRaw(root, opts)
    const oldOverlay = snapshotFor(twins[2])
    expect(oldOverlay).toBeTruthy()
    expect(Object.getPrototypeOf(oldOverlay)).not.toBe(Object.prototype)

    // The overlay's prototype can keep the old canonical snapshot object alive after its source
    // node disappears. Child-list invalidation must nevertheless rebuild the surviving node's
    // cache entry rather than trusting that now-detached base across the warm capture.
    twins[0].remove()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const warm = await snapdom.toRaw(root, opts)
    const rebuiltOverlay = snapshotFor(twins[2])
    expect(rebuiltOverlay).toBeTruthy()
    expect(rebuiltOverlay).not.toBe(oldOverlay)
    expect(Object.getPrototypeOf(rebuiltOverlay)).not.toBe(Object.prototype)

    invalidateStyleCaches()
    const historical = await snapdom.toRaw(root, {
      ...opts,
      __styleShareSnapshotOverlay: false,
    })
    expect(warm).toBe(historical)
  })
})
