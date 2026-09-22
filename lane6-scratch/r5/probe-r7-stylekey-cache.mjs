#!/usr/bin/env node
// Diagnostic-only in-memory instrumentation of the element snapshot-key cache.
// Candidate files on disk are untouched; no timings are reported.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const CANDIDATE = path.join(ROOT, 'worktrees/snapdom-v3-r7-overlay-gutterfix')

const plugin = {
  name: 'r7-stylekey-cache-probe',
  setup(ctx) {
    ctx.onLoad({ filter: /src[\\/]modules[\\/]styles\.js$/ }, async (args) => {
      let source = fs.readFileSync(args.path, 'utf8')
      source = source.replace(
        'let key = persist.snapshotKeyCache.get(sig)',
        `let key = persist.snapshotKeyCache.get(sig)
  if (globalThis.__r7Probe) {
    const p = globalThis.__r7Probe
    if (key === undefined) p.elementMiss++
    else p.elementHit++
    p.sigSeen.set(sig, (p.sigSeen.get(sig) || 0) + 1)
  }`,
      )
      return { contents: source, loader: 'js' }
    })
    ctx.onLoad({ filter: /src[\\/]utils[\\/]css\.js$/ }, async (args) => {
      let source = fs.readFileSync(args.path, 'utf8')
      source = source.replace(
        'export function getStyleKey(snapshot, tagName, sizedByContent = true, isFlexItem = false) {',
        `export function getStyleKey(snapshot, tagName, sizedByContent = true, isFlexItem = false) {
  if (globalThis.__r7Probe) {
    const p = globalThis.__r7Probe
    p.getStyleKey++
    const tag = String(tagName)
    p.tags[tag] = (p.tags[tag] || 0) + 1
  }`,
      )
      return { contents: source, loader: 'js' }
    })
  },
}

const built = await build({
  entryPoints: [path.join(CANDIDATE, 'src/index.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  minify: false,
  plugins: [plugin],
  logLevel: 'silent',
})
const moduleBytes = built.outputFiles[0].contents
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/m.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(moduleBytes)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
try {
  for (const overlay of [false, true]) {
    for (const fixture of ['simple-rows', 'cards400-safe']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
      try {
        await page.goto(origin)
        await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
        const out = await page.evaluate(async ({ overlay, fixture, fixtureOptions }) => {
          globalThis.__r7Probe = {
            elementMiss: 0,
            elementHit: 0,
            getStyleKey: 0,
            tags: {},
            sigSeen: new Map(),
          }

          let root
          let style
          if (fixture === 'cards400-safe') {
            root = window.__fx.build(fixture)
          } else {
            style = document.createElement('style')
            style.textContent = '.root{width:900px;font:13px Arial}.row{display:block;padding:2px 4px;color:#334155;background:#f8fafc}'
            document.head.appendChild(style)
            root = document.createElement('div')
            root.className = 'root'
            for (let i = 0; i < 400; i++) {
              const el = document.createElement('div')
              el.className = 'row g' + (i % 2)
              el.textContent = 'row ' + i
              root.appendChild(el)
            }
            document.body.appendChild(root)
          }

          try {
            await window.__m.snapdom.toRaw(root, {
              ...fixtureOptions,
              burst: false,
              __styleShareSnapshotOverlay: overlay,
            })
            const probe = globalThis.__r7Probe
            return {
              elementMiss: probe.elementMiss,
              elementHit: probe.elementHit,
              getStyleKey: probe.getStyleKey,
              tags: probe.tags,
              distinctInternalSigs: probe.sigSeen.size,
              sigFreq: [...probe.sigSeen.values()].sort((a, b) => b - a).slice(0, 12),
            }
          } finally {
            if (fixture === 'cards400-safe') window.__fx.cleanup(root)
            else {
              root.remove()
              style.remove()
            }
          }
        }, { overlay, fixture, fixtureOptions: FIXTURE_OPTIONS })
        console.log(`${overlay ? 'overlay' : 'historical'} ${fixture}`, out)
      } finally {
        await page.close()
      }
    }
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
