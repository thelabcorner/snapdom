import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  flushStyleInvalidations()
})

function mount(css, build) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  const root = document.createElement('div')
  build(root)
  document.body.appendChild(root)
  mounted.push(root, style)
  flushStyleInvalidations()
  return root
}

async function parity(root, extra = {}) {
  const common = { cache: 'disabled', burst: false, embedFonts: false, ...extra }
  const historical = await snapdom.toRaw(root, { ...common, __backgroundStateProbeGate: false })
  const candidate = await snapdom.toRaw(root, { ...common, __backgroundStateProbeGate: true })
  expect(candidate).toBe(historical)
}

describe('R7-BGSTATE1 background-state probe admission', () => {
  it('is exact on neutral unique divs with no background channels', async () => {
    const root = mount('.x{display:block;padding:2px;color:#334155}', (root) => {
      for (let i = 0; i < 80; i++) {
        const el = document.createElement('div')
        el.className = `x entropy-${i}`
        el.textContent = `row ${i}`
        root.appendChild(el)
      }
    })
    await parity(root)
  })

  it('falls back for authored backgrounds', async () => {
    const root = mount('.x{background:linear-gradient(red,blue)}', (root) => {
      const el = document.createElement('div'); el.className = 'x'; root.appendChild(el)
    })
    await parity(root)
  })

  it('falls back for inline background/mask state', async () => {
    const root = mount('', (root) => {
      const el = document.createElement('div')
      el.style.backgroundColor = 'rgb(1, 2, 3)'
      root.appendChild(el)
    })
    await parity(root)
  })

  it('falls back for all:inherit', async () => {
    const root = mount('.parent{background:rgb(7,8,9)} .child{all:inherit}', (root) => {
      root.className = 'parent'
      const el = document.createElement('div'); el.className = 'child'; root.appendChild(el)
    })
    await parity(root)
  })

  it('falls back for an open shadow host', async () => {
    const root = mount('', (root) => {
      const host = document.createElement('div')
      const shadow = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = ':host{background:rgb(9,8,7)}'
      shadow.append(style, document.createElement('span'))
      root.appendChild(host)
    })
    await parity(root)
  })

  it('falls back while a WAAPI animation is active', async () => {
    const root = mount('', (root) => {
      const el = document.createElement('div')
      root.appendChild(el)
      const anim = el.animate(
        [{ backgroundColor: 'rgb(1,2,3)' }, { backgroundColor: 'rgb(4,5,6)' }],
        { duration: 100000, iterations: Infinity },
      )
      mounted.push({ remove: () => anim.cancel() })
    })
    await parity(root)
  })
})
