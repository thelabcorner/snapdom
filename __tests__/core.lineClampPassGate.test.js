import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations, needsTextTruncationPrepass } from '../src/modules/styles.js'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  document.body.innerHTML = ''
  flushStyleInvalidations()
})

function mountRoot(count = 20) {
  const root = document.createElement('div')
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div')
    el.className = 'lcg-row'
    el.textContent = `row ${i}`
    root.appendChild(el)
  }
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

function mountStyle(css) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  flushStyleInvalidations()
  return style
}

async function rawArm(root, enabled) {
  return snapdom.toRaw(root, {
    burst: false,
    cache: 'disabled',
    embedFonts: false,
    __lineClampPassGate: enabled,
  })
}

describe('R7-LCG1 text-truncation pass admission', () => {
  it('proves an ordinary light-DOM subtree has no truncation work', () => {
    mountStyle('.lcg-row { width: 80px; color: rgb(1, 2, 3); }')
    const root = mountRoot()
    expect(needsTextTruncationPrepass(root)).toBe(false)
  })

  it('fails closed for authored and inline truncation declarations', () => {
    mountStyle('.lcg-row { text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }')
    const authored = mountRoot()
    expect(needsTextTruncationPrepass(authored)).toBe(true)
    authored.remove()

    const inline = mountRoot()
    inline.firstElementChild.style.textOverflow = 'ellipsis'
    expect(needsTextTruncationPrepass(inline)).toBe(true)
  })

  it('fails closed when a shadow stylesheet can style a host', () => {
    const root = mountRoot(1)
    const host = root.firstElementChild
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>:host{ text-overflow:ellipsis; white-space:nowrap; overflow:hidden }</style><slot></slot>'
    expect(needsTextTruncationPrepass(root)).toBe(true)
  })

  it('fails closed while any CSS/WAAPI animation is live', () => {
    const root = mountRoot(1)
    const animation = root.firstElementChild.animate(
      [{ opacity: 1 }, { opacity: 0.5 }],
      { duration: 100000, iterations: Infinity },
    )
    try {
      expect(needsTextTruncationPrepass(root)).toBe(true)
    } finally {
      animation.cancel()
    }
  })

  it('is byte-identical to the historical pass on both static and truncating scenes', async () => {
    mountStyle('.lcg-row { width: 80px; color: rgb(2, 3, 4); }')
    const staticRoot = mountRoot(40)
    expect(await rawArm(staticRoot, true)).toBe(await rawArm(staticRoot, false))
    staticRoot.remove()

    mountStyle('.lcg-row { width: 40px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }')
    const truncatedRoot = mountRoot(4)
    expect(await rawArm(truncatedRoot, true)).toBe(await rawArm(truncatedRoot, false))
  })
})
