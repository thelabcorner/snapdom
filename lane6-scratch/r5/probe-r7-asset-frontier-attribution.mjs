#!/usr/bin/env node
// R7 post-389 asset-heavy residual attribution + BGSNAP1 audit.
// Fresh browser context per arm, same build, deterministic call counters only. NO wall claims.
import fs from 'node:fs'
import http from 'node:http'
import { build } from 'esbuild'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const built = await build({
  stdin: {
    contents: `export { snapdom } from './src/index.js'
export { snapshotFor, backgroundSnapshotFor, getStyleEnvEpoch } from './src/modules/styles.js'`,
    resolveDir: ROOT,
  },
  bundle: true, format: 'esm', platform: 'browser', write: false, minify: false, logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lxR3WQAAAABJRU5ErkJggg==', 'base64')
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
  if (req.url?.startsWith('/font/')) { setTimeout(() => { res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'no-store' }); res.end(Buffer.from('AA==', 'base64')) }, 12); return }
  if (req.url?.startsWith('/img/')) { setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(PNG_BYTES) }, 8); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const ARMS = {
  current: {},
  'no-maskdef': { __maskLayoutInitialDefaults: false },
  'no-bgsnap': { __backgroundFontEpochReuse: false },
  'no-sentinel': { __backgroundUrlSentinel: false },
  'no-basis': { __backgroundSourceBasis: false },
  'no-stategate': { __backgroundStateProbeGate: false },
  'no-defsreuse': { __svgDefsStyleReuse: false },
  'no-imagereuse': { __imageStyleReuse: false },
  'no-paintreuse': { __svgPaintStyleReuse: false },
}
const MASK_LAYOUT = ['mask-position', 'mask-size', 'mask-repeat', 'mask-mode', 'mask-composite', '-webkit-mask-position', '-webkit-mask-size', '-webkit-mask-repeat', '-webkit-mask-composite', 'mask-origin', 'mask-clip', '-webkit-mask-origin', '-webkit-mask-clip', '-webkit-mask-position-x', '-webkit-mask-position-y']

const engine = process.env.BROWSER || 'chromium'
const browser = await ({ chromium, firefox, webkit }[engine]).launch({ headless: true })

