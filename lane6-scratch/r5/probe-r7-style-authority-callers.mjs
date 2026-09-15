#!/usr/bin/env node
// Residual getComputedStyle caller census after the full R7 style-authority composition.
// Attribution only; instrumentation is intentionally invasive and carries no timing meaning.
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const built = await build({
  entryPoints: [path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/src/index.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  minify: false,
  logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
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
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  for (const fixture of ['cards400-safe', 'asset-heavy']) {
    const rows = await page.evaluate(async ({ fixture, opts }) => {
      const native = window.getComputedStyle
      const counts = new Map()
      window.getComputedStyle = function (...args) {
        const chain = (new Error().stack || '').split('\n').slice(2, 10)
          .map((x) => x.trim().replace(/https?:\/\/[^/]+\/m\.mjs:\d+:\d+/, 'm.mjs')).join(' <- ')
        counts.set(chain, (counts.get(chain) || 0) + 1)
        return native.apply(this, args)
      }
      const el = window.__fx.build(fixture)
      try {
        await window.__m.snapdom.toRaw(el, {
          ...opts,
          cache: 'disabled',
          embedFonts: false,
          __lineClampStyleSeed: true,
          __contentVisibilityStyleSeed: true,
          __parentStyleReuse: true,
          __backdropStyleReuse: true,
        })
      } finally {
        window.__fx.cleanup(el)
        window.getComputedStyle = native
      }
      return [...counts].map(([chain, count]) => ({ chain, count })).sort((a, b) => b.count - a.count).slice(0, 30)
    }, { fixture, opts: FIXTURE_OPTIONS })
    console.log(`\n${fixture}`)
    for (const row of rows) console.log(String(row.count).padStart(6), row.chain)
  }
  await page.close()
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}
