#!/usr/bin/env node
// Exact-output differential for the pseudo counter fast path. Both arms force style sharing off,
// isolating the counter/host-style refactor from R7-P's snapshot/key reuse mechanisms.

import fs from 'node:fs'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const modules = {
  parent: fs.readFileSync(`${ROOT}/worktrees/snapdom-v3-r5-auto-margin-gate/dist/snapdom.mjs`),
  candidate: fs.readFileSync(`${ROOT}/worktrees/snapdom-v3-r7-pseudo-overlay/dist/snapdom.mjs`),
}
const PAGE = '<!doctype html><html><body><script type="module">window.__m=await import("/m.mjs");window.__ready=true</script></body></html>'
const server = http.createServer((req, res) => {
  if (req.url === '/parent.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(modules.parent); return }
  if (req.url === '/candidate.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(modules.candidate); return }
  if (req.url?.startsWith('/page')) {
    const which = new URL(req.url, 'http://x').searchParams.get('which') || 'parent'
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(PAGE.replace('/m.mjs', `/${which}.mjs`)); return
  }
  res.writeHead(404); res.end('nf')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const scenes = [
  ['literal', '.row::before{content:"["}.row::after{content:"]"}'],
  ['literal-increment', '.root{counter-reset:item}.row::before{content:"[";counter-increment:item}.row::after{content:"]";counter-increment:item}'],
  ['counter-content', '.root{counter-reset:item}.row::before{counter-increment:item;content:counter(item) "."}.row::after{content:"/" counter(item)}'],
]

const browser = await chromium.launch({ headless: true })
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
      for (let i = 0; i < 80; i++) {
        const el = document.createElement('div'); el.className = 'row'; el.textContent = 'row ' + i; root.appendChild(el)
      }
      document.body.appendChild(root)
      try {
        return await window.__m.snapdom.toRaw(root, {
          burst: false, cache: 'disabled', embedFonts: false, __styleShare: false,
        })
      } finally { root.remove(); style.remove() }
    }, { pseudoCss })
  } finally { await page.close() }
}

try {
  for (const [name, css] of scenes) {
    const parent = await capture('parent', css)
    const candidate = await capture('candidate', css)
    console.log(name, { parity: parent === candidate, parentBytes: parent.length, candidateBytes: candidate.length })
    if (parent !== candidate) process.exitCode = 1
  }
} finally {
  await browser.close(); await new Promise((r) => server.close(r))
}
