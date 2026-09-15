#!/usr/bin/env node
// R7 style-authority 2^4 deterministic factorial:
// L=lineClamp seed, C=content-visibility seed, P=parent-style reuse, B=backdrop-style reuse.
// Counter-only mechanism evidence; no wall-time claims.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(mod)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, args: ['--no-first-run', '--disable-extensions'] })
const fixtures = ['cards400-safe', 'cards400-neutral-unsafe', 'cards400-non-neutral', 'asset-heavy', 'entropy-400', 'cv-auto-200']

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  for (const fixture of fixtures) {
    const rows = []
    for (let mask = 0; mask < 16; mask++) {
      const line = !!(mask & 1)
      const cv = !!(mask & 2)
      const parent = !!(mask & 4)
      const backdrop = !!(mask & 8)
      rows.push(await page.evaluate(async ({ fixture, opts, line, cv, parent, backdrop, mask }) => {
        const native = window.getComputedStyle
        let gcs = 0
        window.getComputedStyle = function (...args) { gcs++; return native.apply(this, args) }
        let el, style = null
        if (fixture === 'entropy-400') {
          style = document.createElement('style')
          style.textContent = '.sa-root{width:900px;font:13px Arial}.sa-row{display:block;padding:2px 4px}.sa-row[data-i]{outline-offset:0}'
          document.head.appendChild(style)
          el = document.createElement('div'); el.className = 'sa-root'
          for (let i = 0; i < 400; i++) {
            const row = document.createElement('div'); row.className = 'sa-row'; row.dataset.i = String(i); row.textContent = 'row ' + i; el.appendChild(row)
          }
          document.body.appendChild(el)
        } else if (fixture === 'cv-auto-200') {
          style = document.createElement('style')
          style.textContent = '.cv-root{width:900px}.cv{content-visibility:auto;contain-intrinsic-size:40px;width:180px;height:40px;color:#123}'
          document.head.appendChild(style)
          el = document.createElement('div'); el.className = 'cv-root'
          for (let i = 0; i < 200; i++) {
            const row = document.createElement('div'); row.className = 'cv'; row.textContent = 'cv ' + i; el.appendChild(row)
          }
          document.body.appendChild(el)
        } else el = window.__fx.build(fixture)
        try {
          const raw = await window.__m.snapdom.toRaw(el, {
            ...opts,
            cache: 'disabled',
            embedFonts: false,
            __lineClampStyleSeed: line,
            __contentVisibilityStyleSeed: cv,
            __parentStyleReuse: parent,
            __backdropStyleReuse: backdrop,
          })
          return { mask, raw, gcs }
        } finally {
          window.getComputedStyle = native
          if (fixture === 'entropy-400' || fixture === 'cv-auto-200') { el.remove(); style?.remove() }
          else window.__fx.cleanup(el)
        }
      }, { fixture, opts: FIXTURE_OPTIONS, line, cv, parent, backdrop, mask }))
    }

    const base = rows[0]
    const parity = rows.every((r) => r.raw === base.raw)
    const full = rows[15]
    console.log(`\n${fixture} parity=${parity ? 'PASS' : 'FAIL'} base=${base.gcs} full=${full.gcs} saved=${base.gcs - full.gcs} (${(100 * (base.gcs - full.gcs) / base.gcs).toFixed(1)}%)`)
    // Print singletons, the two key pairs, and full composition; raw JSON remains unnecessary
    // because the deterministic counts can be reproduced from this exact bundle.
    for (const mask of [0, 1, 2, 4, 8, 3, 12, 15]) {
      const r = rows[mask]
      console.log(`  ${mask.toString(2).padStart(4, '0')} gCS=${String(r.gcs).padStart(6)} saved=${String(base.gcs - r.gcs).padStart(5)}`)
    }
    if (!parity) process.exitCode = 1
  }
  await page.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}
