#!/usr/bin/env node
// Deterministic pseudo counter-path admission probe. In-memory instrumentation only; no timings.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const CANDIDATE = path.join(ROOT, 'worktrees/snapdom-v3-r7-pseudo-overlay')
const plugin = {
  name: 'r7-pseudo-counter-path',
  setup(ctx) {
    ctx.onLoad({ filter: /src[\\/]modules[\\/]pseudo\.js$/ }, async (args) => {
      let s = fs.readFileSync(args.path, 'utf8')
      s = s.replace(
        'function withSiblingOverrides(node, base, siblingCounters) {',
        'function withSiblingOverrides(node, base, siblingCounters) {\n  if (globalThis.__counterProbe) globalThis.__counterProbe.siblingWrap++',
      )
      s = s.replace(
        'function deriveCounterCtxForPseudo(node, pseudoStyle, baseCtx) {',
        'function deriveCounterCtxForPseudo(node, pseudoStyle, baseCtx) {\n  if (globalThis.__counterProbe) globalThis.__counterProbe.derive++',
      )
      s = s.replace(
        '  const pairs = (value, dflt) => counterPairs(value, dflt).map(([name, num]) => ({ name, num }))',
        '  const pairs = (value, dflt) => { if (globalThis.__counterProbe) globalThis.__counterProbe.pairParse++; return counterPairs(value, dflt).map(([name, num]) => ({ name, num })) }',
      )
      return { contents: s, loader: 'js' }
    })
  },
}

const built = await build({
  entryPoints: [path.join(CANDIDATE, 'src/index.js')], bundle: true, format: 'esm',
  platform: 'browser', write: false, minify: false, plugins: [plugin], logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url === '/m.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(mod); return }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const SCENES = [
  ['literal', '.row::before{content:"["}.row::after{content:"]"}'],
  ['literal-increment', '.row::before{content:"[";counter-increment:item}.row::after{content:"]";counter-increment:item}'],
  ['counter-content', '.root{counter-reset:item}.row::before{counter-increment:item;content:counter(item) "."}.row::after{content:"/" counter(item)}'],
]

const browser = await chromium.launch({ headless: true })
try {
  for (const [name, pseudoCss] of SCENES) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } })
    try {
      await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
      const out = await page.evaluate(async ({ pseudoCss }) => {
        globalThis.__counterProbe = { siblingWrap: 0, derive: 0, pairParse: 0 }
        const style = document.createElement('style')
        style.textContent = `.root{width:900px;font:13px Arial}.row{display:block}${pseudoCss}`
        document.head.appendChild(style)
        const root = document.createElement('div'); root.className = 'root'
        for (let i = 0; i < 400; i++) {
          const el = document.createElement('div'); el.className = 'row'; el.textContent = 'row ' + i; root.appendChild(el)
        }
        document.body.appendChild(root)
        try {
          const raw = await window.__m.snapdom.toRaw(root, { burst: false, cache: 'disabled', embedFonts: false })
          return { ...globalThis.__counterProbe, rawBytes: raw.length }
        } finally { root.remove(); style.remove() }
      }, { pseudoCss })
      console.log(name, out)
    } finally { await page.close() }
  }
} finally {
  await browser.close(); await new Promise((r) => server.close(r))
}
