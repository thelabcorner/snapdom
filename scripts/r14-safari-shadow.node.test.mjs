import { test } from 'node:test'
import assert from 'node:assert/strict'
import { definitelyNoEncodedSafariShadows, resizeEncodedSafariSvg } from '../src/exporters/safariHeaderFast.js'

const asUrl = markup => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
const historicShadow = markup => /(?:box-shadow|text-shadow)\s*:[^;"}]*px/i.test(markup)

function historicSafariNoShadowResize(input, { scale = 1, width, height, meta = {} }) {
  const svg = decodeURIComponent(input.split(',').slice(1).join(','))
  const head = (svg.match(/<svg\b[^>]*>/i) || [])[0] || ''
  const natW = parseFloat((head.match(/\bwidth="([\d.]+)/i) || [])[1])
  const natH = parseFloat((head.match(/\bheight="([\d.]+)/i) || [])[1])
  if (!Number.isFinite(natW) || !Number.isFinite(natH)) return null
  const refW = Number.isFinite(meta.vbW) ? meta.vbW : Number.isFinite(meta.w0) ? meta.w0 : natW
  const refH = Number.isFinite(meta.vbH) ? meta.vbH : Number.isFinite(meta.h0) ? meta.h0 : natH
  const hasW = Number.isFinite(width), hasH = Number.isFinite(height)
  let cssW, cssH
  if (hasW && hasH) { cssW = width; cssH = height }
  else if (hasW) { cssW = width; cssH = Math.max(1, Math.round(refH * (width / Math.max(1, refW)))) }
  else if (hasH) { cssH = height; cssW = Math.max(1, Math.round(refW * (height / Math.max(1, refH)))) }
  else { cssW = Math.max(1, Math.round(natW * scale)); cssH = Math.max(1, Math.round(natH * scale)) }
  const next = svg.replace(/width="[^"]*"/, `width="${cssW}"`).replace(/height="[^"]*"/, `height="${cssH}"`)
  return { url: asUrl(next), width: cssW, height: cssH }
}

test('shadow/no-shadow discriminator never reports safe when historical Safari would rewrite', () => {
  const samples = [
    '<style>div{box-shadow:none;text-shadow:none}</style>',
    '<style>div{box-shadow:0 3px 5px #333;text-shadow:none}</style>',
    '<style>div{text-shadow:0 -3PX 0 red;box-shadow:none}</style>',
    '<div style="box-shadow:none;width:14px;height:30px">A</div>',
    '<div style="box-shadow:var(--some-shadow);width:2px">B</div>',
    '<div style="box-shadow:0 2em 1em black">C</div>',
    '<text>box-shadow:0 2px 1px red</text>',
    '<text>box-shadow:none; font:16px sans-serif</text>',
    '<div style="text-shadow: none; line-height: 16px; box-shadow: none"></div>',
    '<text>' + 'never a shadow 🧠'.repeat(5000) + '</text>',
  ]
  for (const body of samples) {
    const svg = '<svg width="20" height="10">' + body + '</svg>'
    const safe = definitelyNoEncodedSafariShadows(asUrl(svg))
    if (safe) assert.equal(historicShadow(svg), false, 'unsafe shadow bypass: ' + body.slice(0,100))
  }
  const shadow = asUrl('<svg width="20" height="10"><g style="box-shadow:0 5px 1px black"/></svg>')
  assert.equal(definitelyNoEncodedSafariShadows(shadow), false)
  assert.equal(definitelyNoEncodedSafariShadows(shadow.replace('box-shadow', '%62ox-shadow')), false)
  assert.equal(definitelyNoEncodedSafariShadows(shadow.replace('box-shadow', 'box%2Dshadow')), false)
})

test('seeded adversarial scanner checks 4,000 CSS/markup combinations for false negatives', () => {
  let state = 0x6bf9055d
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  const parts = ['box-shadow', 'text-shadow', 'margin', 'box-shadow:none', 'px', '2px', ';', '}', '"',
    'text-shadow:0 2px #000', 'box-shadow:0 -2PX 1px rgb(0,0,0)', 'ä😀Ω', '  :', 'none', '<div>', '&quot;']
  for (let i = 0; i < 4000; i++) {
    let body = ''
    for (let j = 0; j < (next() % 30) + 1; j++) body += parts[next() % parts.length]
    const svg = '<svg width="20" height="10">' + body + '</svg>'
    if (definitelyNoEncodedSafariShadows(asUrl(svg))) {
      assert.equal(historicShadow(svg), false, 'scanner falsely proved no shadow at sample ' + i)
    }
  }
})

test('header-only Safari sizing is byte-identical to historical rewrite for all sizing modes', () => {
  const sources = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="15"><rect width="30" height="15"/></svg>',
    '<svg height="12.125" width="100.75"><style>rect{box-shadow:none;width:30px}</style><rect/></svg>',
    '<svg width="1200" height="700"><metadata>' + 'A%+Ω😀/e'.repeat(25000) + '</metadata></svg>',
  ]
  const options = [
    { scale: 2 }, { scale: 0.5 }, { scale: 3.7 },
    { width: 225 }, { height: 64 }, { width: 200, height: 77 },
    { width: 150, meta: { vbW: 600, vbH: 400 } },
    { height: 240, meta: { w0: 100, h0: 25 } },
  ]
  for (const svg of sources) for (const opts of options) {
    const encoded = asUrl(svg)
    assert.equal(definitelyNoEncodedSafariShadows(encoded), true)
    assert.deepEqual(resizeEncodedSafariSvg(encoded, opts), historicSafariNoShadowResize(encoded, opts))
  }
})

test('unusual encodings and dimensions are sent to the legacy fallback', () => {
  const svg = asUrl('<svg width="20" height="10"><rect/></svg>')
  assert.equal(resizeEncodedSafariSvg(svg.replace('%3Csvg', '%3csvg'), { scale: 2 }), null)
  assert.equal(resizeEncodedSafariSvg(asUrl('<svg width="auto" height="10"/>'), { scale: 2 }), null)
  assert.equal(resizeEncodedSafariSvg('data:image/png;base64,AA', { scale: 2 }), null)
  assert.equal(resizeEncodedSafariSvg(asUrl('<svg width="20" height="10"' + ' a="abc"'.repeat(900) + '></svg>'), { scale: 2 }), null)
})