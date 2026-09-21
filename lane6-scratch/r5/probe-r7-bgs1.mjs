#!/usr/bin/env node
// R7-BGS1 same-build late background URL sentinel probe. Deterministic counts only.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { PAGE_FIXTURE_SRC, FIXTURE_OPTIONS } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const mod = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__m=await import('/m.mjs');window.__ready=true</script></body></html>`
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

const watched = new Set([
  'background-image', 'background',
  'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image',
  'mask-source', 'mask-box-image-source', 'mask-border-source', '-webkit-mask-box-image-source',
  'border-image', 'border-image-source',
])

async function arm(bt, fixture, sentinel) {
  const b = await bt.launch({ headless: true })
  const p = await b.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  try {
    await p.goto(origin)
    await p.waitForFunction(() => window.__ready === true)
    return await p.evaluate(async ({ fixture, opts, sentinel, watched: watchedList }) => {
      let el, style = null
      if (fixture === 'entropy-400') {
        style = document.createElement('style')
        style.textContent = '.bgs-root{width:900px;font:13px Arial}.bgs-row{display:block;padding:2px 4px}.bgs-row[data-r]{outline-offset:0}'
        document.head.appendChild(style)
        el = document.createElement('div')
        el.className = 'bgs-root'
        for (let i = 0; i < 400; i++) {
          const row = document.createElement('div')
          row.className = 'bgs-row'
          row.dataset.r = String(i)
          row.textContent = 'row ' + i
          el.appendChild(row)
        }
        document.body.appendChild(el)
      } else el = window.__fx.build(fixture)

      const watched = new Set(watchedList)
      const owner = CSSStyleDeclaration.prototype
      const d = Object.getOwnPropertyDescriptor(owner, 'getPropertyValue')
      const original = owner.getPropertyValue
      let total = 0, urlFamily = 0
      Object.defineProperty(owner, 'getPropertyValue', {
        ...d,
        value(prop) {
          total++
          if (watched.has(prop)) urlFamily++
          return original.apply(this, arguments)
        },
      })
      try {
        const raw = await window.__m.snapdom.toRaw(el, {
          ...opts,
          cache: 'disabled',
          embedFonts: false,
          __backgroundUrlSentinel: sentinel,
        })
        return { raw, total, urlFamily }
      } finally {
        Object.defineProperty(owner, 'getPropertyValue', d)
        if (style) { el.remove(); style.remove() }
        else window.__fx.cleanup(el)
      }
    }, { fixture, opts: FIXTURE_OPTIONS, sentinel, watched: [...watched] })
  } finally {
    await p.close(); await b.close()
  }
}

try {
  for (const [engine, bt] of Object.entries({ chromium, firefox, webkit })) {
    console.log('\n' + engine)
    for (const fixture of ['light-20cards', 'cards400-safe', 'cards400-non-neutral', 'asset-heavy', 'entropy-400']) {
      const historical = await arm(bt, fixture, false)
      const candidate = await arm(bt, fixture, true)
      console.log(`${fixture.padEnd(27)} parity=${historical.raw === candidate.raw ? 'PASS' : 'FAIL'} urlFamily ${historical.urlFamily}->${candidate.urlFamily} saved=${historical.urlFamily - candidate.urlFamily} totalGPV ${historical.total}->${candidate.total}`)
    }
  }
} finally {
  await new Promise((r) => server.close(r))
}
