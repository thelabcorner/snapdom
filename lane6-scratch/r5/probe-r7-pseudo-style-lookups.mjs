#!/usr/bin/env node
// Deterministic pseudo host/pseudo style lookup topology probe.
// Candidate source is instrumented in-memory only; no timings are reported.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const CANDIDATE = path.join(ROOT, 'worktrees/snapdom-v3-r7-pseudo-overlay')

const plugin = {
  name: 'r7-pseudo-style-lookups',
  setup(ctx) {
    ctx.onLoad({ filter: /src[\\/]modules[\\/]pseudo\.js$/ }, async (args) => {
      let s = fs.readFileSync(args.path, 'utf8')
      s = s.replace(
        '      const style = getStyle(source, pseudo)',
        '      if (globalThis.__lookupProbe) globalThis.__lookupProbe.mainPseudo++\n      const style = getStyle(source, pseudo)',
      )
      s = s.replace(
        '  resolvePseudoContentAndIncs(source, pseudo, counterCtx, sessionCache.__siblingCounters, style)',
        '  (globalThis.__lookupProbe && globalThis.__lookupProbe.resolverPseudo++, resolvePseudoContentAndIncs(source, pseudo, counterCtx, sessionCache.__siblingCounters, style))',
      )
      s = s.replace(
        '        const host = hostStyle ||= getStyle(source)',
        '        if (globalThis.__lookupProbe) globalThis.__lookupProbe.nowrapHost++\n        const host = hostStyle ||= getStyle(source)',
      )
      s = s.replace(
        "      const hostDisplay = ((hostStyle ||= getStyle(source)).display || '').toLowerCase()",
        "      if (globalThis.__lookupProbe) globalThis.__lookupProbe.displayHost++\n      const hostDisplay = ((hostStyle ||= getStyle(source)).display || '').toLowerCase()",
      )
      return { contents: s, loader: 'js' }
    })
    ctx.onLoad({ filter: /src[\\/]utils[\\/]css\.js$/ }, async (args) => {
      let s = fs.readFileSync(args.path, 'utf8')
      s = s.replace(
        'export function getStyle(el, pseudo = null) {',
        `export function getStyle(el, pseudo = null) {
  if (globalThis.__lookupProbe) {
    const p = globalThis.__lookupProbe
    if (pseudo) p.getStylePseudo++
    else p.getStyleHost++
  }`,
      )
      s = s.replace(
        '  if (!style) {\n    const win = getWindowForElement(el)',
        `  if (!style) {
    if (globalThis.__lookupProbe) {
      const p = globalThis.__lookupProbe
      if (pseudo) p.nativePseudo++
      else p.nativeHost++
    }
    const win = getWindowForElement(el)`,
      )
      return { contents: s, loader: 'js' }
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
const mod = built.outputFiles[0].contents
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url === '/m.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(mod)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
try {
  for (const [name, before, after] of [
    ['single-char', '[', ']'],
    ['multi-char', ' BEFORE ', ' AFTER '],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
    try {
      await page.goto(origin)
      await page.waitForFunction(() => window.__ready === true)
      const out = await page.evaluate(async ({ before, after }) => {
        globalThis.__lookupProbe = {
          mainPseudo: 0,
          resolverPseudo: 0,
          nowrapHost: 0,
          displayHost: 0,
          getStylePseudo: 0,
          getStyleHost: 0,
          nativePseudo: 0,
          nativeHost: 0,
        }
        const style = document.createElement('style')
        style.textContent = `.root{width:900px;font:13px/18px Arial,sans-serif}.row{display:block}.row::before{content:${JSON.stringify(before)};color:#64748b}.row::after{content:${JSON.stringify(after)};color:#94a3b8}`
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
          await window.__m.snapdom.toRaw(root, { burst: false, cache: 'disabled', embedFonts: false })
          return { ...globalThis.__lookupProbe }
        } finally {
          root.remove()
          style.remove()
        }
      }, { before, after })
      console.log(name, out)
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}
