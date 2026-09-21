#!/usr/bin/env node
// R8-G1 region-G probe: compress census cost (src/modules/compress.js:620-669 and 553-584).
//
// Region G was the last UNMEASURED item in the R8 pipeline inventory. Specifically the
// compress census was never instrumented:
//   compress.js:624  const candidates = [clone, ...clone.querySelectorAll('*')]
//   compress.js:625-628  filter on el.style.backgroundImage containing 'data:image'
//   compress.js:635  getComputedStyle(orig) per surviving candidate
//   compress.js:555-558  the #461 root-is-img guard (root that IS the <img>)
//
// This probe drives the PUBLIC snapdom.toRaw pipeline with compress enabled, on a deterministic
// all-data-URL fixture, and counts qSA / gCS / gBCR / getPropertyValue. Three configurations
// isolate the two censuses from the rest of the capture:
//   - compress-on   : full path, both censuses run
//   - compress-off  : protected control, neither census runs
//   - compress-on-root-is-img : exercises the #461 guard (capture root IS the <img>)
//
// Measurement evidence only: no candidate enabled, no promotion, no wall-time claim.
//
// Usage (from the R7 worktree root):
//   node lane6-scratch/r8/bench-compress-census.mjs --browser=chromium
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'

const ROOT = process.cwd()
const arg = (name, fallback) => {
  const p = `--${name}=`
  const x = process.argv.find((v) => v.startsWith(p))
  return x ? x.slice(p.length) : fallback
}
const CAND_REL = arg('candidate', 'dist/snapdom.mjs')
const ENGINE = arg('browser', 'chromium').toLowerCase()
const N = Number(arg('n', 10))
const WARM = Number(arg('warmup', 3))
const CARDS = Number(arg('cards', 120))

const cand = fs.readFileSync(path.join(ROOT, CAND_REL))
const sha = crypto.createHash('sha256').update(cand).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r8/results')
fs.mkdirSync(OUT, { recursive: true })

// Deterministic, network-free fixture: every asset is an inline data URL, so the probe never
// depends on decoding timing or the network. The background is box-relative (100% 100%) so the
// compress pass actually has eligible candidates rather than bailing on `auto`.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<script type="module">
// 8x8 opaque PNG as a data URL, generated once so the bytes are stable across runs.
function png8() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8
  const g = c.getContext('2d')
  g.fillStyle = '#3b82f6'; g.fillRect(0, 0, 8, 8)
  g.fillStyle = '#ef4444'; g.fillRect(0, 0, 4, 4)
  return c.toDataURL('image/png')
}
const DATA_URL = png8()

window.__cz = (() => {
  const counters = { getComputedStyle: 0, getPropertyValue: 0, getBoundingClientRect: 0, querySelectorAll: 0 }
  let installed = false
  function install() {
    if (installed) return
    installed = true
    const gcs = window.getComputedStyle
    window.getComputedStyle = function (...a) { counters.getComputedStyle++; return gcs.apply(this, a) }
    const gpv = CSSStyleDeclaration.prototype.getPropertyValue
    CSSStyleDeclaration.prototype.getPropertyValue = function (...a) { counters.getPropertyValue++; return gpv.apply(this, a) }
    const gbcr = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (...a) { counters.getBoundingClientRect++; return gbcr.apply(this, a) }
    const qsa = Element.prototype.querySelectorAll
    Element.prototype.querySelectorAll = function (...a) { counters.querySelectorAll++; return qsa.apply(this, a) }
  }
  function build({ cards, rootIsImg }) {
    const st = document.createElement('style')
    st.textContent = '.cz-root{width:900px;font:13px Arial}.cz-card{width:60px;height:40px;background-image:url(' + DATA_URL + ');background-size:100% 100%;background-repeat:no-repeat;display:inline-block}'
    document.head.appendChild(st)
    if (rootIsImg) {
      const img = document.createElement('img')
      img.src = DATA_URL
      img.style.cssText = 'width:60px;height:40px;display:block'
      document.body.appendChild(img)
      return { root: img, cleanup() { img.remove(); st.remove() } }
    }
    const root = document.createElement('div'); root.className = 'cz-root'
    for (let i = 0; i < cards; i++) {
      const card = document.createElement('div'); card.className = 'cz-card'
      root.appendChild(card)
    }
    document.body.appendChild(root)
    return { root, cleanup() { root.remove(); st.remove() } }
  }
  return {
    install, counters, dataUrl: DATA_URL,
    reset() { counters.getComputedStyle = 0; counters.getPropertyValue = 0; counters.getBoundingClientRect = 0; counters.querySelectorAll = 0 },
    async one(cfg, opts) {
      const made = build(cfg)
      try {
        window.__cz.reset()
        const t0 = performance.now()
        const raw = await window.__m.snapdom.toRaw(made.root, opts)
        return { ms: performance.now() - t0, bytes: raw.length, counters: { ...counters } }
      } finally { made.cleanup() }
    },
  }
})()
window.__m = await import('/cand.mjs')
window.__ready = true
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(PAGE); return }
  if (u.pathname.startsWith('/cand')) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(cand); return }
  res.writeHead(404); res.end('nf')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browserType = { chromium, firefox, webkit }[ENGINE]
