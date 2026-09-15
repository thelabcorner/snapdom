#!/usr/bin/env node
// Does a retained CSSStyleDeclaration for a replaced <img> track intrinsic-load used-size changes?
// This is a semantic probe only; no performance timing.
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="red"/></svg>'
const PAGE = '<!doctype html><html><body></body></html>'
const server = http.createServer((req, res) => {
  if (req.url === '/slow.svg') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
      res.end(SVG)
    }, 120)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(origin)
      const out = await page.evaluate(async (src) => {
        const img = document.createElement('img')
        img.src = src
        document.body.appendChild(img)
        const held = getComputedStyle(img)
        const before = { width: held.width, height: held.height, length: held.length }
        await new Promise((resolve, reject) => {
          img.addEventListener('load', resolve, { once: true })
          img.addEventListener('error', reject, { once: true })
        })
        await new Promise(r => requestAnimationFrame(() => r()))
        const fresh = getComputedStyle(img)
        return {
          before,
          heldAfter: { width: held.width, height: held.height, length: held.length },
          freshAfter: { width: fresh.width, height: fresh.height, length: fresh.length },
          natural: [img.naturalWidth, img.naturalHeight],
        }
      }, `${origin}/slow.svg`)
      const same = out.heldAfter.width === out.freshAfter.width && out.heldAfter.height === out.freshAfter.height
      console.log(name, { ...out, heldMatchesFresh: same })
      await page.close()
    } finally { await browser.close() }
  }
} finally {
  await new Promise(r => server.close(r))
}
