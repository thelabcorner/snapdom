#!/usr/bin/env node
/**
 * Public GitHub-hosted-only browser proof for the R12 exact-output header fast path.
 * Measures ONLY isolated URL rewriting; the Vitest browser suite exercises the
 * integrated snapdom.toSvg({ scale }) API and decoded pixel color.
 */
import fs from 'node:fs'
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'

if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'thelabcorner/snapdom') {
  throw new Error('R12 browser measurements are public GitHub Actions only')
}
const engine = process.argv.find((a) => a.startsWith('--engine='))?.slice(9)
const browsers = { chromium, firefox, webkit }
if (!browsers[engine]) throw new Error('choose --engine=chromium|firefox|webkit')

const code = fs.readFileSync(new URL('../src/exporters/svgHeaderFast.js', import.meta.url))
const server = http.createServer((req, res) => {
  if (req.url === '/svgHeaderFast.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(code)
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>R12 exact SVG header test</title>')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await browsers[engine].launch({ headless: true })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  const evidence = await page.evaluate(async () => {
    const { scaleEncodedSvgHeader } = await import('/svgHeaderFast.js')
    const header = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32" viewBox="0 0 48 32">'
    const old = (url, scale) => {
      const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1))
      const tag = svg.match(/<svg\b[^>]*>/i)[0]
      const w = Number(tag.match(/\bwidth="([\d.]+)"/i)[1])
      const h = Number(tag.match(/\bheight="([\d.]+)"/i)[1])
      const next = tag.replace(/\bwidth="[^"]*"/i, `width="${Math.max(1, Math.round(w * scale))}"`)
        .replace(/\bheight="[^"]*"/i, `height="${Math.max(1, Math.round(h * scale))}"`)
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(tag, next))
    }
    const run = (fn, url) => {
      const t0 = performance.now()
      const output = fn(url, 2)
      return { ms: performance.now() - t0, output }
    }
    const median = (samples) => samples.slice().sort((a, b) => a - b)[samples.length >> 1]
    const result = []
    for (const payloadMiB of [1, 8]) {
      const payload = 'AbcdEFgh/+0123456789'.repeat(Math.ceil(payloadMiB * 1048576 / 20))
      const svg = header + '<metadata>' + payload + '</metadata>' +
        '<rect width="48" height="32" fill="rgb(17,68,102)"/></svg>'
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      const oldTimes = [], newTimes = []
      let exact = true
      // Alternate order to keep V8 warm-up and scheduling bias visible.
      for (let i = 0; i < 11; i++) {
        const a = i % 2 ? run(scaleEncodedSvgHeader, url) : run(old, url)
        const b = i % 2 ? run(old, url) : run(scaleEncodedSvgHeader, url)
        if (i % 2) { newTimes.push(a.ms); oldTimes.push(b.ms) }
        else { oldTimes.push(a.ms); newTimes.push(b.ms) }
        if (a.output !== b.output) exact = false
      }
      if (!exact) throw new Error('encoded SVG bytes differ at payload size ' + payloadMiB)
      result.push({ payloadMiB, exact, baselineMedianMs: median(oldTimes),
        candidateMedianMs: median(newTimes) })
    }

    // Independent pixel-equivalence oracle: both URLs decode and paint, and
    // they match byte-for-byte at every pixel, not only in SVG source.
    const input = 'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(header + '<rect width="48" height="32" fill="rgb(17,68,102)"/></svg>')
    const paths = [old(input, 2), scaleEncodedSvgHeader(input, 2)]
    const images = await Promise.all(paths.map(async (src) => {
      const img = new Image()
      img.src = src
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 96; canvas.height = 64
      canvas.getContext('2d').drawImage(img, 0, 0)
      return [...canvas.getContext('2d').getImageData(0, 0, 96, 64).data]
    }))
    const equalPixels = images[0].length === images[1].length &&
      images[0].every((v, i) => v === images[1][i])
    if (!equalPixels || images[0][3] !== 255) throw new Error('decoded pixels did not match')
    return { result, equalPixels }
  })
  console.log(JSON.stringify({ engine, ...evidence }))
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}