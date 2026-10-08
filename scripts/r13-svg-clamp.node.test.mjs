import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampEncodedSvgHeader } from '../src/exporters/svgHeaderFast.js'

const asUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
const SIDE = 32767, AREA = 16384 * 16384
// Independent exact copy of the old text-transform semantics. No shared
// helper is used in the oracle, so the two algorithms can disagree.
function originalClamp(svg, side = SIDE, area = AREA) {
  const head = svg.match(/<svg\b[^>]*>/i)
  if (!head) return svg
  const tag = head[0]
  const w = parseFloat((tag.match(/\bwidth="([\d.]+)/i) || [])[1])
  const h = parseFloat((tag.match(/\bheight="([\d.]+)/i) || [])[1])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return svg
  const factor = Math.min(1, side / w, side / h, Math.sqrt(area / (w * h)))
  if (factor >= 1) return svg
  const nw = Math.max(1, Math.floor(w * factor))
  const nh = Math.max(1, Math.floor(h * factor))
  return svg.replace(tag, tag
    .replace(/(\bwidth=")[\d.]+/i, `$1${nw}`)
    .replace(/(\bheight=")[\d.]+/i, `$1${nh}`))
}

test('raster clamp URL matches old full decode+encode bytes on very large payloads', () => {
  const payloads = [
    '<rect width="1000" height="1000" fill="rgb(1,2,3)"/>',
    '<image href="data:image/png;base64,a/+b=ab/c+def"/>',
    '<text>' + 'Ω😀&amp;%'.repeat(50000) + '</text>',
    '<metadata>' + 'ab/cde+fg==' .repeat(300000) + '</metadata>',
  ]
  const dimensions = [[32768, 2], [120000, 55000], [22000, 22000],
    [50000, 50000], [65536.25, 3.75], [33000, 9.5]]
  for (const [w, h] of dimensions) {
    for (const body of payloads) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
      const url = asUrl(svg)
      const optimized = clampEncodedSvgHeader(url, SIDE, AREA)
      assert.ok(optimized)
      assert.equal(optimized.url, asUrl(originalClamp(svg)), `mismatch at ${w}x${h}`)
    }
  }
})

test('noncanonical, non-oversized, invalid and unsupported SVGs stay on the old route', () => {
  const small = asUrl('<svg width="60" height="20"/>')
  assert.equal(clampEncodedSvgHeader(small, SIDE, AREA), null)
  assert.equal(clampEncodedSvgHeader(small.replace('%3Csvg', '%3csvg'), SIDE, AREA), null)
  assert.equal(clampEncodedSvgHeader(asUrl('<svg width="bad" height="80000"/>'), SIDE, AREA), null)
  assert.equal(clampEncodedSvgHeader(asUrl('<svg width="0" height="80000"/>'), SIDE, AREA), null)
  assert.equal(clampEncodedSvgHeader(asUrl('<svg width="32768" height="2"' + ' a="x"'.repeat(900) + '>'), SIDE, AREA), null)
  assert.equal(clampEncodedSvgHeader('data:image/png;base64,A', SIDE, AREA), null)
  assert.equal(clampEncodedSvgHeader(small, Infinity, AREA), null)
})