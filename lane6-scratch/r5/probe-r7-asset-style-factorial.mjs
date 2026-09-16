#!/usr/bin/env node
// R7-SA6 deterministic 2^3 factorial: svg-def scan x image freeze x SVG paint style reuse.
// Counter-only mechanism evidence. No wall-time claims.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const engineName = (process.argv.find(x => x.startsWith('--engine='))?.slice(9) || 'chromium').toLowerCase()
const engine = { chromium, firefox, webkit }[engineName]
if (!engine) throw new Error(`unknown engine ${engineName}`)
const browser = await engine.launch({ headless: true })

function bits(n) { return { defs: !!(n & 1), image: !!(n & 2), svg: !!(n & 4) } }
async function measure(page, scene, mask) {
  const f = bits(mask)
  return page.evaluate(async ({ scene, f, opts }) => {
    let root, style = null, sprite = null
    const tiny = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"%3E%3Crect width="2" height="2" fill="red"/%3E%3C/svg%3E'
    if (scene === 'asset-heavy' || scene === 'cards400-safe') {
      root = window.__fx.build(scene)
    } else if (scene === 'image-heavy') {
      style = document.createElement('style'); style.textContent = '.im{display:block;width:20px;height:10px;object-fit:cover}'
      document.head.appendChild(style)
      root = document.createElement('div')
      for (let i = 0; i < 200; i++) { const x = document.createElement('img'); x.className = 'im'; x.src = tiny; root.appendChild(x) }
      document.body.appendChild(root)
    } else if (scene === 'svg-heavy') {
      root = document.createElement('div')
      let html = ''
      for (let i = 0; i < 200; i++) html += '<svg width="20" height="10"><rect width="20" height="10" fill="rgb(1,2,3)"/></svg>'
      root.innerHTML = html; document.body.appendChild(root)
    } else if (scene === 'defs-heavy') {
      sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      sprite.innerHTML = '<defs><filter id="sa6f"><feGaussianBlur stdDeviation="1"/></filter></defs>'
      document.body.appendChild(sprite)
      style = document.createElement('style'); style.textContent = '.df{display:block;filter:url(#sa6f)}'
      document.head.appendChild(style)
      root = document.createElement('div')
      for (let i = 0; i < 400; i++) { const x = document.createElement('div'); x.className = 'df'; x.textContent = 'row ' + i; root.appendChild(x) }
      document.body.appendChild(root)
    }
    const orig = window.getComputedStyle; let gcs = 0
    window.getComputedStyle = function (...args) { gcs++; return orig.apply(this, args) }
    try {
      const raw = await window.__m.snapdom.toRaw(root, {
        ...opts, cache: 'disabled', embedFonts: false,
        __svgDefsStyleReuse: f.defs,
        __imageStyleReuse: f.image,
        __svgPaintStyleReuse: f.svg,
      })
      return { raw, gcs }
    } finally {
      window.getComputedStyle = orig
      if (scene === 'asset-heavy' || scene === 'cards400-safe') window.__fx.cleanup(root)
      else root?.remove()
      style?.remove(); sprite?.remove()
    }
  }, { scene, f, opts: FIXTURE_OPTIONS })
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
  for (const scene of ['asset-heavy', 'cards400-safe', 'image-heavy', 'svg-heavy', 'defs-heavy']) {
    const rows = []
    for (let mask = 0; mask < 8; mask++) rows.push(await measure(page, scene, mask))
    const parity = rows.every(r => r.raw === rows[0].raw)
    console.log(`\n${scene} parity=${parity ? 'PASS' : 'FAIL'} base=${rows[0].gcs} full=${rows[7].gcs} saved=${rows[0].gcs - rows[7].gcs}`)
    for (let mask = 0; mask < 8; mask++) {
      const f = bits(mask)
      const equal = rows[mask].raw === rows[0].raw
      console.log(`  ${Number(f.defs)}${Number(f.image)}${Number(f.svg)} eq=${equal ? 'Y' : 'N'} gCS=${String(rows[mask].gcs).padStart(5)} saved=${String(rows[0].gcs - rows[mask].gcs).padStart(5)}`)
    }
    if (!parity) process.exitCode = 1
  }
  await page.close()
} finally {
  await browser.close()
  await new Promise(r => server.close(r))
}
