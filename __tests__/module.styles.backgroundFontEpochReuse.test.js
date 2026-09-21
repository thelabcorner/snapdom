import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { backgroundSnapshotFor, snapshotFor } from '../src/modules/styles.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop()?.remove?.() })

function mount(css, inline = '') {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  const root = document.createElement('div')
  const probe = document.createElement('div')
  probe.className = 'probe'
  if (inline) probe.style.cssText = inline
  probe.textContent = 'x'
  root.appendChild(probe)
  document.body.appendChild(root)
  mounted.push(root, style)
  return { root, probe }
}

async function seed(root) {
  await snapdom.toRaw(root, { cache: 'disabled', burst: false, embedFonts: false })
}

function bumpFontEpoch() {
  document.fonts?.dispatchEvent?.(new Event('loadingdone'))
}

describe('R7-BGSNAP1 background snapshot font-epoch authority', () => {
  it('keeps fixed background layout available across a font-only epoch', async () => {
    const { root, probe } = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:24px 12px}')
    await seed(root)
    expect(snapshotFor(probe)).not.toBeNull()
    bumpFontEpoch()
    expect(snapshotFor(probe)).toBeNull()
    expect(backgroundSnapshotFor(probe, true)).not.toBeNull()
    expect(backgroundSnapshotFor(probe, false)).toBeNull()
  })

  it('fails closed for authored font-metric background layout', async () => {
    const { root, probe } = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:10ch 12px}')
    await seed(root)
    bumpFontEpoch()
    expect(backgroundSnapshotFor(probe, true)).toBeNull()
  })

  it('fails closed for inline font-metric background layout', async () => {
    const { root, probe } = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue)}', 'background-size:10ch 12px')
    await seed(root)
    bumpFontEpoch()
    expect(backgroundSnapshotFor(probe, true)).toBeNull()
  })

  it('does not relax viewport/environment invalidation', async () => {
    const { root, probe } = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:24px 12px}')
    await seed(root)
    window.dispatchEvent(new Event('resize'))
    expect(backgroundSnapshotFor(probe, true)).toBeNull()
  })

  it('preserves late afterClone source-style mutation under a simultaneous font epoch', async () => {
    const capture = async (reuse) => {
      const { root, probe } = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:24px 12px}')
      try {
        return await snapdom.toRaw(root, {
          cache: 'disabled', burst: false, embedFonts: false,
          __backgroundFontEpochReuse: reuse,
          plugins: [{
            name: 'bgsnap-source-mutation',
            afterClone() {
              probe.style.backgroundSize = '37px 19px'
              bumpFontEpoch()
            },
          }],
        })
      } finally { root.remove() }
    }
    expect(await capture(true)).toBe(await capture(false))
  })

  it('preserves late afterClone stylesheet mutation under a simultaneous font epoch', async () => {
    const capture = async (reuse) => {
      const { root } = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:24px 12px}')
      const sheet = mounted[mounted.length - 1]
      try {
        return await snapdom.toRaw(root, {
          cache: 'disabled', burst: false, embedFonts: false,
          __backgroundFontEpochReuse: reuse,
          plugins: [{
            name: 'bgsnap-sheet-mutation',
            afterClone() {
              sheet.textContent = '.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:41px 23px}'
              bumpFontEpoch()
            },
          }],
        })
      } finally { root.remove() }
    }
    expect(await capture(true)).toBe(await capture(false))
  })
})
