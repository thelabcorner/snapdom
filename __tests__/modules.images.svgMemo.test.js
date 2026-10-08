// R16 SVG <image> two-hit admission: precise successes, failures, invalidation,
// bounded retention and complete partitioning from HTML image/proxy identities.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inlineImages } from '../src/modules/images.js'
import { cache, applyCachePolicy, MAX_SVG_IMAGE_MEMO_CHARS } from '../src/core/cache.js'

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
  cache.svgImage.clear()
  cache.svgImageCandidates.clear()
  vi.mocked(snapFetch).mockReset()
  vi.mocked(snapFetch).mockResolvedValue({ ok: true, data: DATA_A })
})

describe('SVG image cross-capture reuse (R15)', () => {
  it('reuses a fetched absolute URL for later clones without touching the source again', async () => {
    const one = svgImage(URL_A)
    const two = svgImage(URL_A)
    const three = svgImage(URL_A)
    await inlineImages(one)
    expect(cache.svgImage.get(URL_A)).toBeUndefined()
    expect(cache.svgImageCandidates.has(URL_A)).toBe(true)
    await inlineImages(two)
    await inlineImages(three)
    expect(one.getAttribute('href')).toBe(DATA_A)
    expect(two.getAttribute('href')).toBe(DATA_A)
    expect(three.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(2)
    expect(cache.svgImage.get(URL_A)).toBe(DATA_A)
  })

  it('never aliases an HTML image/proxy cache entry into an unproxied SVG request', async () => {
    const html = document.createElement('img')
    html.src = URL_A
    vi.mocked(snapFetch).mockResolvedValueOnce({ ok: true, data: DATA_A })
      .mockResolvedValueOnce({ ok: true, data: DATA_B })
      .mockResolvedValueOnce({ ok: true, data: DATA_B })
    await inlineImages(html, { compress: false, useProxy: '/proxy?url=' })
    const svg = svgImage(URL_A)
    await inlineImages(svg)
    expect(cache.svgImageCandidates.has(URL_A)).toBe(true)
    const secondSvg = svgImage(URL_A)
    await inlineImages(secondSvg)
    expect(svg.getAttribute('href')).toBe(DATA_B)
    expect(secondSvg.getAttribute('href')).toBe(DATA_B)
    expect(cache.image.get(URL_A)?.data).toBe(DATA_A)
    expect(cache.svgImage.get(URL_A)).toBe(DATA_B)
    expect(snapFetch).toHaveBeenCalledTimes(3)
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
    expect(cache.svgImage.get(URL_A)).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(3)
  })

  it('does not memoize failures and preserves the original source on failure', async () => {
    vi.mocked(snapFetch).mockResolvedValueOnce({ ok: false, data: null })
      .mockResolvedValueOnce({ ok: true, data: DATA_A })
    const failed = svgImage(URL_A)
    await inlineImages(failed)
    expect(failed.getAttribute('href')).toBe(URL_A)
    expect(cache.svgImage.has(URL_A)).toBe(false)
    const retried = svgImage(URL_A)
    await inlineImages(retried)
    expect(retried.getAttribute('href')).toBe(DATA_A)
    expect(cache.svgImage.has(URL_A)).toBe(false)
    expect(cache.svgImageCandidates.has(URL_A)).toBe(true)
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
    expect(cache.svgImage.has('./icon.png')).toBe(false)
  })

  it('evicts old SVG entries without touching the HTML image memo', async () => {
    await inlineImages(svgImage(URL_A))
    await inlineImages(svgImage(URL_A))
    cache.image.set('image-with-blob', { data: DATA_A, blob: new Blob([DATA_A]) })
    for (let i = 0; i < 60; i++) cache.svgImage.set('https://assets.example.test/' + i, DATA_B)
    expect(cache.image.has('image-with-blob')).toBe(true)
    expect(cache.image.has(URL_A)).toBe(false)
    const again = svgImage(URL_A)
    await inlineImages(again)
    expect(again.getAttribute('href')).toBe(DATA_A)
    expect(snapFetch).toHaveBeenCalledTimes(3)
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
    const third = svgImage(URL_A, 'xlink')
    await inlineImages(first)
    await inlineImages(next)
    await inlineImages(third)
    for (const image of [first, next, third]) {
      expect(image.getAttribute('href')).toBe(DATA_A)
      expect(image.getAttributeNS(XLINK, 'href')).toBeNull()
    }
    expect(snapFetch).toHaveBeenCalledTimes(2)
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

  it('never caches across or inside explicitly disabled capture batches', async () => {
    const root = document.createElementNS(NS, 'svg')
    for (let i = 0; i < 7; i++) root.appendChild(svgImage(URL_A))
    await inlineImages(root, { cache: 'disabled' })
    await inlineImages(svgImage(URL_A), { cache: false })
    expect(snapFetch).toHaveBeenCalledTimes(8)
    expect(cache.svgImage.has(URL_A)).toBe(false)
    expect(cache.svgImageCandidates.has(URL_A)).toBe(false)
  })

  it('reuses successful SVG sources across a capture batch boundary with cache enabled', async () => {
    const root = document.createElementNS(NS, 'svg')
    for (let i = 0; i < 7; i++) root.appendChild(svgImage(URL_A))
    await inlineImages(root, { cache: 'soft' })
    // The first six mock snapFetch calls resolve in parallel; the seventh must
    // see the successful persistent memo. Actual snapFetch also coalesces in-flight.
    expect(snapFetch).toHaveBeenCalledTimes(6)
    expect(cache.svgImage.get(URL_A)).toBe(DATA_A)
  })

  it('leaves a bounded URL-only probation set under one-off high-cardinality scans', async () => {
    const root = document.createElementNS(NS, 'svg')
    for (let i = 0; i < 120; i++) root.appendChild(svgImage(URL_A + '?id=' + i))
    await inlineImages(root)
    expect(snapFetch).toHaveBeenCalledTimes(120)
    expect(cache.svgImage.size).toBe(0)
    expect(cache.svgImageCandidates.size).toBe(120)
    const reused = svgImage(URL_A + '?id=119')
    await inlineImages(reused)
    expect(reused.getAttribute('href')).toBe(DATA_A)
    expect(cache.svgImage.has(URL_A + '?id=119')).toBe(true)
    expect(cache.svgImageCandidates.has(URL_A + '?id=119')).toBe(false)
  })

  it('rejects a single oversized source instead of pinning unbounded data URL memory', async () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_SVG_IMAGE_MEMO_CHARS)
    vi.mocked(snapFetch).mockResolvedValue({ ok: true, data: huge })
    await inlineImages(svgImage(URL_A))
    expect(cache.svgImage.has(URL_A)).toBe(false)
    expect(cache.svgImageCandidates.has(URL_A)).toBe(false)
  })
})
