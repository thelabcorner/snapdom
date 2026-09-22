#!/usr/bin/env node
// Fresh-page asset-heavy parity for SA6. Each arm gets a new page; images are deterministic and
// decoded before capture. No timings.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const moduleBytes = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAQnX7sQAAAAASUVORK5CYII=', 'base64')
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs?'+Math.random());window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(moduleBytes); return }
  if (req.url === '/img/a.png' || req.url === '/img/b.png') { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(PNG); return }
  if (req.url === '/font/probe.ttf') { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('nf'); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

async function capture(engine, optimized) {
  const page = await engine.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  try {
    await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
    return await page.evaluate(async ({ optimized, opts }) => {
      const root = window.__fx.build('asset-heavy')
      try {
        await Promise.all([...root.querySelectorAll('img')].map(img => img.decode?.().catch(() => {}) || Promise.resolve()))
        await new Promise(r => requestAnimationFrame(() => r()))
        return await window.__m.snapdom.toRaw(root, {
          ...opts, cache: 'disabled', embedFonts: false,
          __svgDefsStyleReuse: optimized,
          __imageStyleReuse: optimized,
          __svgPaintStyleReuse: optimized,
        })
      } finally { window.__fx.cleanup(root) }
    }, { optimized, opts: FIXTURE_OPTIONS })
  } finally { await page.close() }
}

try {
  for (const [name, launcher] of Object.entries({ chromium, firefox, webkit })) {
    const engine = await launcher.launch({ headless: true })
    try {
      const h1 = await capture(engine, false)
      const c1 = await capture(engine, true)
      const c2 = await capture(engine, true)
      const h2 = await capture(engine, false)
      const selfH = h1 === h2
      const selfC = c1 === c2
      const parity = h1 === c1 && h2 === c2
      const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
      console.log(name, {
        historicalSelf: selfH, candidateSelf: selfC, parity,
        bytes: { h1: h1.length, h2: h2.length, c1: c1.length, c2: c2.length },
        hashes: { h1: hash(h1), h2: hash(h2), c1: hash(c1), c2: hash(c2) },
        h1eqc1: h1 === c1, h2eqc1: h2 === c1,
      })
      if (!selfH || !parity) {
        const dir = path.join(ROOT, 'lane6-scratch/r5/results/asset-fresh-debug')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, `${name}-h1.txt`), h1)
        fs.writeFileSync(path.join(dir, `${name}-h2.txt`), h2)
        fs.writeFileSync(path.join(dir, `${name}-c1.txt`), c1)
      }
      if (!selfH || !selfC || !parity) process.exitCode = 1
    } finally { await engine.close() }
  }
} finally {
  await new Promise(r => server.close(r))
}
