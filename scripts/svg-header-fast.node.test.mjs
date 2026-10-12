import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { scaleEncodedSvgHeader } from '../src/exporters/svgHeaderFast.js'

const prefix = 'data:image/svg+xml;charset=utf-8,'
const asUrl = (xml) => prefix + encodeURIComponent(xml)

function oldScale(url, scale) {
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1))
  const head = (svg.match(/<svg\b[^>]*>/i) || [])[0] || ''
  const w = Number((head.match(/\bwidth="([\d.]+)"/i) || [])[1])
  const h = Number((head.match(/\bheight="([\d.]+)"/i) || [])[1])
  if (!(w > 0 && h > 0)) return null
  const next = head
    .replace(/\bwidth="[^"]*"/i, `width="${Math.max(1, Math.round(w * scale))}"`)
    .replace(/\bheight="[^"]*"/i, `height="${Math.max(1, Math.round(h * scale))}"`)
  return prefix + encodeURIComponent(svg.replace(head, next))
}

test('header-only path is byte-identical across arbitrary valid inline SVG suffixes and scales', () => {
  const tails = [
    '<rect x="2" y="3" width="4" height="5"/>',
    '<text>Unicode Ω é 中 😀 text &amp; quote &quot; here</text>',
    '<image href="data:image/png;base64,a/b+c=d/e+f=="/>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" style="width:99px">A%20+B/C</div></foreignObject>',
    'á😀'.repeat(12000),
    '<g>' + 'a/+=&%'.repeat(100000) + '</g>',
  ]
  const heads = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10">',
    '<svg height="48.125" width="16.5" viewBox="0 0 16.5 48.125">',
    '<svg width="1200" height="800" font-size="16px">',
  ]
  for (const head of heads) for (const tail of tails) for (const scale of [0.1, 0.5, 1.25, 2, 3.1]) {
    const input = asUrl(head + tail + '</svg>')
    assert.equal(scaleEncodedSvgHeader(input, scale), oldScale(input, scale), 'raw bytes differ at scale ' + scale)
  }
})

test('fast path refuses noncanonical inputs and invalid dimensions', () => {
  const clean = asUrl('<svg width="20" height="10"><rect/></svg>')
  assert.equal(scaleEncodedSvgHeader(clean, 2), oldScale(clean, 2))
  assert.equal(scaleEncodedSvgHeader(clean.replace('%3Csvg', '%3csvg'), 2), null)
  assert.equal(scaleEncodedSvgHeader(clean.replace('width%3D', 'width='), 2), null)
  assert.equal(scaleEncodedSvgHeader(asUrl('<svg width="auto" height="10"/>'), 2), null)
  assert.equal(scaleEncodedSvgHeader(asUrl('<svg width="0" height="10"/>'), 2), null)
  assert.equal(scaleEncodedSvgHeader(asUrl('<svg width="20" height="10"' + ' a="x"'.repeat(800) + '>'), 2), null)
  assert.equal(scaleEncodedSvgHeader('data:image/png;base64,AAAA', 2), null)
  assert.equal(scaleEncodedSvgHeader(clean, Infinity), null)
  assert.equal(scaleEncodedSvgHeader(clean, NaN), null)
})

test('microbenchmark: exact-output header surgery against full decode/re-encode', { skip: !process.env.SNAPDOM_HEADER_BENCH }, () => {
  const iterations = 9
  for (const bytes of [1 << 20, 8 << 20, 32 << 20]) {
    const xml = '<svg width="1200" height="800"><image href="data:image/png;base64,' +
      'abcdefg+hijklmno/qrstuvwx0123456789'.repeat(Math.ceil(bytes / 34)) + '"/></svg>'
    const input = asUrl(xml)
    assert.equal(scaleEncodedSvgHeader(input, 1.75), oldScale(input, 1.75))
    const baseline = [], optimized = []
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      const old = oldScale(input, 1.75)
      baseline.push(performance.now() - start)
      const start2 = performance.now()
      const fast = scaleEncodedSvgHeader(input, 1.75)
      optimized.push(performance.now() - start2)
      assert.equal(old.length, fast.length)
    }
    const median = (v) => v.sort((a,b) => a-b)[v.length >> 1]
    const b = median(baseline), f = median(optimized)
    console.log(JSON.stringify({ bytes, oldMedianMs:b, headerMedianMs:f, ratio:b/f }))
  }
})