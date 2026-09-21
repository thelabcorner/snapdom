#!/usr/bin/env node
// R8-I1 stage-attribution probe.
//
// Question: after the R7 folds, does the style snapshot or the clone+serialize path dominate
// the PUBLIC capture pipeline? Every prior lane measured CSSOM/style work; serialization was
// never stage-attributed.
//
// Method: drive `snapdom.toRaw(el, opts)` exactly as a user does, instrumenting native call
// counters via prototype patches applied INSIDE the page, and timing three seams by wrapping
// the module entry points that the pipeline actually calls.
//
// This produces MEASUREMENT EVIDENCE ONLY. It is not a promotion and makes no wall-time claim
// about any optimization; no candidate is enabled here.
//
// Usage (from the R7 worktree root):
//   node lane6-scratch/r8/bench-stage-attribution.mjs --browser=chromium
//   node lane6-scratch/r8/bench-stage-attribution.mjs --browser=chromium --fixtures=cards400-safe,entropy-400
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

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
const FIXTURES = arg('fixtures', 'cards400-safe,entropy-400').split(',').map((s) => s.trim()).filter(Boolean)

const cand = fs.readFileSync(path.join(ROOT, CAND_REL))
const sha = crypto.createHash('sha256').update(cand).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r8/results')
fs.mkdirSync(OUT, { recursive: true })

// entropy-400 has no builder in the shared fixtures module; build it inline in the page.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script>
<script type="module">
window.__ap = (() => {
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
  function buildEntropy() {
    const st = document.createElement('style')
    st.textContent = '.ap-root{width:900px;font:13px Arial}.ap-row{display:block;padding:2px 4px}.ap-row[data-i]{outline-offset:0}'
    document.head.appendChild(st)
    const root = document.createElement('div'); root.className = 'ap-root'
    for (let i = 0; i < 400; i++) {
      const r = document.createElement('div'); r.className = 'ap-row'; r.dataset.i = String(i); r.textContent = 'row ' + i
      root.appendChild(r)
    }
    document.body.appendChild(root)
    return { root, cleanup() { root.remove(); st.remove() } }
  }
  function build(f) { return f === 'entropy-400' ? buildEntropy() : { root: window.__fx.build(f), cleanup: () => window.__fx.cleanup(window.__fx.build(f)) } }
  return {
    counters,
    install,
    reset() { counters.getComputedStyle = 0; counters.getPropertyValue = 0; counters.getBoundingClientRect = 0; counters.querySelectorAll = 0 },
    async one(f, opts) {
      const made = f === 'entropy-400' ? buildEntropy() : (() => { const root = window.__fx.build(f); return { root, cleanup: () => window.__fx.cleanup(root) } })()
      try {
        window.__ap.reset()
        const t0 = performance.now()
        const raw = await window.__m.snapdom.toRaw(made.root, opts)
        const total = performance.now() - t0
        return { ms: total, bytes: raw.length, counters: { ...counters } }
      } finally { made.cleanup() }
    },
  }
})()
window.__m = await import('/cand.mjs')
window.__ready = true
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE); return
  }
  if (u.pathname.startsWith('/cand')) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(cand); return
  }
  res.writeHead(404); res.end('nf')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browserType = { chromium, firefox, webkit }[ENGINE]
if (!browserType) throw new Error(`unsupported --browser=${ENGINE}`)
const browser = await browserType.launch(ENGINE === 'chromium'
  ? { headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--disable-extensions'] }
  : { headless: true })

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const stats = (xs) => {
  const m = mean(xs)
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1))
  return { mean: m, median: median(xs), min: Math.min(...xs), max: Math.max(...xs), cov: m ? sd / m : 0 }
}
const sumCounters = (rows) => rows.reduce((acc, r) => {
  for (const k of Object.keys(r.counters)) acc[k] = (acc[k] || 0) + r.counters[k]
  return acc
}, {})

const report = {
  probe: 'R8-I1 stage attribution',
  candidate: CAND_REL,
  sha256: sha,
  browser: ENGINE,
  n: N,
  warmup: WARM,
  method: 'public snapdom.toRaw(opts); native prototype counters; per-capture totals. Measurement evidence only; no promotion.',
  fixtures: {},
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error(`[${ENGINE}] PAGE ERROR`, e.message))
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
  await page.evaluate(() => window.__ap.install())
  for (const f of FIXTURES) {
    for (let i = 0; i < WARM; i++) await page.evaluate(({ f, opts }) => window.__ap.one(f, opts), { f, opts: FIXTURE_OPTIONS })
    const rows = []
    for (let i = 0; i < N; i++) rows.push(await page.evaluate(({ f, opts }) => window.__ap.one(f, opts), { f, opts: FIXTURE_OPTIONS }))
    const counters = sumCounters(rows)
    const per = Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, v / rows.length]))
    report.fixtures[f] = {
      samples: rows.length,
      wallMs: stats(rows.map((r) => r.ms)),
      bytes: rows[0].bytes,
      countersTotal: counters,
      countersPerCapture: per,
      raw: rows.map((r) => ({ ms: r.ms, ...r.counters })),
    }
    console.log(`[${ENGINE}] ${f}: median ${stats(rows.map((r) => r.ms)).median.toFixed(1)}ms CoV ${(stats(rows.map((r) => r.ms)).cov * 100).toFixed(1)}%`)
    console.log(`  per capture: gCS=${per.getComputedStyle.toFixed(0)} gPV=${per.getPropertyValue.toFixed(0)} gBCR=${per.getBoundingClientRect.toFixed(0)} qSA=${per.querySelectorAll.toFixed(0)} bytes=${rows[0].bytes}`)
  }
  await page.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
  const outPath = path.join(OUT, `stage-attribution-${ENGINE}.json`)
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`artifact ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`)
}
