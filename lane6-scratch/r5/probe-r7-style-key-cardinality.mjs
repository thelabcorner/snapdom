#!/usr/bin/env node
// R7 diagnostic: compare generated-style cardinality against the style-key cache miss count.
// No timings are reported; this is a representation/cardinality probe only.

import fs from 'node:fs'
import http from 'node:http'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const REL = 'worktrees/snapdom-v3-r7-overlay-gutterfix/dist/snapdom.mjs'
const mod = fs.readFileSync(`${ROOT}/${REL}`)
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__snap=await import('/candidate.mjs');window.__ready=true</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/candidate.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(mod)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(html)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
  const out = await page.evaluate(async ({ opts }) => {
    const el = window.__fx.build('cards400-safe')
    try {
      const raw = await window.__snap.snapdom.toRaw(el, { ...opts, __styleShareSnapshotOverlay: true })
      const comma = raw.indexOf(',')
      const svg = comma >= 0 ? decodeURIComponent(raw.slice(comma + 1)) : raw
      const styleBlocks = [...svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
      const classAttrs = [...svg.matchAll(/class="([^"]*)"/g)].map((m) => m[1])
      const selectorCounts = new Map()
      for (const css of styleBlocks) {
        for (const m of css.matchAll(/\.([_a-zA-Z][\w-]*)\s*\{/g)) {
          selectorCounts.set(m[1], (selectorCounts.get(m[1]) || 0) + 1)
        }
      }
      const uses = new Map()
      for (const attr of classAttrs) {
        for (const token of attr.split(/\s+/)) {
          if (!selectorCounts.has(token)) continue
          uses.set(token, (uses.get(token) || 0) + 1)
        }
      }
      return {
        rawBytes: raw.length,
        svgBytes: svg.length,
        styleBlocks: styleBlocks.length,
        generatedClassDefinitions: selectorCounts.size,
        generatedClassUses: [...uses.values()].reduce((a, b) => a + b, 0),
        generatedClassesUsed: uses.size,
        reuseHistogram: [...uses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
        stylePreview: styleBlocks.map((x) => x.slice(0, 1000)).slice(0, 3),
        classPreview: classAttrs.slice(0, 30),
      }
    } finally {
      window.__fx.cleanup(el)
    }
  }, { opts: FIXTURE_OPTIONS })
  console.log(JSON.stringify(out, null, 2))
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}
