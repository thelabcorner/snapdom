#!/usr/bin/env node
// R7-MASKLAY1 same-build causal probe. Deterministic CSSOM call counts only; no wall claims.
import fs from 'node:fs'
import http from 'node:http'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const mod = fs.readFileSync('dist/snapdom.mjs')
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, {'content-type':'text/javascript','cache-control':'no-store'}); res.end(mod); return }
  res.writeHead(200, {'content-type':'text/html','cache-control':'no-store'}); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const engine = process.env.BROWSER || 'chromium'
const browser = await ({ chromium, firefox, webkit }[engine]).launch({ headless: true })
const maskLayout = new Set([
  'mask-position','mask-size','mask-repeat','mask-mode','mask-composite',
  '-webkit-mask-position','-webkit-mask-size','-webkit-mask-repeat','-webkit-mask-composite',
  'mask-origin','mask-clip','-webkit-mask-origin','-webkit-mask-clip',
  '-webkit-mask-position-x','-webkit-mask-position-y',
])
try {
  const page = await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1})
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.__ready)
  for (const fixture of ['light-20cards','cards400-safe','cards400-non-neutral','asset-heavy']) {
    const rows = []
    for (const gate of [false, true]) rows.push(await page.evaluate(async ({fixture,gate,opts,maskProps}) => {
      const set = new Set(maskProps)
      const root = window.__fx.build(fixture)
      const proto = CSSStyleDeclaration.prototype, original = proto.getPropertyValue
      let gpv = 0, maskReads = 0
      proto.getPropertyValue = function(prop) { gpv++; if (set.has(String(prop))) maskReads++; return original.apply(this, arguments) }
      try {
        const raw = await window.__m.snapdom.toRaw(root,{...opts,cache:'disabled',embedFonts:false,__maskLayoutSourceGate:gate})
        return {raw,gpv,maskReads}
      } finally { proto.getPropertyValue = original; window.__fx.cleanup(root) }
    },{fixture,gate,opts:FIXTURE_OPTIONS,maskProps:[...maskLayout]}))
    console.log(`${fixture.padEnd(24)} gPV ${rows[0].gpv}->${rows[1].gpv} saved=${rows[0].gpv-rows[1].gpv} mask ${rows[0].maskReads}->${rows[1].maskReads} raw=${rows[0].raw===rows[1].raw?'EQ':'DIFF'}`)
  }
} finally { await browser.close(); await new Promise(r => server.close(r)) }
