#!/usr/bin/env node
// Exact corrected-parent vs integrated style-authority+PC1 parity. No timing evidence.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const engineName = (process.argv.find(x => x.startsWith('--engine='))?.slice(9) || 'chromium').toLowerCase()
const engines = { chromium, firefox, webkit }
const engine = engines[engineName]
if (!engine) throw new Error(`unknown engine ${engineName}`)

const baseline = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-clean-456/dist/snapdom.mjs'))
const candidate = fs.readFileSync(path.join(ROOT, 'worktrees/snapdom-v3-r7-style-authority-integration/dist/snapdom.mjs'))
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase().slice(0, 12)
const PAGE = `<!doctype html><html><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">window.__mods={baseline:await import('/baseline.mjs'),candidate:await import('/candidate.mjs')};window.__ready=true</script></body></html>`
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/baseline.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(baseline); return }
  if (req.url?.startsWith('/candidate.mjs')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(candidate); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await engine.launch({ headless: true })

const fixtures = ['light-20cards', 'cards400-safe', 'cards400-neutral-unsafe', 'cards400-non-neutral', 'asset-heavy']
async function runFixture(page, fixture, which) {
  return page.evaluate(async ({ fixture, which, opts }) => {
    const el = window.__fx.build(fixture)
    try { return await window.__mods[which].snapdom.toRaw(el, { ...opts, cache: 'disabled', embedFonts: false }) }
    finally { window.__fx.cleanup(el) }
  }, { fixture, which, opts: FIXTURE_OPTIONS })
}
async function runSpecial(page, which, kind) {
  return page.evaluate(async ({ which, kind }) => {
    const style = document.createElement('style')
    const root = document.createElement('div')
    if (kind === 'entropy') {
      style.textContent = '.e{width:900px;font:13px Arial}.r{display:block;padding:2px 4px}.r[data-i]{outline-offset:0}'
      root.className = 'e'
      for (let i = 0; i < 400; i++) { const r = document.createElement('div'); r.className = 'r'; r.dataset.i = String(i); r.textContent = 'row ' + i; root.appendChild(r) }
    } else if (kind === 'cv-auto') {
      style.textContent = '.r{content-visibility:auto;contain-intrinsic-size:20px;width:300px;height:12px}'
      for (let i = 0; i < 200; i++) { const r = document.createElement('div'); r.className = 'r'; r.textContent = 'row ' + i; root.appendChild(r) }
    } else {
      style.textContent = '.back{width:260px;height:100px;background:repeating-linear-gradient(90deg,#000 0 8px,#fff 8px 16px)}.frost{width:180px;height:70px;background:rgba(255,255,255,.2);backdrop-filter:blur(8px)}'
      root.innerHTML = '<div class="back"><div class="frost">frosted</div></div>'
    }
    document.head.appendChild(style); document.body.appendChild(root)
    try { return await window.__mods[which].snapdom.toRaw(root, { burst: false, cache: 'disabled', embedFonts: false }) }
    finally { root.remove(); style.remove() }
  }, { which, kind })
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin); await page.waitForFunction(() => window.__ready === true)
  let ok = true
  for (const fixture of fixtures) {
    const a = await runFixture(page, fixture, 'baseline')
    const b = await runFixture(page, fixture, 'candidate')
    const equal = a === b; ok &&= equal
    console.log(`${fixture.padEnd(29)} ${equal ? 'PASS' : 'FAIL'} bytes=${a.length}/${b.length}`)
  }
  for (const kind of ['entropy', 'cv-auto', 'backdrop']) {
    const a = await runSpecial(page, 'baseline', kind)
    const b = await runSpecial(page, 'candidate', kind)
    const equal = a === b; ok &&= equal
    console.log(`${kind.padEnd(29)} ${equal ? 'PASS' : 'FAIL'} bytes=${a.length}/${b.length}`)
  }
  console.log(`${engineName} baseline=${sha(baseline)} candidate=${sha(candidate)} OVERALL=${ok ? 'PASS' : 'FAIL'}`)
  if (!ok) process.exitCode = 1
  await page.close()
} finally {
  await browser.close()
  await new Promise(r => server.close(r))
}
