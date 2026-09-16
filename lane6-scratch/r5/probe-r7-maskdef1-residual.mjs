#!/usr/bin/env node
// R7-MASKDEF1 residual adversarial certification.
// F1: memo seeded on node 1, a later same-tag node mutated afterClone before its late pass.
// F2: genuinely cross-origin unreadable stylesheet authoring mask-position (cssRules throws).
// Same-build arms, fresh page per arm, exact raw byte comparison, deterministic font-epoch bump.
import fs from 'node:fs'
import http from 'node:http'
import { build } from 'esbuild'
import { chromium, firefox, webkit } from 'playwright'

const built = await build({
  stdin: { contents: `export { snapdom } from './src/index.js'`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'browser', write: false, minify: false, logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const CSS_SERVER_BODY = '.probe[data-i="5"]{mask-position:13px 7px}'
const cssServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/css' })
  res.end(CSS_SERVER_BODY)
})
await new Promise((r) => cssServer.listen(0, '127.0.0.1', r))
const cssPort = cssServer.address().port

const FIXTURE_SRC = `
window.__build = () => {
  const st = document.createElement('style')
  st.textContent = '.root{width:900px}.probe{width:80px;height:30px;background:linear-gradient(red,blue);background-size:24px 12px}'
  document.head.appendChild(st)
  const root = document.createElement('div'); root.className = 'root'
  for (let i = 0; i < 6; i++) {
    const p = document.createElement('div'); p.className = 'probe'; p.dataset.i = String(i); p.textContent = 'p' + i
    root.appendChild(p)
  }
  document.body.appendChild(root)
  return root
}`.replaceAll('</script>', '<\\/script>')

function pageHtml(extraHead = '') {
  return `<!doctype html><html><head>${extraHead}</head><body><script>${FIXTURE_SRC}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
}

function makeServer(html) {
  const s = http.createServer((req, res) => {
    if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(mod); return }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(html)
  })
  return s
}

const MASK_PROPS = ['mask-position', 'mask-size', 'mask-repeat', 'mask-mode', 'mask-composite', '-webkit-mask-position', '-webkit-mask-size', '-webkit-mask-repeat', '-webkit-mask-composite', 'mask-origin', 'mask-clip', '-webkit-mask-origin', '-webkit-mask-clip', '-webkit-mask-position-x', '-webkit-mask-position-y']

const engine = process.env.BROWSER || 'chromium'
const browser = await ({ chromium, firefox, webkit }[engine]).launch({ headless: true })

async function arm(origin, mode, flags) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.__ready === true)
    if (mode === 'crossorigin') {
      await page.waitForFunction(() => [...document.styleSheets].some((s) => { try { return s.cssRules && s.cssRules.length } catch { return true } }))
      const blocked = await page.evaluate(() => {
        const link = document.querySelector('link[rel=stylesheet]')
        try { void link.sheet.cssRules; return false } catch { return true }
      })
      if (!blocked) throw new Error('cross-origin cssRules did not throw on this engine; fixture invalid')
    }
    return await page.evaluate(async ({ mode, flags, maskProps }) => {
      const set = new Set(maskProps)
      const root = window.__build()
      const proto = CSSStyleDeclaration.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'getPropertyValue')
      const orig = proto.getPropertyValue
      let maskReads = 0
      proto.getPropertyValue = function (prop) { if (set.has(String(prop))) maskReads++; return orig.apply(this, arguments) }
      try {
        const raw = await window.__m.snapdom.toRaw(root, {
          cache: 'disabled', burst: false, embedFonts: false, ...flags,
          plugins: [{
            name: 'residual',
            afterClone() {
              if (mode === 'late-mutation') root.children[5].style.maskPosition = '13px 7px'
              document.fonts?.dispatchEvent?.(new Event('loadingdone'))
            },
          }],
        })
        const lastMask = getComputedStyle(root.children[5]).getPropertyValue('mask-position')
        return { raw, maskReads, lastMask }
      } finally {
        proto.getPropertyValue = orig
        Object.defineProperty(proto, 'getPropertyValue', desc)
        root.remove()
      }
    }, { mode, flags, maskProps: MASK_PROPS })
  } finally { await page.close(); await context.close() }
}

const out = { engine, fixtures: {} }
const servers = {}
try {
  servers.base = makeServer(pageHtml())
  servers.crossorigin = makeServer(pageHtml(`<link rel="stylesheet" href="http://localhost:${cssPort}/x.css">`))
  for (const [name, s] of Object.entries(servers)) await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const origins = {
    'late-mutation': `http://127.0.0.1:${servers.base.address().port}`,
    crossorigin: `http://127.0.0.1:${servers.crossorigin.address().port}`,
  }
  for (const [mode, origin] of Object.entries(origins)) {
    const on = await arm(origin, mode, {})
    const off = await arm(origin, mode, { __maskLayoutInitialDefaults: false })
    const rec = { onReads: on.maskReads, offReads: off.maskReads, raw: on.raw === off.raw ? 'EQ' : 'DIFF', lastMask: on.lastMask }
    out.fixtures[mode] = rec
    console.log(`[${engine}] ${mode}: raw=${rec.raw} maskReads ON/OFF=${rec.onReads}/${rec.offReads} lastMask=${JSON.stringify(rec.lastMask)}`)
  }
} finally {
  fs.mkdirSync('lane6-scratch/r5/results', { recursive: true })
  fs.writeFileSync(`lane6-scratch/r5/results/maskdef1-residual-${engine}.json`, JSON.stringify(out, null, 1))
  for (const s of Object.values(servers)) await new Promise((r) => s.close(r))
  await new Promise((r) => cssServer.close(r))
  await browser.close()
}
