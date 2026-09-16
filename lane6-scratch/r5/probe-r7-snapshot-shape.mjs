#!/usr/bin/env node
// Diagnostic-only cardinality probe for the instrumented R7 getSnapshot worktree.
// No timings are reported: the branch deliberately contains counters in the hot path.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { FIXTURE_OPTIONS, PAGE_FIXTURE_SRC } from '../atlas/profiler/fixtures.mjs'

const ROOT = process.cwd()
const rel = 'worktrees/snapdom-v3-r7-snapshot-probe/dist/snapdom.mjs'
const mod = fs.readFileSync(path.join(ROOT, rel))
const fixtures = ['light-20cards', 'cards400-safe', 'cards400-neutral-unsafe', 'cards400-non-neutral']

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${PAGE_FIXTURE_SRC.replaceAll('</script>', '<\\/script>')}</script><script type="module">
window.__snapdomSnapshotProbe={}
window.__snap=await import('/candidate.mjs')
window.__ready=true
</script></body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }
  if (u.pathname === '/candidate.mjs') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(mod)
    return
  }
  res.writeHead(404); res.end('nf')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 1 })
try {
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true && window.__fxReady === true)
  const rows = []
  for (const fixture of fixtures) {
    const probe = await page.evaluate(async ({ fixture, options }) => {
      window.__snapdomSnapshotProbe = {}
      const el = window.__fx.build(fixture)
      try {
        const result = await window.__snap.snapdom(el, options)
        result.toRaw()
        return { ...window.__snapdomSnapshotProbe }
      } finally {
        window.__fx.cleanup(el)
      }
    }, { fixture, options: FIXTURE_OPTIONS })
    rows.push({ fixture, probe })
  }
  for (const { fixture, probe } of rows) {
    const calls = probe.getSnapshotCalls || 0
    const hit = probe.shareHits || 0
    const avg = (n, d) => d ? n / d : 0
    console.log(`\n${fixture}`)
    console.log(`  getSnapshot=${calls} cacheHit=${probe.snapshotCacheHits || 0} cacheMiss=${probe.snapshotCacheMisses || 0}`)
    console.log(`  share hit/miss/unshared=${hit}/${probe.shareMisses || 0}/${probe.unsharedSnapshots || 0}`)
    console.log(`  shared copied props avg=${avg(probe.shareHitCopiedProps || 0, hit).toFixed(2)} rr avg=${avg(probe.shareHitRrProps || 0, hit).toFixed(2)}`)
    console.log(`  share-list builds=${probe.shareListBuilds || 0} list snapshot props avg=${avg(probe.shareListSnapshotProps || 0, probe.shareListBuilds || 0).toFixed(2)} rr avg=${avg(probe.shareListRrProps || 0, probe.shareListBuilds || 0).toFixed(2)}`)
    console.log(`  fresh props avg=${avg(probe.freshSnapshotProps || 0, (probe.shareMisses || 0) + (probe.unsharedSnapshots || 0)).toFixed(2)}`)
    console.log(`  signature calls=${probe.signatureCalls || 0} memo/full=${probe.signatureMemoHits || 0}/${probe.signatureFullBuilds || 0} full props avg=${avg(probe.signatureFullProps || 0, probe.signatureFullBuilds || 0).toFixed(2)}`)
    console.log(`  key hit/miss=${probe.snapshotKeyHits || 0}/${probe.snapshotKeyMisses || 0}`)
    console.log(`  zero-margin candidates=${probe.zeroMarginCandidates || 0} typedMapCalls=${probe.typedMapCalls || 0} shadowSnapshots=${probe.shadowHostSnapshots || 0}`)
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
