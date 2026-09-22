#!/usr/bin/env node
// R7-OFF1 same-build offset-rider gate probe. Deterministic counts only; NO wall-time claim.
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

async function arm(bt, fixture, gate) {
  const b = await bt.launch({ headless: true })
  const p = await b.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  try {
    await p.goto(origin)
    await p.waitForFunction(() => window.__ready === true)
    return await p.evaluate(async ({ fixture, opts, gate }) => {
      let el, style = null
      if (fixture === 'entropy-400') {
        style = document.createElement('style')
        style.textContent = '.off-root{width:900px;font:13px Arial}.off-row{display:block;padding:2px 4px}.off-row[data-r]{outline-offset:0}'
        document.head.appendChild(style)
        el = document.createElement('div')
        el.className = 'off-root'
        for (let i = 0; i < 400; i++) {
          const row = document.createElement('div')
          row.className = 'off-row'
          row.dataset.r = String(i)
          row.textContent = 'row ' + i
          el.appendChild(row)
        }
        document.body.appendChild(el)
      } else el = window.__fx.build(fixture)

      const owner = CSSStyleDeclaration.prototype
      const d = Object.getOwnPropertyDescriptor(owner, 'getPropertyValue')
      const original = owner.getPropertyValue
      let total = 0, offsets = 0
      Object.defineProperty(owner, 'getPropertyValue', {
        ...d,
        value(prop) {
          total++
          if (prop === 'top' || prop === 'right' || prop === 'bottom' || prop === 'left' || prop?.startsWith?.('inset-')) offsets++
          return original.apply(this, arguments)
        },
      })
      try {
        const raw = await window.__m.snapdom.toRaw(el, {
          ...opts,
          cache: 'disabled',
          embedFonts: false,
          __styleShareInsetValueGate: gate,
        })
        return { raw, total, offsets }
      } finally {
        Object.defineProperty(owner, 'getPropertyValue', d)
        if (style) { el.remove(); style.remove() }
        else window.__fx.cleanup(el)
      }
    }, { fixture, opts: FIXTURE_OPTIONS, gate })
  } finally {
    await p.close(); await b.close()
  }
}

try {
  for (const [engine, bt] of Object.entries({ chromium, firefox, webkit })) {
    console.log('\n' + engine)
    for (const fixture of ['light-20cards', 'cards400-safe', 'cards400-non-neutral', 'asset-heavy', 'entropy-400']) {
      const historical = await arm(bt, fixture, false)
      const gated = await arm(bt, fixture, true)
      console.log(`${fixture.padEnd(27)} parity=${historical.raw === gated.raw ? 'PASS' : 'FAIL'} offsets ${historical.offsets}->${gated.offsets} saved=${historical.offsets - gated.offsets} totalGPV ${historical.total}->${gated.total}`)
    }
  }
} finally {
  await new Promise((r) => server.close(r))
}
