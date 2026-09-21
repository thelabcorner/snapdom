#!/usr/bin/env node
// R8-B1 region-B probe: offscreen shadow-icon census (src/core/prepare.js:99-130).
//
// Region B was the last UNMEASURED region in the R8 pipeline inventory. The census is gated on
// ALL of: the capture root being OFFSCREEN, an open shadow root whose host localName is
// `calcite-icon`, an `<svg>` inside it whose every `path` has an empty/absent `d`, and a
// non-zero box. The standing cards400/entropy-400 matrix never reaches it, which is why it was
// unmeasured. This probe uses a DEDICATED fixture (not added to the shared workload matrix).
//
// Measures, through the PUBLIC snapdom.toRaw pipeline: querySelectorAll count,
// getBoundingClientRect count, and wall time, with and without the icon subtree present, so the
// census cost is isolated from the rest of the capture.
//
// Measurement evidence only: no candidate, no promotion, no wall-time claim.
//
// Usage (from the R7 worktree root):
//   node lane6-scratch/r8/bench-shadow-icon-census.mjs --browser=chromium
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
const N = Number(arg('n', 12))
const WARM = Number(arg('warmup', 3))
const ICONS = Number(arg('icons', 40))

const cand = fs.readFileSync(path.join(ROOT, CAND_REL))
const sha = crypto.createHash('sha256').update(cand).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r8/results')
fs.mkdirSync(OUT, { recursive: true })

// The fixture deliberately mirrors the gate in prepare.js:99-130.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<script type="module">
class CalciteIcon extends HTMLElement {
  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<svg width="16" height="16"><path d=""></path></svg>'
  }
}
customElements.define('calcite-icon', CalciteIcon)

window.__sx = (() => {
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
  let current = null
  function build({ iconCount, offscreen }) {
    const wrap = document.createElement('div')
    wrap.style.cssText = offscreen
      ? 'position:fixed;left:-40000px;top:0;width:900px;'
      : 'position:fixed;left:0;top:0;width:900px;'
    const st = document.createElement('style')
    st.textContent = '.sx-row{padding:2px 4px;font:13px Arial}'
    document.head.appendChild(st)
    for (let i = 0; i < 200; i++) {
      const row = document.createElement('div'); row.className = 'sx-row'; row.textContent = 'row ' + i
      wrap.appendChild(row)
    }
    for (let i = 0; i < iconCount; i++) {
      const icon = document.createElement('calcite-icon')
      icon.style.cssText = 'display:inline-block;width:16px;height:16px;'
      wrap.appendChild(icon)
    }
    document.body.appendChild(wrap)
    return { wrap, cleanup() { wrap.remove(); st.remove() } }
  }
  return {
    install, counters,
    reset() { counters.getComputedStyle = 0; counters.getPropertyValue = 0; counters.getBoundingClientRect = 0; counters.querySelectorAll = 0 },
    async one(cfg, opts) {
      const made = build(cfg)
      try {
        window.__sx.reset()
        const t0 = performance.now()
        const raw = await window.__m.snapdom.toRaw(made.wrap, opts)
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

// onscreen is the protected control: the census must NOT run there (gate requires offscreen).
const CFGS = {
  'offscreen-icons': { iconCount: ICONS, offscreen: true },
  'offscreen-no-icons': { iconCount: 0, offscreen: true },
  'onscreen-icons-control': { iconCount: ICONS, offscreen: false },
}

const report = {
  probe: 'R8-B1 offscreen shadow-icon census',
  candidate: CAND_REL, sha256: sha, browser: ENGINE, n: N, warmup: WARM, icons: ICONS,
  gate: 'src/core/prepare.js:99-130 requires offscreen root + open shadow host localName=calcite-icon + svg with empty path d + non-zero box',
  method: 'public snapdom.toRaw; in-page native counters. Measurement evidence only; no promotion.',
  fixtures: {},
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error(`[${ENGINE}] PAGE ERROR`, e.message))
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  await page.evaluate(() => window.__sx.install())
  const opts = { scale: 1, dpr: 1, embedFonts: false, cache: 'disabled' }
  for (const [name, cfg] of Object.entries(CFGS)) {
    for (let i = 0; i < WARM; i++) await page.evaluate(({ cfg, opts }) => window.__sx.one(cfg, opts), { cfg, opts })
    const rows = []
    for (let i = 0; i < N; i++) rows.push(await page.evaluate(({ cfg, opts }) => window.__sx.one(cfg, opts), { cfg, opts }))
    const per = {
      getComputedStyle: median(rows.map((r) => r.counters.getComputedStyle)),
      getPropertyValue: median(rows.map((r) => r.counters.getPropertyValue)),
      getBoundingClientRect: median(rows.map((r) => r.counters.getBoundingClientRect)),
      querySelectorAll: median(rows.map((r) => r.counters.querySelectorAll)),
    }
    report.fixtures[name] = { cfg, wallMs: stats(rows.map((r) => r.ms)), bytes: rows[0].bytes, medianCounters: per, raw: rows }
    console.log(`[${ENGINE}] ${name}: median ${stats(rows.map((r) => r.ms)).median.toFixed(1)}ms CoV ${(stats(rows.map((r) => r.ms)).cov * 100).toFixed(1)}%  qSA=${per.querySelectorAll} gBCR=${per.getBoundingClientRect}`)
  }
  await page.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
  const outPath = path.join(OUT, `shadow-icon-census-${ENGINE}.json`)
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`artifact ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`)
}
