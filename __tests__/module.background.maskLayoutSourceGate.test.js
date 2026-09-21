import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop()?.remove?.() })

function mount(css, html = '<div class="probe">x</div>') {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root, style)
  return root
}

async function compare(root, extra = {}) {
  const common = { cache: 'disabled', burst: false, embedFonts: false, ...extra }
  const historical = await snapdom.toRaw(root, { ...common, __maskLayoutSourceGate: false })
  const candidate = await snapdom.toRaw(root, { ...common, __maskLayoutSourceGate: true })
  expect(candidate).toBe(historical)
}

describe('R7-MASKLAY1 late mask-layout admission', () => {
  it('is byte-identical for a background-only node with no mask source or mask-layout representation', async () => {
    const root = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue)}')
    await compare(root)
  })

  it('preserves authored mask layout even when no mask source exists', async () => {
    const root = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);mask-position:17px 9px;mask-size:33px 22px}')
    await compare(root)
  })

  it('preserves mask layout when a live mask source exists', async () => {
    const root = mount('.probe{width:80px;height:30px;background:#fff;mask-image:linear-gradient(#000,#0000);mask-position:17px 9px;mask-size:33px 22px;mask-repeat:no-repeat}')
    await compare(root)
  })

  it('fails closed when the late source sentinel itself is disabled', async () => {
    const root = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);mask-position:17px 9px;mask-size:33px 22px}')
    await compare(root, { __backgroundUrlSentinel: false })
  })
})
