#!/usr/bin/env node
// Diagnose repeated selector-gate matches inside the ::before/::after/::first-letter loop.
// In-memory instrumentation only; no timings.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const CANDIDATE = path.join(ROOT, 'worktrees/snapdom-v3-r7-pseudo-overlay')
const plugin = {
  name: 'r7-pseudo-gate-cse',
  setup(ctx) {
    ctx.onLoad({ filter: /src[\\/]modules[\\/]pseudo\.js$/ }, async (args) => {
      let s = fs.readFileSync(args.path, 'utf8')
      s = s.replace(
        '      try { if (!source.matches(gate)) continue } catch { /* unparsable at match time → probe */ }',
        `      try {
        if (globalThis.__gateProbe) {
          const p = globalThis.__gateProbe
          p.calls++
          p.byGate[gate] = (p.byGate[gate] || 0) + 1
          if (p.prevGate === gate) p.adjacentDuplicate++
          p.prevGate = gate
        }
        if (!source.matches(gate)) continue
      } catch { /* unparsable at match time → probe */ }`,
      )
      // Reset the adjacency tracker once per source node, immediately before the fixed pseudo loop.
      s = s.replace(
        "  for (const pseudo of ['::before', '::after', '::first-letter']) {",
        "  if (globalThis.__gateProbe) globalThis.__gateProbe.prevGate = null\n  for (const pseudo of ['::before', '::after', '::first-letter']) {",
      )
      return { contents: s, loader: 'js' }
    })
  },
}

const built = await build({
  entryPoints: [path.join(CANDIDATE, 'src/index.js')], bundle: true, format: 'esm', platform: 'browser',
  write: false, minify: false, plugins: [plugin], logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url === '/m.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(mod); return }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const scenes = [
  ['same-gate', '.row::before{content:"["}.row::after{content:"]"}'],
  ['different-gates', '.row::before{content:"["}.row.hot::after{content:"]"}'],
  ['same-gate-plus-first-letter', '.row::before{content:"["}.row::after{content:"]"}.row::first-letter{color:red}'],
]
const browser = await chromium.launch({ headless: true })
try {
  for (const [name, css] of scenes) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } })
    try {
      await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
      const out = await page.evaluate(async ({ css }) => {
        globalThis.__gateProbe = { calls: 0, adjacentDuplicate: 0, byGate: {}, prevGate: null }
        const style = document.createElement('style'); style.textContent = `.root{width:900px}.row{display:block}${css}`; document.head.appendChild(style)
        const root = document.createElement('div'); root.className = 'root'
        for (let i = 0; i < 400; i++) {
          const el = document.createElement('div'); el.className = i % 2 ? 'row hot' : 'row'; el.textContent = 'row ' + i; root.appendChild(el)
        }
        document.body.appendChild(root)
        try {
          await window.__m.snapdom.toRaw(root, { burst: false, cache: 'disabled', embedFonts: false })
          const { prevGate, ...probe } = globalThis.__gateProbe
          return probe
        } finally { root.remove(); style.remove() }
      }, { css })
      console.log(name, out)
    } finally { await page.close() }
  }
} finally {
  await browser.close(); await new Promise((r) => server.close(r))
}
