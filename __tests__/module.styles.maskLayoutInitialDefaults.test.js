import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { maskLayoutInitialValues, backgroundSnapshotFor, snapshotFor } from '../src/modules/styles.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop()?.remove?.() })

const MASK_PROPS = new Set([
  'mask-position', 'mask-size', 'mask-repeat', 'mask-mode', 'mask-composite',
  '-webkit-mask-position', '-webkit-mask-size', '-webkit-mask-repeat', '-webkit-mask-composite',
  'mask-origin', 'mask-clip', '-webkit-mask-origin', '-webkit-mask-clip',
  '-webkit-mask-position-x', '-webkit-mask-position-y',
])

function mount(css, nodes = 2, inline = '') {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  const root = document.createElement('div')
  root.className = 'root'
  for (let i = 0; i < nodes; i++) {
    const probe = document.createElement('div')
    probe.className = 'probe'
    if (inline) probe.style.cssText = inline
    probe.dataset.i = String(i)
    root.appendChild(probe)
  }
  document.body.appendChild(root)
  mounted.push(root, style)
  return { root, probes: [...root.children] }
}

function bumpFontEpoch() {
  document.fonts?.dispatchEvent?.(new Event('loadingdone'))
}

async function capture(root, flags) {
  const proto = CSSStyleDeclaration.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'getPropertyValue')
  const original = proto.getPropertyValue
  let maskReads = 0
  Object.defineProperty(proto, 'getPropertyValue', {
    ...desc,
    value(prop) { if (MASK_PROPS.has(String(prop))) maskReads++; return original.apply(this, arguments) },
  })
  try {
    const raw = await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      ...flags,
      plugins: [{
        name: 'maskdef-font-epoch',
        afterClone() { bumpFontEpoch() },
      }],
    })
    return { raw, maskReads }
  } finally {
    Object.defineProperty(proto, 'getPropertyValue', desc)
  }
}

const GRADIENT = '.root{width:900px}.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:24px 12px}'

describe('R7-MASKDEF1 mask layout initial-default folding', () => {
  it('fold path stays byte-identical to the historical live-read arm and removes mask reads', async () => {
    const { root } = mount(GRADIENT, 4)
    const hist = await capture(root, { __backgroundFontEpochReuse: true, __maskLayoutInitialDefaults: false })
    const cand = await capture(root, { __backgroundFontEpochReuse: true })
    expect(cand.raw).toBe(hist.raw)
    expect(hist.maskReads).toBeGreaterThan(0)
    expect(cand.maskReads).toBeLessThan(hist.maskReads)
  })

  it('memoizes one Map per (document, tag) for provably mask-initial nodes', () => {
    const { probes } = mount(GRADIENT, 2)
    const a = maskLayoutInitialValues(probes[0])
    const b = maskLayoutInitialValues(probes[1])
    expect(a).toBeInstanceOf(Map)
    expect(a).toBe(b)
  })

  it('fails closed for authored mask layout and keeps exact bytes', async () => {
    const { root, probes } = mount('.probe{width:80px;height:30px;background:linear-gradient(red,blue);mask-position:10px 10px}', 2)
    expect(maskLayoutInitialValues(probes[0])).toBeNull()
    const hist = await capture(root, { __backgroundFontEpochReuse: true, __maskLayoutInitialDefaults: false })
    const cand = await capture(root, { __backgroundFontEpochReuse: true })
    expect(cand.raw).toBe(hist.raw)
    expect(cand.maskReads).toBe(hist.maskReads)
  })

  it('fails closed for an inline mask declaration and keeps exact bytes', async () => {
    const { root, probes } = mount(GRADIENT, 2, 'mask-position:10px 10px')
    expect(maskLayoutInitialValues(probes[0])).toBeNull()
    const hist = await capture(root, { __backgroundFontEpochReuse: true, __maskLayoutInitialDefaults: false })
    const cand = await capture(root, { __backgroundFontEpochReuse: true })
    expect(cand.raw).toBe(hist.raw)
  })

  it('fails closed for an SVG mask presentation attribute', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('mask', 'url(#m)')
    expect(maskLayoutInitialValues(svg)).toBeNull()
  })

  it('fails closed under a live WAAPI mask animation and keeps exact bytes', async () => {
    const { root, probes } = mount(GRADIENT, 2)
    const anim = probes[0].animate(
      [{ maskPosition: '0px 0px' }, { maskPosition: '40px 40px' }],
      { duration: 10000, iterations: Infinity },
    )
    try {
      expect(maskLayoutInitialValues(probes[0])).toBeNull()
      const hist = await capture(root, { __backgroundFontEpochReuse: true, __maskLayoutInitialDefaults: false })
      const cand = await capture(root, { __backgroundFontEpochReuse: true })
      expect(cand.raw).toBe(hist.raw)
    } finally { anim.cancel() }
  })

  it('still relaxes font-epoch snapshots when folding is disabled', () => {
    const { probes } = mount(GRADIENT, 1)
    return snapdom.toRaw(probes[0].parentElement, { cache: 'disabled', burst: false, embedFonts: false }).then(() => {
      bumpFontEpoch()
      expect(snapshotFor(probes[0])).toBeNull()
      expect(backgroundSnapshotFor(probes[0], true)).not.toBeNull()
      expect(backgroundSnapshotFor(probes[0], false)).toBeNull()
    })
  })
})