async function one(flags, token) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/?${token}`)
    await page.waitForFunction(() => window.__ready === true)
    return await page.evaluate(async ({ flags, opts, maskProps }) => {
      const maskSet = new Set(maskProps)
      const root = window.__fx.build('asset-heavy')
      const proto = CSSStyleDeclaration.prototype
      const gpvDesc = Object.getOwnPropertyDescriptor(proto, 'getPropertyValue')
      const spDesc = Object.getOwnPropertyDescriptor(proto, 'setProperty')
      const origGpv = proto.getPropertyValue, origSp = proto.setProperty
      const origGcs = window.getComputedStyle.bind(window)
      const origMatches = Element.prototype.matches
      const origRect = Element.prototype.getBoundingClientRect
      const rects = Element.prototype.getClientRects
      const offW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
      const offH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
      const imgProto = HTMLImageElement.prototype
      const imgGetters = ['currentSrc', 'naturalWidth', 'naturalHeight', 'complete', 'width', 'height']
      const imgDesc = Object.fromEntries(imgGetters.map((p) => [p, Object.getOwnPropertyDescriptor(imgProto, p)]))
      const c = {
        gpv: 0, gcs: 0, matches: 0, geometry: 0, setProperty: 0, img: 0,
        byCaller: { gpv: {}, gcs: {}, matches: {}, geometry: {}, setProperty: {}, img: {} },
        byProp: {},
      }
      const declIds = new WeakMap()
      let nextDecl = 0
      const maskByDecl = new Map()
      const site = (stack, skip) => {
        const lines = String(stack || '').split('\n').slice(skip)
        for (const line of lines) {
          const m = line.match(/at\s+(?:(?:async\s+)?([^\s(]+)\s+\()?(?:[^()]*?:)?(\d+):(\d+)\)?/)
          if (!m) continue
          const name = m[1] || 'anon'
          if (name === 'getPropertyValue' || name === 'CSSStyleDeclaration.value' || name === 'setProperty') continue
          return `${name}#${m[2]}`
        }
        return 'other'
      }
      const bump = (fam, key) => { const t = c.byCaller[fam]; t[key] = (t[key] || 0) + 1 }
      proto.getPropertyValue = function (prop) {
        c.gpv++; const p = String(prop)
        c.byProp[p] = (c.byProp[p] || 0) + 1
        bump('gpv', site(new Error().stack, 2))
        if (maskSet.has(p)) {
          let id = declIds.get(this)
          if (id === undefined) { id = ++nextDecl; declIds.set(this, id) }
          maskByDecl.set(id, (maskByDecl.get(id) || 0) + 1)
        }
        return origGpv.apply(this, arguments)
      }
      proto.setProperty = function () { c.setProperty++; bump('setProperty', site(new Error().stack, 2)); return origSp.apply(this, arguments) }
      window.getComputedStyle = function () { c.gcs++; bump('gcs', site(new Error().stack, 2)); return origGcs.apply(window, arguments) }
      Element.prototype.matches = function () { c.matches++; bump('matches', site(new Error().stack, 2)); return origMatches.apply(this, arguments) }
      Element.prototype.getBoundingClientRect = function () { c.geometry++; bump('geometry', site(new Error().stack, 2)); return origRect.apply(this, arguments) }
      Element.prototype.getClientRects = function () { c.geometry++; bump('geometry', site(new Error().stack, 2)); return rects.apply(this, arguments) }
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { ...offW, get() { c.geometry++; bump('geometry', site(new Error().stack, 2)); return offW.get.call(this) } })
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { ...offH, get() { c.geometry++; bump('geometry', site(new Error().stack, 2)); return offH.get.call(this) } })
      for (const p of imgGetters) {
        Object.defineProperty(imgProto, p, { ...imgDesc[p], get() { c.img++; bump('img', `${p}#${site(new Error().stack, 2)}`); return imgDesc[p].get.call(this) } })
      }
      let result
      try {
        const before = window.__m.getStyleEnvEpoch()
        // Deterministic font-only epoch move strictly after the style snapshot and before the
        // late background pass, so every arm exercises the BGSNAP1 overlay path on purpose
        // instead of racing real font delivery.
        const raw = await window.__m.snapdom.toRaw(root, {
          ...opts, cache: 'disabled', burst: false, embedFonts: false, ...flags,
          plugins: [{ name: 'frontier-font-epoch', afterClone() { document.fonts?.dispatchEvent?.(new Event('loadingdone')) } }],
        })
        const after = window.__m.getStyleEnvEpoch()
        const els = [...root.querySelectorAll('*')]
        const snapStats = { strict: 0, relaxed: 0, maskInSnap: 0, total: els.length }
        for (const el of els) {
          const s = window.__m.snapshotFor(el)
          const b = s || window.__m.backgroundSnapshotFor(el, flags.__backgroundFontEpochReuse !== false)
          if (s) snapStats.strict++
          if (b) snapStats.relaxed++
          if (b && 'mask-position' in b) snapStats.maskInSnap++
        }
        const maskHist = {}
        for (const n of maskByDecl.values()) maskHist[n] = (maskHist[n] || 0) + 1
        result = { rawBytes: raw.length, before, after, fontStatus: document.fonts?.status, snapStats, maskHist, ...c }
      } finally {
        proto.getPropertyValue = origGpv
        proto.setProperty = origSp
        window.getComputedStyle = origGcs
        Element.prototype.matches = origMatches
        Element.prototype.getBoundingClientRect = origRect
        Element.prototype.getClientRects = rects
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offW)
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offH)
        for (const p of imgGetters) Object.defineProperty(imgProto, p, imgDesc[p])
        window.__fx.cleanup(root)
      }
      return result
    }, { flags, opts: FIXTURE_OPTIONS, maskProps: MASK_LAYOUT })
  } finally { await page.close(); await context.close() }
}

const out = { engine, origin: null, arms: {} }
try {
  for (const [name, flags] of Object.entries(ARMS)) {
    const r = await one(flags, `${engine}-${name}-${Date.now()}`)
    out.arms[name] = r
    const top = (fam, n = 6) => Object.entries(r.byCaller[fam]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`\n[${engine}] arm=${name} raw=${r.rawBytes} epoch=${r.before}->${r.after} fonts=${r.fontStatus}`)
    console.log(`  gPV=${r.gpv} gCS=${r.gcs} matches=${r.matches} geom=${r.geometry} setProp=${r.setProperty} img=${r.img}`)
    console.log(`  snap=${JSON.stringify(r.snapStats)} maskHist=${JSON.stringify(r.maskHist)}`)
    console.log(`  gpv: ${top('gpv')}`)
    console.log(`  gcs: ${top('gcs')}`)
  }
  const cur = out.arms.current, hist = out.arms['no-bgsnap']
  console.log(`\n[${engine}] BGSNAP1 delta gPV=${hist.gpv - cur.gpv} gCS=${hist.gcs - cur.gcs} geom=${hist.geometry - cur.geometry} setProp=${hist.setProperty - cur.setProperty} raw=${cur.rawBytes === hist.rawBytes ? 'EQ' : 'DIFF'}`)
} finally {
  fs.mkdirSync('lane6-scratch/r5/results', { recursive: true })
  fs.writeFileSync(`lane6-scratch/r5/results/asset-frontier-attribution-${engine}.json`, JSON.stringify(out, null, 1))
  console.log(`\nsaved lane6-scratch/r5/results/asset-frontier-attribution-${engine}.json`)
  await browser.close()
  await new Promise((r) => server.close(r))
}
