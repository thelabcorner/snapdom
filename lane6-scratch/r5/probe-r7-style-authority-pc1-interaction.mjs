#!/usr/bin/env node
// R7 deterministic interaction probe: frozen five-leg style-authority stack before PC1
// versus the current five-leg stack plus PC1 counter/content CSE. No wall-time evidence.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const pre = fs.readFileSync(path.join(ROOT, 'lane6-scratch/r5/artifacts/r7-style-authority-sa1-sa5-pre-pc1.mjs'))
const post = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/MODULE.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url === '/pre.mjs') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(pre); return }
  if (req.url === '/post.mjs') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(post); return }
  if (req.url?.startsWith('/page')) {
    const which = new URL(req.url, 'http://x').searchParams.get('which') === 'post' ? 'post' : 'pre'
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(PAGE.replace('MODULE', which)); return
  }
  res.writeHead(404); res.end('nf')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const scenes = [
  ['literal', '.row::before{content:"["}.row::after{content:"]"}'],
  ['literal-increment', '.root{counter-reset:item}.row::before{content:"[";counter-increment:item}.row::after{content:"]";counter-increment:item}'],
  ['counter-content', '.root{counter-reset:item}.row::before{counter-increment:item;content:counter(item) "."}.row::after{content:"/" counter(item)}'],
  ['counter-reset', '.root{counter-reset:item 7}.row::before{counter-reset:item 3;content:"R"}.row::after{content:counter(item)}'],
  ['counter-set', '.root{counter-reset:item 1}.row::before{counter-set:item 9;content:"S"}.row::after{content:counter(item)}'],
]

const browser = await chromium.launch({ headless: true, args: ['--no-first-run', '--disable-extensions'] })
async function capture(which, pseudoCss) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  try {
    await page.goto(`${origin}/page?which=${which}`)
    await page.waitForFunction(() => window.__ready === true)
    return await page.evaluate(async ({ pseudoCss }) => {
      const style = document.createElement('style')
      style.textContent = `.root{width:900px;font:13px Arial}.row{display:block}${pseudoCss}`
      document.head.appendChild(style)
      const root = document.createElement('div'); root.className = 'root'
      for (let i = 0; i < 120; i++) {
        const row = document.createElement('div'); row.className = 'row'; row.textContent = 'row ' + i; root.appendChild(row)
      }
      document.body.appendChild(root)
      try {
        const proto = CSSStyleDeclaration.prototype
        const orig = proto.getPropertyValue
        let gpv = 0
        proto.getPropertyValue = function (...args) { gpv++; return orig.apply(this, args) }
        try {
          const raw = await window.__m.snapdom.toRaw(root, { burst: false, cache: 'disabled', embedFonts: false })
          return { raw, gpv }
        } finally { proto.getPropertyValue = orig }
      } finally { root.remove(); style.remove() }
    }, { pseudoCss })
  } finally { await page.close() }
}

try {
  for (const [name, css] of scenes) {
    const a = await capture('pre', css)
    const b = await capture('post', css)
    const equal = a.raw === b.raw
    console.log(`${name.padEnd(20)} parity=${equal ? 'PASS' : 'FAIL'} gPV ${a.gpv} -> ${b.gpv} delta=${b.gpv - a.gpv}`)
    if (!equal) process.exitCode = 1
  }
} finally {
  await browser.close()
  await new Promise(r => server.close(r))
}
