// R15 SVG <image> cross-capture memo: precise successes, failures, invalidation,
// bounded eviction and shared <img> identity without changing proxy semantics.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inlineImages } from '../src/modules/images.js'
import { cache, applyCachePolicy } from '../src/core/cache.js'

vi.mock('../src/modules/snapFetch.js', () => ({
  snapFetch: vi.fn()
}))
import { snapFetch } from '../src/modules/snapFetch.js'

const URL_A = 'https://assets.example.test/r15-icon.png'
const URL_B = 'https://assets.example.test/r15-other.png'
const DATA_A = 'data:image/png;base64,QUJD'
const DATA_B = 'data:image/png;base64,REVG'
const NS = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'

function svgImage(url, attr = 'href') {
  const el = document.createElementNS(NS, 'image')
  if (attr === 'xlink') el.setAttributeNS(XLINK, 'xlink:href', url)
  else el.setAttribute('href', url)
  return el
}

beforeEach(() => {
  cache.image.clear()
  vi.mocked(snapFetch).mockReset()
  vi.mocked(snapFetch).mockResolvedValue({ ok: true, data: DATA_A })
})

describe('SVG image cross-capture reuse (R15)', () => {
  it('reuses a fetched absolute URL for later clones without touching the source again', async () => {
    const one = svgImage(URL_A)
    const two = svgImage(URL_A)
    await inlineImages(one)
    await inlineImages(two)
    expect(one.getAttribute('href')).toBe(DATA_A)
    expect(two.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(1)
    expect(cache.image.get(URL_A)).toEqual({ data: DATA_A })
  })

  it('shares exactly the same successful URL memo already written by HTML img', async () => {
    const html = document.createElement('img')
    html.src = URL_A
    await inlineImages(html, { compress: false })
    const svg = svgImage(URL_A)
    await inlineImages(svg)
    expect(svg.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(1)
  })

  it('preserves unrelated successful source identities', async () => {
    vi.mocked(snapFetch).mockImplementation(async (url) => ({
      ok: true, data: url === URL_A ? DATA_A : DATA_B
    }))
    await inlineImages(svgImage(URL_A))
    await inlineImages(svgImage(URL_B))
    const again = svgImage(URL_A)
    await inlineImages(again)
    expect(again.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(2)
  })

  it('does not memoize failures and preserves the original source on failure', async () => {
    vi.mocked(snapFetch).mockResolvedValueOnce({ ok: false, data: null })
      .mockResolvedValueOnce({ ok: true, data: DATA_A })
    const failed = svgImage(URL_A)
    await inlineImages(failed)
    expect(failed.getAttribute('href')).toBe(URL_A)
    expect(cache.image.has(URL_A)).toBe(false)
    const retried = svgImage(URL_A)
    await inlineImages(retried)
    expect(retried.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(2)
  })

  it('does not retain malformed successful responses', async () => {
    vi.mocked(snapFetch).mockResolvedValueOnce({ ok: true, data: 'not-a-data-url' })
      .mockResolvedValueOnce({ ok: true, data: DATA_A })
    await inlineImages(svgImage(URL_A))
    expect(cache.image.has(URL_A)).toBe(false)
    const retried = svgImage(URL_A)
    await inlineImages(retried)
    expect(retried.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(2)
  })

  it('does not alias proxy-dependent results into the ordinary source URL cache', async () => {
    vi.mocked(snapFetch).mockResolvedValueOnce({ ok: true, data: DATA_A })
      .mockResolvedValueOnce({ ok: true, data: DATA_B })
    const first = svgImage(URL_A)
    const second = svgImage(URL_A)
    await inlineImages(first, { useProxy: '/proxy?url=' })
    await inlineImages(second, { useProxy: '/proxy?url=' })
    expect(first.getAttribute('href')).toBe(DATA_A)
    expect(second.getAttribute('href')).toBe(DATA_B)
    expect(snapFetch).toHaveBeenCalledTimes(2)
    expect(cache.image.has(URL_A)).toBe(false)
  })

  it('keeps relative URLs on the ordinary fetch path to respect document-base changes', async () => {
    await inlineImages(svgImage('./icon.png'))
    await inlineImages(svgImage('./icon.png'))
    expect(snapFetch).toHaveBeenCalledTimes(2)
    expect(cache.image.has('./icon.png')).toBe(false)
  })

  it('evicts old SVG entries through the existing bounded image memo', async () => {
    await inlineImages(svgImage(URL_A))
    for (let i = 0; i < 110; i++) cache.image.set('https://assets.example.test/' + i, { data: DATA_B })
    expect(cache.image.has(URL_A)).toBe(false)
    const again = svgImage(URL_A)
    await inlineImages(again)
    expect(again.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(2)
  })

  it('honors the pre-existing global disabled-cache clearing mechanism', async () => {
    await inlineImages(svgImage(URL_A))
    applyCachePolicy('disabled')
    await inlineImages(svgImage(URL_A))
    expect(snapFetch).toHaveBeenCalledTimes(2)
  })

  it('preserves the href/xlink canonicalization contract on both miss and hit', async () => {
    const first = svgImage(URL_A, 'xlink')
    const next = svgImage(URL_A, 'xlink')
    await inlineImages(first)
    await inlineImages(next)
    for (const image of [first, next]) {
      expect(image.getAttribute('href')).toBe(DATA_A)
      expect(image.getAttributeNS(XLINK, 'href')).toBeNull()
    }
    expect(snapFetch).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite embedded data or blob URLs', async () => {
    const data = svgImage(DATA_A)
    const blob = svgImage('blob:https://assets.example.test/r15')
    await inlineImages(data)
    await inlineImages(blob)
    expect(data.getAttribute('href')).toBe(DATA_A)
    expect(blob.getAttribute('href')).toBe('blob:https://assets.example.test/r15')
    expect(snapFetch).not.toHaveBeenCalled()
  })
})
