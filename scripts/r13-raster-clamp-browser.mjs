#!/usr/bin/env node
/**
 * Public Actions-only pixel and timing comparison between a pinned pre-R13
 * bundle and R13. The live capture has an intentionally overwide SVG header
 * plus an independently inlined noise PNG; only export-time raster clamp is
 * measured. Both captures must produce byte-identical raw SVG URLs.
 */
import fs from 'node:fs'
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('R13 browser measurements are GitHub Actions only')
}
const engine = process.argv.find(a => a.startsWith('--engine='))?.slice(9)
const engines = { chromium, firefox, webkit }
if (!engines[engine]) throw new Error('missing valid --engine')
const files = {
  '/baseline.mjs': fs.readFileSync('__r13_baseline/dist/snapdom.mjs'),
  '/candidate.mjs': fs.readFileSync('dist/snapdom.mjs'),
}
const server = http.createServer((req, res) => {
  if (files[req.url]) {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(files[req.url])
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>R13 raster header clamp</title>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await engines[engine].launch({ headless: true })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  const result = await page.evaluate(async () => {
    const [oldModule, newModule] = await Promise.all([import('/baseline.mjs'), import('/candidate.mjs')])
    const noise = document.createElement('canvas')
    noise.width = 512; noise.height = 512
    const g = noise.getContext('2d')
    const rgba = g.createImageData(512, 512)
    let rng = 0x9e3779b9
    for (let i = 0; i < rgba.data.length; i += 4) {
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5
      rgba.data[i] = rng & 255
      rgba.data[i + 1] = rng >>> 8 & 255
      rgba.data[i + 2] = rng >>> 16 & 255
      rgba.data[i + 3] = 255
    }
    g.putImageData(rgba, 0, 0)
    const pic = document.createElement('img')
    pic.src = noise.toDataURL('image/png')
    pic.style.cssText = 'display:block;width:1px;height:1px'
    const root = document.createElement('div')
    root.style.cssText = 'width:32768px;height:2px;background:rgb(17,68,102);overflow:hidden'
    root.appendChild(pic)
    document.body.appendChild(root)
    await pic.decode()
    const opts = { cache: 'disabled', burst: false, compress: false, embedFonts: false }
    const before = await oldModule.snapdom(root, opts)
    const after = await newModule.snapdom(root, opts)
    if (before.toRaw() !== after.toRaw()) throw new Error('the candidate changed capture output')
    const rawBytes = before.toRaw().length
    if (rawBytes < 1e6) throw new Error('large image is not embedded; no test value')
    const first = decodeURIComponent(before.toRaw().slice(before.toRaw().indexOf(',') + 1))
    const head = first.match(/<svg\b[^>]*>/i)?.[0]
    const width = Number((head?.match(/\bwidth="([\d.]+)"/i) || [])[1])
    if (!(width > 32767)) throw new Error('SVG was not oversized: ' + width)
    const render = async (value, opts) => {
      const t = performance.now()
      const canvas = await value.toCanvas(opts)
      const ms = performance.now() - t
      const ctx = canvas.getContext('2d')
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let hash = 0x811c9dc5
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 0x01000193)
      return { ms, hash: hash >>> 0, width: canvas.width, height: canvas.height }
    }
    const baselineMs = [], candidateMs = []
    const options = { width: 256, height: 4, dpr: 1 }
    for (let i = 0; i < 9; i++) {
      const a = i % 2 ? await render(after, options) : await render(before, options)
      const b = i % 2 ? await render(before, options) : await render(after, options)
      if (a.hash !== b.hash || a.width !== b.width || a.height !== b.height) {
        throw new Error('baseline/candidate pixels or dimensions disagree')
      }
      if (i === 0) continue
      if (i % 2) { candidateMs.push(a.ms); baselineMs.push(b.ms) }
      else { baselineMs.push(a.ms); candidateMs.push(b.ms) }
    }
    // Cropping is deliberately left on the legacy path and must still match.
    const crop = { x: 0, y: 0, width: 256, height: 2 }
    const croppedBefore = await render(before, { crop, width: 256, height: 2, dpr: 1 })
    const croppedAfter = await render(after, { crop, width: 256, height: 2, dpr: 1 })
    if (croppedBefore.hash !== croppedAfter.hash ||
        croppedBefore.width !== croppedAfter.width ||
        croppedBefore.height !== croppedAfter.height) throw new Error('crop fallback pixels differ')
    root.remove()
    const median = arr => arr.slice().sort((a, b) => a-b)[arr.length >> 1]
    return { rawBytes, svgHeaderWidth: width, pixelsMatch: true, cropMatches: true,
      baselineMedianMs: median(baselineMs), candidateMedianMs: median(candidateMs),
      baselineSamplesMs: baselineMs, candidateSamplesMs: candidateMs }
  })
  console.log(JSON.stringify({ engine, ...result }))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}