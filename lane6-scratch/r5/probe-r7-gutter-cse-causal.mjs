#!/usr/bin/env node
// R7-GR1 deterministic mechanism probe. No wall-time claim.
// Same candidate bundle, option-only A/B; counts all CSSStyleDeclaration.getPropertyValue calls.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const REL = 'worktrees/snapdom-v3-r7-gutter-snapshot-reuse/dist/snapdom.mjs'
const mod = fs.readFileSync(path.join(ROOT, REL))
const sha = crypto.createHash('sha256').update(mod).digest('hex').toUpperCase()
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((req,res) => {
  if (req.url?.startsWith('/m.mjs')) { res.writeHead(200, {'content-type':'text/javascript','cache-control':'no-store'}); res.end(mod); return }
  res.writeHead(200, {'content-type':'text/html','cache-control':'no-store'}); res.end(PAGE)
})
await new Promise((resolve) => server.listen(43993, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({headless:true,args:['--no-first-run','--disable-extensions']})
const page = await browser.newPage({viewport:{width:1400,height:1800},deviceScaleFactor:1})
const fixtures = ['light-20cards','cards400-safe','cards400-neutral-unsafe','cards400-non-neutral','asset-heavy','entropy-400']

try {
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)
  for (const fixture of fixtures) {
    const run = async (reuse) => page.evaluate(async ({fixture, opts, reuse}) => {
      const proto = CSSStyleDeclaration.prototype
      const original = proto.getPropertyValue
      let gpv = 0
      proto.getPropertyValue = function(prop) { gpv++; return original.call(this, prop) }
      let el
      let entropyStyle = null
      if (fixture === 'entropy-400') {
        entropyStyle = document.createElement('style')
        entropyStyle.textContent = '.gr-row[data-gr]{outline-offset:0}.gr-root{width:900px;font:13px Arial,sans-serif}.gr-row{display:block;padding:2px 4px}'
        document.head.appendChild(entropyStyle)
        el = document.createElement('div'); el.className = 'gr-root'
        for (let i=0;i<400;i++) { const row=document.createElement('div'); row.className='gr-row'; row.dataset.gr=String(i); row.textContent='row '+i; el.appendChild(row) }
        document.body.appendChild(el)
      } else {
        el = window.__fx.build(fixture)
      }
      try {
        const raw = await window.__m.snapdom.toRaw(el, {...opts, __gutterSnapshotReuse:reuse})
        return {raw, gpv}
      } finally {
        if (fixture === 'entropy-400') { el.remove(); entropyStyle?.remove() }
        else window.__fx.cleanup(el)
        proto.getPropertyValue = original
      }
    }, {fixture, opts:FIXTURE_OPTIONS, reuse})
    const historical = await run(false)
    const candidate = await run(true)
    const saved = historical.gpv - candidate.gpv
    const pct = historical.gpv ? 100 * saved / historical.gpv : 0
    console.log(`${fixture.padEnd(28)} parity=${historical.raw===candidate.raw?'PASS':'FAIL'} gPV ${historical.gpv} -> ${candidate.gpv} saved=${saved} (${pct.toFixed(1)}%)`)
  }
  console.log(`bundle ${sha.slice(0,12)} bytes=${mod.length}`)
} finally {
  await page.close(); await browser.close(); await new Promise((resolve) => server.close(resolve))
}
