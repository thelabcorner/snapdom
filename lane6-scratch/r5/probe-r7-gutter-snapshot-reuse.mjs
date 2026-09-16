#!/usr/bin/env node
// R7 gutter-read CSE scout. No wall-time claims and no behavior changes.
//
// Builds the exact current SO1 source with counter-only instrumentation inside
// addScrollbarGutter(). Every live CSSOM read the production function performs is classified as
// `snapshotHit` when the already-materialized style snapshot contains that exact property, else
// `snapshotMiss`. A hit is therefore a read a future implementation could replace with the
// snapshot value without inference; misses remain on the historical browser-oracle path.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const CAND = path.join(ROOT, 'worktrees/snapdom-v3-r7-overlay-gutterfix')

const plugin = {
  name: 'r7-gutter-snapshot-reuse-probe',
  setup(b) {
    b.onLoad({ filter: /src[\\/]modules[\\/]styles\.js$/ }, async (args) => {
      let s = fs.readFileSync(args.path, 'utf8')
      const needle = "export function addScrollbarGutter(source, pre, snap) {\n"
      if (!s.includes(needle)) throw new Error('addScrollbarGutter signature drifted')
      s = s.replace(needle, needle +
        "  const __gp = globalThis.__r7GutterReuseProbe\n" +
        "  if (__gp) __gp.calls++\n" +
        "  const __gread = (prop) => {\n" +
        "    if (__gp) { const bucket = prop in snap ? 'snapshotHit' : 'snapshotMiss'; __gp[bucket]++; __gp.props[prop][bucket]++ }\n" +
        "    return pre.getPropertyValue(prop)\n" +
        "  }\n")
      s = s.replace("  const ox = pre.getPropertyValue('overflow-x')\n  const oy = pre.getPropertyValue('overflow-y')",
        "  const ox = __gread('overflow-x')\n  const oy = __gread('overflow-y')")
      s = s.replace("  if (pre.getPropertyValue('box-sizing') === 'border-box') return 0",
        "  if (__gread('box-sizing') === 'border-box') return 0")
      s = s.replace("    px(pre.getPropertyValue('border-left-width')) - px(pre.getPropertyValue('border-right-width'))",
        "    px(__gread('border-left-width')) - px(__gread('border-right-width'))")
      s = s.replace("    px(pre.getPropertyValue('border-top-width')) - px(pre.getPropertyValue('border-bottom-width'))",
        "    px(__gread('border-top-width')) - px(__gread('border-bottom-width'))")
      return { contents: s, loader: 'js' }
    })
  },
}

const built = await build({
  entryPoints: [path.join(CAND, 'src/index.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  minify: false,
  plugins: [plugin],
  logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise((resolve) => server.listen(43992, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true, args: ['--no-first-run', '--disable-extensions'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
const FIXTURES = ['light-20cards', 'cards400-safe', 'cards400-neutral-unsafe', 'cards400-non-neutral', 'asset-heavy']
const PROPS = ['overflow-x','overflow-y','box-sizing','border-left-width','border-right-width','border-top-width','border-bottom-width']

try {
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  for (const fixture of FIXTURES) {
    const result = await page.evaluate(async ({ fixture, options, props }) => {
      const mk = () => ({ snapshotHit: 0, snapshotMiss: 0 })
      globalThis.__r7GutterReuseProbe = {
        calls: 0, snapshotHit: 0, snapshotMiss: 0,
        props: Object.fromEntries(props.map((p) => [p, mk()])),
      }
      const el = window.__fx.build(fixture)
      try {
        const raw = await window.__m.snapdom.toRaw(el, options)
        return { rawBytes: raw.length, ...globalThis.__r7GutterReuseProbe }
      } finally {
        window.__fx.cleanup(el)
        delete globalThis.__r7GutterReuseProbe
      }
    }, { fixture, options: FIXTURE_OPTIONS, props: PROPS })
    const total = result.snapshotHit + result.snapshotMiss
    const pct = total ? 100 * result.snapshotHit / total : 0
    console.log(`\n${fixture}: calls=${result.calls} gutter-gPV=${total} snapshot-hit=${result.snapshotHit} (${pct.toFixed(1)}%) miss=${result.snapshotMiss}`)
    for (const prop of PROPS) {
      const x = result.props[prop]
      if (x.snapshotHit || x.snapshotMiss) console.log(`  ${prop.padEnd(20)} hit=${String(x.snapshotHit).padStart(5)} miss=${String(x.snapshotMiss).padStart(5)}`)
    }
  }
} finally {
  await page.close(); await browser.close(); await new Promise((resolve) => server.close(resolve))
}
