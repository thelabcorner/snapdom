import { describe, it, expect, vi, beforeEach } from 'vitest'
import { inlineImages } from '../src/modules/images.js'
import { snapFetch } from '../src/modules/snapFetch.js'

vi.mock('../src/modules/snapFetch.js', () => ({ snapFetch: vi.fn() }))

const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

function createMixedClone() {
  const clone = document.createElement('div')
  for (let i = 0; i < 7; i++) {
    const img = document.createElement('img')
    img.setAttribute('src', 'https://r17.invalid/' + (i === 0 ? 'slow' : i) + '.png')
    clone.appendChild(img)
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const image = document.createElementNS('http://www.w3.org/2000/svg', 'image')
  image.setAttribute('href', 'https://r17.invalid/vector.png')
  svg.appendChild(image)
  clone.appendChild(svg)
  return { clone, image }
}

describe('R17 image work queue', () => {
  beforeEach(() => { vi.mocked(snapFetch).mockReset() })

  it('admits SVG work before a stalled HTML asset settles, with at most six inflight', async () => {
    const { clone, image } = createMixedClone()
    let releaseSlow
    let active = 0
    let peak = 0
    const started = []
    vi.mocked(snapFetch).mockImplementation(async url => {
      active++
      peak = Math.max(peak, active)
      started.push(url)
      if (url.includes('/slow.')) {
        await new Promise(resolve => { releaseSlow = resolve })
      }
      active--
      return { ok: true, data: DATA }
    })
    const pending = inlineImages(clone)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    expect(peak).toBeLessThanOrEqual(6)
    expect(started).toContain('https://r17.invalid/vector.png')
    expect(typeof releaseSlow).toBe('function')
    releaseSlow()
    await pending
    expect(active).toBe(0)
    expect(clone.querySelectorAll('img').length).toBe(7)
    expect(Array.from(clone.querySelectorAll('img')).every(img => img.getAttribute('src') === DATA)).toBe(true)
    expect(image.getAttribute('href')).toBe(DATA)
  })

  it('keeps HTML placeholder and SVG failure behavior independent', async () => {
    const clone = document.createElement('div')
    const img = document.createElement('img')
    img.src = 'https://r17.invalid/missing.png'
    img.dataset.snapdomWidth = '120'
    img.dataset.snapdomHeight = '40'
    clone.appendChild(img)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image')
    image.setAttribute('xlink:href', 'https://r17.invalid/broken.svg')
    svg.appendChild(image)
    clone.appendChild(svg)
    vi.mocked(snapFetch).mockResolvedValue({ ok: false, data: null })
    await inlineImages(clone, { placeholders: false })
    expect(clone.querySelector('img')).toBeNull()
    expect(clone.firstElementChild.style.visibility).toBe('hidden')
    expect(clone.firstElementChild.style.width).toBe('120px')
    expect(image.getAttribute('xlink:href')).toBe('https://r17.invalid/broken.svg')
  })
})
