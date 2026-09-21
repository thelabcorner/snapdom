#!/usr/bin/env node
// R7-GR1 deterministic scrollbar-heavy mechanism probe. NO wall-time claims.
// Same candidate bundle, option-only A/B; counts CSSStyleDeclaration.getPropertyValue calls
// and requires byte-identical output for each targeted scrollbar-dense scene.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const REL = 'worktrees/snapdom-v3-r7-gutter-snapshot-reuse/dist/snapdom.mjs'
const mod = fs.readFileSync(path.join(ROOT, REL))
const sha = crypto.createHash('sha256').update(mod).digest('hex').toUpperCase()

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0}.root{width:1100px;font:13px/18px Arial,sans-serif}
.grid{display:grid;grid-template-columns:repeat(5,200px);gap:6px}
.scroll{width:180px;height:64px;overflow:auto;box-sizing:content-box;border:2px solid #888;padding:3px}
.wide{width:420px;height:22px;white-space:nowrap}.tall{height:170px;width:120px}
.borderbox{box-sizing:border-box}.nested{width:185px;height:80px;overflow:auto;border:1px solid #777;padding:2px}
.inner{width:280px;height:120px;overflow:auto;border:1px solid #999;padding:2px}
.visible{overflow:visible;width:180px;height:64px;border:2px solid #888;padding:3px}
</style></head><body><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`

const server = http.createServer((req,res) => {
  if (req.url?.startsWith('/m.mjs')) {
    res.writeHead(200, {'content-type':'text/javascript','cache-control':'no-store'}); res.end(mod); return
  }
  res.writeHead(200, {'content-type':'text/html','cache-control':'no-store'}); res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({headless:true,args:['--no-first-run','--disable-extensions']})

const scenes = [
  ['content-box-200','content',200],
  ['mixed-box-200','mixed',200],
  ['nested-120x2','nested',120],
  ['visible-control-200','visible',200],
]

try {
  for (const [name, kind, count] of scenes) {
    const page = await browser.newPage({viewport:{width:1400,height:2200},deviceScaleFactor:1})
    try {
      await page.goto(origin)
      await page.waitForFunction(() => window.__ready === true)
      const result = await page.evaluate(async ({kind,count}) => {
        const build = () => {
          const root = document.createElement('div'); root.className = 'root grid'
          for (let i=0;i<count;i++) {
            if (kind === 'nested') {
              const outer = document.createElement('div'); outer.className = 'nested'
              const inner = document.createElement('div'); inner.className = 'inner'
              const wide = document.createElement('div'); wide.className = 'wide'; wide.textContent = `nested ${i} ${'.'.repeat(80)}`
              const tall = document.createElement('div'); tall.className = 'tall'
              inner.append(wide,tall); outer.appendChild(inner); root.appendChild(outer)
              continue
            }
            const box = document.createElement('div')
            box.className = kind === 'visible' ? 'visible' : `scroll${kind === 'mixed' && i%2 ? ' borderbox' : ''}`
            if (kind !== 'visible') {
              const wide = document.createElement('div'); wide.className = 'wide'; wide.textContent = `row ${i} ${'.'.repeat(80)}`
              const tall = document.createElement('div'); tall.className = 'tall'
              box.append(wide,tall)
            } else box.textContent = `row ${i}`
            root.appendChild(box)
          }
          document.body.appendChild(root)
          return root
        }
        const run = async (reuse) => {
          const proto = CSSStyleDeclaration.prototype
          const original = proto.getPropertyValue
          let gpv = 0
          proto.getPropertyValue = function(prop){ gpv++; return original.call(this,prop) }
          const el = build()
          try {
            const raw = await window.__m.snapdom.toRaw(el,{burst:false,cache:'disabled',embedFonts:false,__gutterSnapshotReuse:reuse})
            return {raw,gpv}
          } finally { el.remove(); proto.getPropertyValue = original }
        }
        const historical = await run(false)
        const candidate = await run(true)
        return {equal:historical.raw===candidate.raw,historical:historical.gpv,candidate:candidate.gpv}
      }, {kind,count})
      const saved = result.historical-result.candidate
      const pct = result.historical ? 100*saved/result.historical : 0
      console.log(`${name.padEnd(22)} parity=${result.equal?'PASS':'FAIL'} gPV ${result.historical} -> ${result.candidate} saved=${saved} (${pct.toFixed(1)}%)`)
      if (!result.equal) process.exitCode = 1
    } finally { await page.close() }
  }
  console.log(`bundle ${sha.slice(0,12)} bytes=${mod.length}`)
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve))
}