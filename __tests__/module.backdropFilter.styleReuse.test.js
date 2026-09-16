import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { emulateBackdropFilters } from '../src/modules/backdropFilter.js'

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
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

function mapTree(source, clone) {
  const map = new Map([[clone, source]])
  const sw = document.createTreeWalker(source, NodeFilter.SHOW_ELEMENT)
  const cw = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT)
  for (;;) {
    const s = sw.nextNode()
    const c = cw.nextNode()
    if (!s || !c) break
    map.set(c, s)
  }
  return map
}

describe('R7-SA4 backdrop style reuse', () => {
  it('reuses a live declaration across a class-state change', () => {
    const root = mount(
      '<div class="probe off">frost</div>',
      '.probe{display:block;width:120px;height:40px;background:rgba(255,255,255,.2)}.off{backdrop-filter:none}.on{backdrop-filter:blur(2px)}',
    )
    const probe = root.firstElementChild
    const styleCache = new WeakMap([
      [root, getComputedStyle(root)],
      [probe, getComputedStyle(probe)],
    ])
    probe.classList.replace('off', 'on')

    const reused = root.cloneNode(true)
    const historical = root.cloneNode(true)
    emulateBackdropFilters(root, reused, mapTree(root, reused), styleCache)
    emulateBackdropFilters(root, historical, mapTree(root, historical), null)
    expect(reused.outerHTML).toBe(historical.outerHTML)
    expect(reused.querySelector('.probe')?.style.isolation).toBe('isolate')
  })

  it('falls back to a fresh source read after inlineAllStyles cannot acquire that source', async () => {
    const capture = async (reuse) => {
      const root = mount(
        '<div class="probe">frost</div>',
        '.probe{display:block;width:120px;height:40px;background:rgba(255,255,255,.2);backdrop-filter:blur(2px)}',
      )
      const probe = root.firstElementChild
      const native = window.getComputedStyle
      let faulted = false
      window.getComputedStyle = function (el, pseudo) {
        const stack = new Error().stack || ''
        if (!faulted && el === probe && stack.includes('inlineAllStyles')) {
          faulted = true
          throw new Error('synthetic transient source-style failure')
        }
        return native.call(this, el, pseudo)
      }
      try {
        const out = await snapdom.toRaw(root, {
          burst: false,
          cache: 'disabled',
          embedFonts: false,
          __backdropStyleReuse: reuse,
        })
        expect(faulted).toBe(true)
        return out
      } finally {
        window.getComputedStyle = native
        root.remove()
      }
    }

    expect(await capture(true)).toBe(await capture(false))
  })
})
