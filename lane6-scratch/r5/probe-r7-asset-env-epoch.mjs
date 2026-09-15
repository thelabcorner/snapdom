#!/usr/bin/env node
// Diagnose why same-capture snapshots become unavailable before background inlining.
import http from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const built = await build({
  stdin: {
    contents: `export { snapdom } from './src/index.js'; export { getStyleEnvEpoch } from './src/modules/styles.js'`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'esm', platform: 'browser', write: false, minify: false, logLevel: 'silent',
})
const mod = built.outputFiles[0].contents
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req,res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200,{'content-type':'text/javascript'}); res.end(mod); return }
  // Deterministic local assets; font bytes may be invalid, which is enough to exercise load/error epoch delivery.
  if (req.url?.startsWith('/img/')) { res.writeHead(200,{'content-type':'image/png'}); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lxR3WQAAAABJRU5ErkJggg==','base64')); return }
  if (req.url?.startsWith('/font/')) { res.writeHead(200,{'content-type':'font/ttf'}); res.end(Buffer.from('AA==','base64')); return }
  res.writeHead(200,{'content-type':'text/html'}); res.end(PAGE)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser = await chromium.launch({headless:true})
try {
  const page = await browser.newPage({viewport:{width:1400,height:1800}})
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(()=>window.__ready)
  for (const fixture of ['cards400-safe','asset-heavy']) {
    const result = await page.evaluate(async ({fixture,opts}) => {
      const root = window.__fx.build(fixture)
      const events=[]
      const note=(type)=>events.push({type,epoch:window.__m.getStyleEnvEpoch(),status:document.fonts?.status})
      document.fonts?.addEventListener?.('loading',()=>note('loading'),{once:true})
      document.fonts?.addEventListener?.('loadingdone',()=>note('loadingdone'),{once:true})
      document.fonts?.addEventListener?.('loadingerror',()=>note('loadingerror'),{once:true})
      const before = window.__m.getStyleEnvEpoch()
      const fontBefore = document.fonts?.status
      try {
        const raw = await window.__m.snapdom.toRaw(root,{...opts,cache:'disabled',embedFonts:false})
        await Promise.resolve()
        return {before,after:window.__m.getStyleEnvEpoch(),fontBefore,fontAfter:document.fonts?.status,events,bytes:raw.length}
      } finally { window.__fx.cleanup(root) }
    },{fixture,opts:FIXTURE_OPTIONS})
    console.log(fixture, JSON.stringify(result))
  }
} finally { await browser.close(); await new Promise(r=>server.close(r)) }
