#!/usr/bin/env node
// Fresh-page SA6 image-style reuse oracle. Fully decoded data images, no background/pseudo/SVG-def
// side paths. Repeated self-determinism + historical/candidate equality, no timings.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs?"+Math.random());window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const tiny = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"%3E%3Crect width="2" height="2" fill="red"/%3E%3C/svg%3E'
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)

async function one(browser, reuse) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  try {
    await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
    return await page.evaluate(async ({ reuse, tiny }) => {
      const style = document.createElement('style')
      style.textContent = '.root{width:900px}.im{display:block;width:20px;height:10px;object-fit:cover}'
      document.head.appendChild(style)
      const root = document.createElement('div'); root.className = 'root'
      for (let i = 0; i < 200; i++) { const img = document.createElement('img'); img.className = 'im'; img.src = tiny; root.appendChild(img) }
      document.body.appendChild(root)
      try {
        await Promise.all([...root.querySelectorAll('img')].map(img => img.decode?.().catch(() => {}) || Promise.resolve()))
        await new Promise(r => requestAnimationFrame(() => r()))
        return await window.__m.snapdom.toRaw(root, {
          burst: false, cache: 'disabled', embedFonts: false,
          __svgDefsStyleReuse: false,
          __imageStyleReuse: reuse,
          __svgPaintStyleReuse: false,
        })
      } finally { root.remove(); style.remove() }
    }, { reuse, tiny })
  } finally { await page.close() }
}

try {
  for (const [name, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await launcher.launch({ headless: true })
    try {
      const h1 = await one(browser, false)
      const c1 = await one(browser, true)
      const c2 = await one(browser, true)
      const h2 = await one(browser, false)
      const result = {
        historicalSelf: h1 === h2,
        candidateSelf: c1 === c2,
        parity: h1 === c1 && h2 === c2,
        bytes: { h1: h1.length, h2: h2.length, c1: c1.length, c2: c2.length },
        hashes: { h1: hash(h1), h2: hash(h2), c1: hash(c1), c2: hash(c2) },
      }
      console.log(name, result)
      if (!result.historicalSelf || !result.candidateSelf || !result.parity) process.exitCode = 1
    } finally { await browser.close() }
  }
} finally {
  await new Promise(r => server.close(r))
}
