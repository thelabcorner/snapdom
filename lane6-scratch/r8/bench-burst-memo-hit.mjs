#!/usr/bin/env node
// R8-J1 burst memo-hit probe.
//
// Hypothesis to FALSIFY: the burst memo-hit path is already bounded (per R7-BSAFE1, memo hits
// showed 1202->0 style reads; R7-BSAFE2, 1->0 qSA). If true, region J is an explicit stop.
//
// Method: repeated `snapdom.toRaw(el, { burst: true })` on one UNCHANGED 400-card subtree in one
// page. Capture 1 is the miss (full pipeline); captures 2..N should be memo serves. Per-call wall
// time plus per-call native counters, so a memo serve that still walks the tree is visible.
//
// Measurement evidence only. No candidate, no promotion, no wall-time claim.
//
// Usage (from the R7 worktree root):
//   node lane6-scratch/r8/bench-burst-memo-hit.mjs --browser=chromium
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
const HITS = Number(arg('hits', 20))
const FIXTURE = arg('fixture', 'cards400-safe')

const cand = fs.readFileSync(path.join(ROOT, CAND_REL))
const sha = crypto.createHash('sha256').update(cand).digest('hex').toUpperCase()
const OUT = path.join(ROOT, 'lane6-scratch/r8/results')
fs.mkdirSync(OUT, { recursive: true })

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script>
<script type="module">
window.__bh = (() => {
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
  let root = null
  return {
    install,
    counters,
    reset() { counters.getComputedStyle = 0; counters.getPropertyValue = 0; counters.getBoundingClientRect = 0; counters.querySelectorAll = 0 },
    mount(f) { root = window.__fx.build(f); return true },
    unmount() { if (root) { window.__fx.cleanup(root); root = null } },
    async call(opts) {
      window.__bh.reset()
      const t0 = performance.now()
      const raw = await window.__m.snapdom.toRaw(root, opts)
      return { ms: performance.now() - t0, bytes: raw.length, counters: { ...counters } }
    },
    async mutate() { root.children[0].children[0].textContent = 'mutated ' + Math.random(); return true },
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

const report = {
  probe: 'R8-J1 burst memo-hit',
  candidate: CAND_REL, sha256: sha, browser: ENGINE, fixture: FIXTURE, hits: HITS,
  method: 'one unchanged subtree, repeated snapdom.toRaw({burst:true}); capture 1 = miss, 2..N = memo. Measurement evidence only; no promotion.',
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error(`[${ENGINE}] PAGE ERROR`, e.message))
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
  await page.evaluate(() => window.__bh.install())
  await page.evaluate((f) => window.__bh.mount(f), FIXTURE)

  const opts = { ...FIXTURE_OPTIONS, burst: true }
  const miss = await page.evaluate((o) => window.__bh.call(o), opts)
  const hits = []
  for (let i = 0; i < HITS; i++) hits.push(await page.evaluate((o) => window.__bh.call(o), opts))

  // Control: after a real mutation the next call must be a fresh capture, not a stale memo.
  await page.evaluate(() => window.__bh.mutate())
  const afterMutation = await page.evaluate((o) => window.__bh.call(o), opts)

  report.results = {
    missFirst: { ms: miss.ms, bytes: miss.bytes, counters: miss.counters },
    memoHits: {
      count: hits.length,
      medianMs: median(hits.map((h) => h.ms)),
      minMs: Math.min(...hits.map((h) => h.ms)),
      maxMs: Math.max(...hits.map((h) => h.ms)),
      medianCounters: {
        getComputedStyle: median(hits.map((h) => h.counters.getComputedStyle)),
        getPropertyValue: median(hits.map((h) => h.counters.getPropertyValue)),
        getBoundingClientRect: median(hits.map((h) => h.counters.getBoundingClientRect)),
        querySelectorAll: median(hits.map((h) => h.counters.querySelectorAll)),
      },
      raw: hits,
    },
    afterMutation: { ms: afterMutation.ms, bytes: afterMutation.bytes, counters: afterMutation.counters },
  }

  console.log(`[${ENGINE}] ${FIXTURE} miss: ${miss.ms.toFixed(1)}ms gCS=${miss.counters.getComputedStyle} gPV=${miss.counters.getPropertyValue} qSA=${miss.counters.querySelectorAll}`)
  const mh = report.results.memoHits
  console.log(`[${ENGINE}] memo hits (n=${mh.count}): median ${mh.medianMs.toFixed(1)}ms  gCS=${mh.medianCounters.getComputedStyle} gPV=${mh.medianCounters.getPropertyValue} gBCR=${mh.medianCounters.getBoundingClientRect} qSA=${mh.medianCounters.querySelectorAll}`)
  console.log(`[${ENGINE}] after mutation: ${afterMutation.ms.toFixed(1)}ms gCS=${afterMutation.counters.getComputedStyle} (must be a fresh capture, not a memo)`)
  await page.evaluate(() => window.__bh.unmount())
  await page.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
  const outPath = path.join(OUT, `burst-memo-hit-${ENGINE}.json`)
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`artifact ${path.relative(ROOT, outPath).replaceAll('\\', '/')}`)
}
