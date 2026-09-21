#!/usr/bin/env node
// R7-P deterministic 2x2 mechanism probe. Candidate source is instrumented in-memory only.
// No timings: this measures pseudo snapshot copy volume, compact overlay shape, key-build calls,
// and exact raw parity for overlay x key-cache factorial cells.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const CANDIDATE = path.join(ROOT, 'worktrees/snapdom-v3-r7-pseudo-overlay')

const plugin = {
  name: 'r7-pseudo-factorial-probe',
  setup(ctx) {
    ctx.onLoad({ filter: /src[\\/]modules[\\/]styles\.js$/ }, async (args) => {
      let source = fs.readFileSync(args.path, 'utf8')
      source = source.replace(
        '  if (rec) {\n    const useOverlay = options?.__styleSharePseudoOverlay !== false',
        `  if (rec) {
    const useOverlay = options?.__styleSharePseudoOverlay !== false
    if (globalThis.__pseudoProbe) {
      const p = globalThis.__pseudoProbe
      p.hits++
      const props = Object.keys(rec.snap).length
      p.baseProps += props
      if (useOverlay) p.overlayHits++
      else p.copiedProps += props
    }`,
      )
      source = source.replace(
        '  const snap = snapshotComputedStyle(style, pseudoUniverseFor(source))\n  // By reference',
        `  const snap = snapshotComputedStyle(style, pseudoUniverseFor(source))
  if (globalThis.__pseudoProbe) {
    globalThis.__pseudoProbe.misses++
    globalThis.__pseudoProbe.freshProps += Object.keys(snap).length
  }
  // By reference`,
      )
      return { contents: source, loader: 'js' }
    })
    ctx.onLoad({ filter: /src[\\/]utils[\\/]css\.js$/ }, async (args) => {
      let source = fs.readFileSync(args.path, 'utf8')
      source = source.replace(
        'export function getStyleKey(snapshot, tagName, sizedByContent = true, isFlexItem = false) {',
        `export function getStyleKey(snapshot, tagName, sizedByContent = true, isFlexItem = false) {
  if (globalThis.__pseudoProbe && tagName === 'span') globalThis.__pseudoProbe.spanKeyBuilds++`,
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
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'

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
const cells = [
  { name: 'historical', overlay: false, keyCache: false },
  { name: 'overlay-only', overlay: true, keyCache: false },
  { name: 'key-cache-only', overlay: false, keyCache: true },
  { name: 'joint', overlay: true, keyCache: true },
]

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  const results = []
  for (const cell of cells) {
    const result = await page.evaluate(async (cell) => {
      globalThis.__pseudoProbe = {
        hits: 0,
        misses: 0,
        overlayHits: 0,
        copiedProps: 0,
        baseProps: 0,
        freshProps: 0,
        spanKeyBuilds: 0,
      }
      const style = document.createElement('style')
      style.textContent = `
        .root{width:900px;font:13px Arial,sans-serif}
        .row{display:block;color:#334155}
        .row::before{content:"[";display:inline-block;width:12px;color:#64748b}
        .row::after{content:"]";display:inline-block;width:8px;color:#94a3b8}
      `
      document.head.appendChild(style)
      const root = document.createElement('div')
      root.className = 'root'
      for (let i = 0; i < 400; i++) {
        const el = document.createElement('div')
        el.className = 'row'
        el.textContent = 'row ' + i
        root.appendChild(el)
      }
      document.body.appendChild(root)
      try {
        const raw = await window.__m.snapdom.toRaw(root, {
          burst: false,
          cache: 'disabled',
          embedFonts: false,
          __styleSharePseudoOverlay: cell.overlay,
          __styleSharePseudoKeyCache: cell.keyCache,
        })
        return { ...globalThis.__pseudoProbe, raw }
      } finally {
        root.remove()
        style.remove()
      }
    }, cell)
    results.push({ cell, ...result })
  }

  const reference = results[0].raw
  for (const row of results) {
    const avgBaseProps = row.hits ? row.baseProps / row.hits : 0
    const avgFreshProps = row.misses ? row.freshProps / row.misses : 0
    console.log(JSON.stringify({
      cell: row.cell.name,
      parity: row.raw === reference,
      hits: row.hits,
      misses: row.misses,
      overlayHits: row.overlayHits,
      copiedProps: row.copiedProps,
      avgBaseProps,
      avgFreshProps,
      spanKeyBuilds: row.spanKeyBuilds,
      rawBytes: row.raw.length,
    }))
  }

  const entropy = []
  for (const cell of [cells[0], cells[3]]) {
    const result = await page.evaluate(async (cell) => {
      globalThis.__pseudoProbe = {
        hits: 0,
        misses: 0,
        overlayHits: 0,
        copiedProps: 0,
        baseProps: 0,
        freshProps: 0,
        spanKeyBuilds: 0,
      }
      const style = document.createElement('style')
      style.textContent = `
        .root{width:900px;font:13px Arial,sans-serif}
        .row{display:block;color:#334155}
        .row::before{content:"[";display:inline-block;width:12px;color:#64748b}
        .row::after{content:"]";display:inline-block;width:8px;color:#94a3b8}
      `
      document.head.appendChild(style)
      const root = document.createElement('div')
      root.className = 'root'
      for (let i = 0; i < 400; i++) {
        const el = document.createElement('div')
        // Unique class => unique style-share identity even though author CSS ignores the suffix.
        el.className = 'row unique-' + i
        el.textContent = 'row ' + i
        root.appendChild(el)
      }
      document.body.appendChild(root)
      try {
        const raw = await window.__m.snapdom.toRaw(root, {
          burst: false,
          cache: 'disabled',
          embedFonts: false,
          __styleSharePseudoOverlay: cell.overlay,
          __styleSharePseudoKeyCache: cell.keyCache,
        })
        return { ...globalThis.__pseudoProbe, raw }
      } finally {
        root.remove()
        style.remove()
      }
    }, cell)
    entropy.push({ cell, ...result })
  }
  console.log(JSON.stringify({
    cell: 'high-entropy-control',
    parity: entropy[0].raw === entropy[1].raw,
    historical: {
      hits: entropy[0].hits,
      misses: entropy[0].misses,
      spanKeyBuilds: entropy[0].spanKeyBuilds,
    },
    joint: {
      hits: entropy[1].hits,
      misses: entropy[1].misses,
      spanKeyBuilds: entropy[1].spanKeyBuilds,
    },
  }))
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
