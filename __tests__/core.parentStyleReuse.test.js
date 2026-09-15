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
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

async function raw(root, reuse, extra = {}) {
  return snapdom.toRaw(root, {
    burst: false,
    cache: 'disabled',
    embedFonts: false,
    __parentStyleReuse: reuse,
    ...extra,
  })
}

describe('R7-SA3 parent style reuse', () => {
  it.each(['flex', 'grid'])('is byte-identical for ordinary %s items', async (display) => {
    const root = mount(
      '<div class="parent"><span class="item">a</span><span class="item">b</span></div>',
      `.parent{display:${display};width:240px}.item{width:80px}`,
    )
    expect(await raw(root, true)).toBe(await raw(root, false))
  })

  it('observes a parent display mutation made after the parent snapshot', async () => {
    const capture = async (reuse) => {
      const root = mount(
        '<div class="parent"><span class="item">child</span></div>',
        '.parent{display:block;width:80px}.parent.flex{display:flex}.item{width:160px}',
      )
      let changed = false
      const out = await raw(root, reuse, {
        filter(el) {
          if (!changed && el.classList?.contains('item')) {
            changed = true
            root.querySelector('.parent').classList.add('flex')
          }
          return true
        },
      })
      root.remove()
      return out
    }
    expect(await capture(true)).toBe(await capture(false))
  })

  it('does not retain a stale flex classification when the parent becomes block', async () => {
    const capture = async (reuse) => {
      const root = mount(
        '<div class="parent flex"><span class="item">child</span></div>',
        '.parent{display:block;width:80px}.parent.flex{display:flex}.item{width:160px}',
      )
      let changed = false
      const out = await raw(root, reuse, {
        filter(el) {
          if (!changed && el.classList?.contains('item')) {
            changed = true
            root.querySelector('.parent').classList.remove('flex')
          }
          return true
        },
      })
      root.remove()
      return out
    }
    expect(await capture(true)).toBe(await capture(false))
  })

  it('falls back safely when the child is reparented under an uncached live parent', async () => {
    const capture = async (reuse) => {
      const external = document.createElement('div')
      external.style.display = 'flex'
      document.body.appendChild(external)
      mounted.push(external)
      const root = mount('<div class="parent"><span class="item">child</span></div>')
      let changed = false
      const out = await raw(root, reuse, {
        filter(el) {
          if (!changed && el.classList?.contains('item')) {
            changed = true
            external.appendChild(el)
          }
          return true
        },
      })
      root.remove()
      external.remove()
      return out
    }
    expect(await capture(true)).toBe(await capture(false))
  })

  it('remains byte-identical for flex layout inside an open shadow root', async () => {
    const capture = async (reuse) => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      mounted.push(host)
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML = '<style>.p{display:flex;width:180px}.i{width:120px}</style><div class="p"><span class="i">shadow</span></div>'
      return raw(host, reuse)
    }
    expect(await capture(true)).toBe(await capture(false))
  })
})
