#!/usr/bin/env node
// Deterministic BGS2 source-basis oracle: data URLs only, no external asset/font readiness.
// Mechanism counts only; NO wall-time claim.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><body><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
const server = http.createServer((q, r) => {
  if (q.url?.startsWith('/m.mjs')) {
    r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    r.end(mod)
    return
  }
  r.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  r.end(PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const sourceProps = new Set([
  'mask-image', '-webkit-mask-image',
  'mask-source', 'mask-box-image-source', 'mask-border-source', '-webkit-mask-box-image-source',
  'border-image-source',
])

async function arm(bt, sourceBasis) {
  const b = await bt.launch({ headless: true })
  const p = await b.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 1 })
  try {
    await p.goto(origin)
    await p.waitForFunction(() => window.__ready === true)
    return await p.evaluate(async ({ sourceBasis, sourceProps: propList }) => {
      const data = 'url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")'
      const root = document.createElement('div')
      root.style.cssText = 'width:900px;display:grid;grid-template-columns:repeat(5,160px);gap:4px'
      for (let i = 0; i < 250; i++) {
        const el = document.createElement('div')
        el.textContent = 'x'
        el.style.cssText = 'width:150px;height:24px;background-color:rgb(20,30,40);border:4px solid transparent'
        switch (i % 5) {
          case 1: el.style.setProperty('mask', `${data} center / cover no-repeat`); break
          case 2: el.style.setProperty('-webkit-mask', `${data} center / cover no-repeat`); break
          case 3: el.style.setProperty('border-image', `${data} 30`); break
          case 4:
            if (CSS.supports('mask-border', `${data} 30`)) el.style.setProperty('mask-border', `${data} 30`)
            else if (CSS.supports('-webkit-mask-box-image', `${data} 30`)) el.style.setProperty('-webkit-mask-box-image', `${data} 30`)
            break
        }
        root.appendChild(el)
      }
      document.body.appendChild(root)
      const owner = CSSStyleDeclaration.prototype
      const d = Object.getOwnPropertyDescriptor(owner, 'getPropertyValue')
      const original = owner.getPropertyValue
      const watched = new Set(propList)
      let total = 0, sourceReads = 0
      Object.defineProperty(owner, 'getPropertyValue', {
        ...d,
        value(prop) {
          total++
          if (watched.has(prop)) sourceReads++
          return original.apply(this, arguments)
        },
      })
      try {
        const raw = await window.__m.snapdom.toRaw(root, {
          burst: false,
          cache: 'disabled',
          embedFonts: false,
          compress: false,
          __backgroundUrlSentinel: true,
          __backgroundSourceBasis: sourceBasis,
        })
        return { raw, total, sourceReads }
      } finally {
        Object.defineProperty(owner, 'getPropertyValue', d)
        root.remove()
      }
    }, { sourceBasis, sourceProps: [...sourceProps] })
  } finally {
    await p.close(); await b.close()
  }
}

try {
  for (const [engine, bt] of Object.entries({ chromium, firefox, webkit })) {
    const complete1 = await arm(bt, false)
    const complete2 = await arm(bt, false)
    const reduced1 = await arm(bt, true)
    const reduced2 = await arm(bt, true)
    console.log(`${engine}: completeSelf=${complete1.raw === complete2.raw ? 'PASS' : 'FAIL'} reducedSelf=${reduced1.raw === reduced2.raw ? 'PASS' : 'FAIL'} parity=${complete1.raw === reduced1.raw ? 'PASS' : 'FAIL'} source=${complete1.sourceReads}->${reduced1.sourceReads} total=${complete1.total}->${reduced1.total}`)
  }
} finally {
  await new Promise((r) => server.close(r))
}
