#!/usr/bin/env node
/**
 * Public-API crossover: R12 and R14 snapdom.toSvg({ scale: 2 }) on the
 * SAME image-rich capture in the SAME browser. Both exact pinned bundles are
 * compiled from separate checkouts; neither is patched at runtime.
 *
 * Never use these timings as a total capture speed claim: the timed boundary
 * is exported image generation after capture has completed.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('public-export browser measurements require GitHub Actions')
}
const engine = process.argv.find(a => a.startsWith('--engine='))?.slice(9)
const engines = { chromium, firefox, webkit }
if (!engines[engine]) throw new Error('expected --engine=chromium|firefox|webkit')
const root = process.cwd()
const bundles = {
  '/baseline.mjs': fs.readFileSync(path.join(root, '__r12_baseline/dist/snapdom.mjs')),
  '/candidate.mjs': fs.readFileSync(path.join(root, 'dist/snapdom.mjs')),
  '/safariHeaderFast.js': fs.readFileSync(path.join(root, 'src/exporters/safariHeaderFast.js')),
}
const server = http.createServer((req, res) => {
  if (bundles[req.url]) {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(bundles[req.url])
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>R14 Safari header A/B</title>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await engines[engine].launch({ headless: true })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  const result = await page.evaluate(async () => {
    const [{ snapdom: oldSnapdom }, { snapdom: newSnapdom }] = await Promise.all([
      import('/baseline.mjs'), import('/candidate.mjs'),
    ])
    const { definitelyNoEncodedSafariShadows } = await import('/safariHeaderFast.js')
    const canvas = document.createElement('canvas')
    canvas.width = 1024; canvas.height = 1024
    const ctx = canvas.getContext('2d')
    const frame = ctx.createImageData(1024, 1024)
    let x = 0x917aa6f3
    // Noncompressible 3-MiB PNG. Generate it before timing, once per engine.
    for (let p = 0; p < frame.data.length; p += 4) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5
      frame.data[p] = x & 255
      frame.data[p + 1] = (x >>> 8) & 255
      frame.data[p + 2] = (x >>> 16) & 255
      frame.data[p + 3] = 255
    }
    ctx.putImageData(frame, 0, 0)
    const png = canvas.toDataURL('image/png')
    const root = document.createElement('div')
    root.style.cssText = 'display:block;width:128px;height:128px'
    const img = document.createElement('img')
    img.src = png
    img.width = 128; img.height = 128
    img.style.cssText = 'width:128px;height:128px;object-fit:cover;display:block'
    root.appendChild(img)
    document.body.appendChild(root)
    await img.decode()
    const opts = { cache: 'disabled', burst: false, compress: false, embedFonts: false }
    // Do not interleave two capture pipelines against one live source DOM:
    // normalization/sandbox side effects could create a false A/B mismatch.
    const a = await oldSnapdom(root, opts)
    const b = await newSnapdom(root, opts)
    if (a.toRaw() !== b.toRaw()) throw new Error('baseline/candidate raw captures differ')
    const rawBytes = a.toRaw().length
    if (rawBytes < 2e6) throw new Error('capture is unexpectedly small; cannot exercise R14: ' + rawBytes)
    const shadowFree = definitelyNoEncodedSafariShadows(a.toRaw())
    if (!shadowFree) throw new Error('fixture does not enter the proven shadow-free Safari fast path')
    const sample = async (result) => {
      const start = performance.now()
      const output = await result.toSvg({ scale: 2 })
      const duration = performance.now() - start
      if (!output.complete || output.naturalWidth === 0 || output.naturalHeight === 0) {
        throw new Error('toSvg returned an undecoded image')
      }
      return { duration, url: output.src, w: output.naturalWidth, h: output.naturalHeight }
    }
    const baselineMs = [], candidateMs = []
    let parity = true
    for (let i = 0; i < 9; i++) {
      const left = i % 2 ? await sample(b) : await sample(a)
      const right = i % 2 ? await sample(a) : await sample(b)
      if (i === 0) continue // decode/cache warmup is not included in steady state
      if (i % 2) { candidateMs.push(left.duration); baselineMs.push(right.duration) }
      else { baselineMs.push(left.duration); candidateMs.push(right.duration) }
      if (left.url !== right.url || left.w !== right.w || left.h !== right.h) parity = false
    }
    if (!parity) throw new Error('public exporter output or dimensions differ')
    root.remove()
    const median = a => a.slice().sort((x,y) => x-y)[a.length >> 1]
    return { rawBytes, sourceImageBytes: png.length, parity, shadowFree,
      baselineMedianMs: median(baselineMs), candidateMedianMs: median(candidateMs),
      baselineSamplesMs: baselineMs, candidateSamplesMs: candidateMs }
  })
  console.log(JSON.stringify({ engine, ...result }))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}