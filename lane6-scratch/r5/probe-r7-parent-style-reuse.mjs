#!/usr/bin/env node
// R7-SA3 deterministic same-build counterfactual for exact parent-style reuse.
// Runs on top of SA1+SA2; counter-only mechanism evidence, no wall-time claims.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const REL = 'worktrees/snapdom-v3-r7-style-cache-handoff/dist/snapdom.mjs'
const mod = fs.readFileSync(path.join(ROOT, REL))
const sha = crypto.createHash('sha256').update(mod).digest('hex').toUpperCase()
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
const fixtures = ['light-20cards', 'cards400-safe', 'cards400-neutral-unsafe', 'cards400-non-neutral', 'asset-heavy', 'entropy-400']

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  for (const fixture of fixtures) {
    const run = async (reuse) => page.evaluate(async ({ fixture, opts, reuse }) => {
      const orig = window.getComputedStyle
      let gcs = 0
      window.getComputedStyle = function (...args) { gcs++; return orig.apply(this, args) }
      let el, style = null
      if (fixture === 'entropy-400') {
        style = document.createElement('style')
        style.textContent = '.sa-root{width:900px;font:13px Arial}.sa-row{display:block;padding:2px 4px}.sa-row[data-i]{outline-offset:0}'
        document.head.appendChild(style)
        el = document.createElement('div'); el.className = 'sa-root'
        for (let i = 0; i < 400; i++) {
          const r = document.createElement('div'); r.className = 'sa-row'; r.dataset.i = String(i); r.textContent = 'row ' + i; el.appendChild(r)
        }
        document.body.appendChild(el)
      } else {
        el = window.__fx.build(fixture)
      }
      try {
        const raw = await window.__m.snapdom.toRaw(el, {
          ...opts,
          cache: 'disabled',
          embedFonts: false,
          __lineClampStyleSeed: true,
          __contentVisibilityStyleSeed: true,
          __parentStyleReuse: reuse,
        })
        return { raw, gcs }
      } finally {
        if (fixture === 'entropy-400') { el.remove(); style?.remove() }
        else window.__fx.cleanup(el)
        window.getComputedStyle = orig
      }
    }, { fixture, opts: FIXTURE_OPTIONS, reuse })
    const historical = await run(false)
    const candidate = await run(true)
    const saved = historical.gcs - candidate.gcs
    const pct = historical.gcs ? 100 * saved / historical.gcs : 0
    const equal = historical.raw === candidate.raw
    console.log(`${fixture.padEnd(28)} parity=${equal ? 'PASS' : 'FAIL'} gCS ${historical.gcs} -> ${candidate.gcs} saved=${saved} (${pct.toFixed(1)}%)`)
    if (!equal) process.exitCode = 1
  }
  console.log(`bundle ${sha.slice(0, 12)} bytes=${mod.length}`)
  await page.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}
