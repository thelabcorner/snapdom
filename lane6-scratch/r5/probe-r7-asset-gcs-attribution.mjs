#!/usr/bin/env node
// Deterministic attribution of residual getComputedStyle acquisitions on the integrated R7 scout.
// No timings; groups by source caller, element tag/class and pseudo argument.
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const entry = path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/src/index.js')
const built = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', write: false, minify: false, logLevel: 'silent' })
const mod = built.outputFiles[0].contents
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
  const rows = await page.evaluate(async ({ opts }) => {
    const orig = window.getComputedStyle
    const counts = new Map()
    window.getComputedStyle = function (el, pseudo) {
      const stack = new Error().stack || ''
      let caller = 'other'
      if (stack.includes('collectHtmlReferences')) caller = 'svgDefs.collectHtmlReferences'
      else if (stack.includes('freezeImgSrcset')) caller = 'clone.freezeImgSrcset'
      else if (stack.includes('inlineAllStyles')) caller = 'styles.inlineAllStyles'
      else if (stack.includes('inlinePseudoElements')) caller = 'pseudo.inlinePseudoElements'
      else if (stack.includes('lineClampTree')) caller = 'lineClampTree'
      else if (stack.includes('deepClone')) caller = 'clone.deepClone'
      else if (stack.includes('emulateBackdropFilters')) caller = 'backdrop'
      const tag = el?.tagName || el?.nodeName || 'unknown'
      const cls = typeof el?.className === 'string' ? el.className : el?.className?.baseVal || ''
      const key = `${caller}|${pseudo || '<normal>'}|${tag}|${cls}`
      counts.set(key, (counts.get(key) || 0) + 1)
      return orig.call(this, el, pseudo)
    }
    const el = window.__fx.build('asset-heavy')
    try { await window.__m.snapdom.toRaw(el, { ...opts, cache: 'disabled', embedFonts: false }) }
    finally { window.__fx.cleanup(el); window.getComputedStyle = orig }
    return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
  }, { opts: FIXTURE_OPTIONS })
  for (const row of rows) console.log(String(row.count).padStart(5), row.key)
  await page.close()
} finally {
  await browser.close()
  await new Promise(r => server.close(r))
}