if (!browserType) throw new Error(`unsupported --browser=${ENGINE}`)
const browser = await browserType.launch(ENGINE === 'chromium'
  ? { headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--disable-extensions'] }
  : { headless: true })

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const stats = (xs) => { const m = mean(xs); const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); return { mean: m, median: median(xs), min: Math.min(...xs), max: Math.max(...xs), cov: m ? sd / m : 0 } }

const BASE = { scale: 1, dpr: 1, embedFonts: false, cache: 'disabled' }
const CFGS = {
  'compress-on': { cfg: { cards: CARDS, rootIsImg: false }, opts: { ...BASE, compress: true } },
  'compress-off-control': { cfg: { cards: CARDS, rootIsImg: false }, opts: { ...BASE, compress: false } },
  'compress-root-is-img-461': { cfg: { cards: 0, rootIsImg: true }, opts: { ...BASE, compress: true } },
}

const report = {
  probe: 'R8-G1 compress census',
  candidate: CAND_REL, sha256: sha, browser: ENGINE, n: N, warmup: WARM, cards: CARDS,
  targets: ['compress.js:624 candidates materialization', 'compress.js:625-628 style.backgroundImage filter', 'compress.js:635 getComputedStyle(orig)', 'compress.js:555-558 root-is-img guard'],
  method: 'public snapdom.toRaw with compress on/off; in-page native counters. Measurement evidence only; no promotion.',
  fixtures: {},
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error(`[${ENGINE}] PAGE ERROR`, e.message))
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  await page.evaluate(() => window.__cz.install())
  for (const [name, { cfg, opts }] of Object.entries(CFGS)) {
    for (let i = 0; i < WARM; i++) await page.evaluate(({ cfg, opts }) => window.__cz.one(cfg, opts), { cfg, opts })
    const rows = []
    for (let i = 0; i < N; i++) rows.push(await page.evaluate(({ cfg, opts }) => window.__cz.one(cfg, opts), { cfg, opts }))
    const per = {
      getComputedStyle: median(rows.map((r) => r.counters.getComputedStyle)),
      getPropertyValue: median(rows.map((r) => r.counters.getPropertyValue)),
      getBoundingClientRect: median(rows.map((r) => r.counters.getBoundingClientRect)),
      querySelectorAll: median(rows.map((r) => r.counters.querySelectorAll)),
    }
    report.fixtures[name] = { cfg, opts, wallMs: stats(rows.map((r) => r.ms)), bytes: rows[0].bytes, medianCounters: per, raw: rows }
    console.log(`[${ENGINE}] ${name}: median ${stats(rows.map((r) => r.ms)).median.toFixed(1)}ms CoV ${(stats(rows.map((r) => r.ms)).cov * 100).toFixed(1)}%  qSA=${per.querySelectorAll} gCS=${per.getComputedStyle} gBCR=${per.getBoundingClientRect}`)
  }
  await page.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
  const outPath = path.join(OUT, `compress-census-${ENGINE}.json`)
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`artifact ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`)
}
