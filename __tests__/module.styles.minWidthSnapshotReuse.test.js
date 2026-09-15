import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop().remove() })

function scene(display, count = 40) {
  const style = document.createElement('style')
  style.textContent = `.mw-root{display:${display};width:800px;flex-wrap:wrap}.mw-item{width:20px;height:10px}`
  document.head.appendChild(style)
  const root = document.createElement('div')
  root.className = 'mw-root'
  for (let i = 0; i < count; i++) {
    const item = document.createElement('span')
    item.className = 'mw-item'
    root.appendChild(item)
  }
  document.body.appendChild(root)
  mounted.push(root, style)
  return root
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushStyleInvalidations()
}

async function compare(root, extra = {}) {
  await settle()
  const common = { cache: 'disabled', burst: false, embedFonts: false, ...extra }
  const historical = await snapdom.toRaw(root, { ...common, __minWidthSnapshotReuse: false })
  const candidate = await snapdom.toRaw(root, { ...common, __minWidthSnapshotReuse: true })
  expect(candidate).toBe(historical)
}

describe('R7-MW1 min-width snapshot reuse', () => {
  it('is byte-identical on flex items', async () => compare(scene('flex')))
  it('is byte-identical on grid items', async () => compare(scene('grid')))
  it('falls back exactly when min-width is excluded from the snapshot', async () => {
    await compare(scene('flex'), { excludeStyleProps: /^min-width$/ })
  })
})
