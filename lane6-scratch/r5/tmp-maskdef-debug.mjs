#!/usr/bin/env node
// Debug why R7-MASKDEF1 folding does not engage on asset-heavy. Deterministic, chromium only.
import http from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const built = await build({
  stdin: {
    contents: `export { snapdom } from './src/index.js'
export { snapshotFor, backgroundSnapshotFor, maskLayoutInitialValues } from './src/modules/styles.js'
export { needsBackgroundInline } from './src/modules/styles.js'`,
    resolveDir: ROOT,
  },
  bundle: true, format: 'esm', platform: 'browser', write: false, minify: false, logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
  if (req.url?.startsWith('/font/')) { res.writeHead(200, { 'content-type': 'font/ttf' }); res.end(Buffer.from('AA==', 'base64')); return }
  if (req.url?.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lxR3WQAAAABJRU5ErkJggg==', 'base64')); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 } })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  const out = await page.evaluate(async ({ opts }) => {
    const root = window.__fx.build('asset-heavy')
    const maskProps = ['mask-position', 'mask-size', 'mask-repeat', 'mask-mode', 'mask-composite', '-webkit-mask-position', '-webkit-mask-size', '-webkit-mask-repeat', '-webkit-mask-composite', 'mask-origin', 'mask-clip', '-webkit-mask-origin', '-webkit-mask-clip', '-webkit-mask-position-x', '-webkit-mask-position-y']
    const maskSet = new Set(maskProps)
    const proto = CSSStyleDeclaration.prototype
    const d = Object.getOwnPropertyDescriptor(proto, 'getPropertyValue')
    const orig = proto.getPropertyValue
    const perDecl = new Map()
    const declIds = new WeakMap()
    let nextId = 0
    proto.getPropertyValue = function (prop) {
      if (maskSet.has(String(prop))) {
        let id = declIds.get(this); if (id === undefined) { id = ++nextId; declIds.set(this, id) }
        perDecl.set(id, (perDecl.get(id) || 0) + 1)
      }
      return orig.apply(this, arguments)
    }
    let raw
    try {
      raw = await window.__m.snapdom.toRaw(root, {
        ...opts, cache: 'disabled', burst: false, embedFonts: false,
        plugins: [{ name: 'dbg', afterClone() { document.fonts?.dispatchEvent?.(new Event('loadingdone')) } }],
      })
    } finally { proto.getPropertyValue = orig }
    const els = [...root.querySelectorAll('*')]
    const rows = []
    const hist = new Map()
    for (const el of els) {
      const tag = el.localName
      const need = window.__m.needsBackgroundInline(el)
      const strict = !!window.__m.snapshotFor(el)
      const relaxed = !!window.__m.backgroundSnapshotFor(el, true)
      const fold = window.__m.maskLayoutInitialValues(el)
      const key = `${tag}|need=${need}|strict=${strict}|relaxed=${relaxed}|fold=${fold ? 'map' : 'null'}`
      hist.set(key, (hist.get(key) || 0) + 1)
      if (rows.length < 8) rows.push(`${tag} need=${need} strict=${strict} relaxed=${relaxed} fold=${fold ? 'map(' + fold.size + ')' : 'null'}`)
    }
    const maskHist = {}
    for (const n of perDecl.values()) maskHist[n] = (maskHist[n] || 0) + 1
    return { rawBytes: raw.length, totalEls: els.length, groups: [...hist], sample: rows, maskHist }
  }, { opts: FIXTURE_OPTIONS })
  console.log(JSON.stringify(out, null, 1))
} finally {
  await browser.close()
  await new Promise((r) => server.close(r))
}
