#!/usr/bin/env node
// R10-ANIM1 hosted causal probe.
//
// Deliberately NOT a wall-clock benchmark. This lane's claim is about WORK (CSSOM property
// crossings and gate vetoes), and work is countable, so the measurement is deterministic and needs
// no ambient-CPU gate, no warmup schedule and no timing adjudication at all. Anything the timing
// protocol would add here would be noise around a signal that is already exact.
//
// Three fixture roles, matching the lane's proof structure:
//   anim-sibling-*   the OPPORTUNITY. The animation cannot reach the captured elements, so the
//                    document-wide veto is pure waste. Expect reads to DROP and raw to be EQUAL.
//   anim-ancestor-*  the FALSIFIER. An animation on an ancestor reaches the captured elements
//                    through inheritance, so the scope must still veto. Expect reads to be
//                    UNCHANGED and raw to be EQUAL. A read drop here is the regression this
//                    fixture exists to catch.
//   anim-subtree-*   the FALLBACK CONTROL. An animation inside the captured subtree keeps the
//                    per-element narrowing but blocks the subtree-scoped truncation prepass.
//
// Counters come from two independent sources that must agree:
//   1. a CSSStyleDeclaration.prototype.getPropertyValue patch (outside snapdom, cannot be
//      influenced by the lane's own bookkeeping), and
//   2. the lane's internal __animationScopeCounters sink.
//
// Raw output is compared as an exact string between arms on the SAME compiled bundle, so the
// only variable is the one boolean option.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { assertHostedBrowser, hostedProvenance, sha256File, sha256Text, stableJson } from '../r9/protocol.mjs'

assertHostedBrowser()

const ROOT = process.cwd()
const ENGINE = process.env.BROWSER || 'chromium'
const launcher = { chromium, firefox, webkit }[ENGINE]
if (!launcher) throw new Error(`unknown BROWSER=${ENGINE}`)
const ONLY = new Set((process.env.FIXTURES || '').split(',').map((s) => s.trim()).filter(Boolean))

const BUNDLE_PATH = path.join(ROOT, 'dist/snapdom.mjs')
const bundle = fs.readFileSync(BUNDLE_PATH)

const PAGE = `<!doctype html><html><body><script type="module">
window.__m = await import('/m.mjs')
window.__ready = true
</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/m.mjs')) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(bundle)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// Fixture builders run in the page. `where` places the animated element relative to the capture
// root: 'sibling' | 'ancestor' | 'subtree' | 'self' | 'none'.
// Fixture roles. `falsifier` MUST save exactly zero reads; `opportunity` MUST save more than zero.
//
// NOTE ON anim-subtree, corrected after hosted run 37145239641: an animation inside the captured
// subtree is NOT a falsifier-zero case, and d919614's fixture table claimed it was. An animation
// moves its target and its target's DESCENDANTS, so it cannot move a sibling of that target —
// which means every other row in the capture is genuinely released. The subtree geometry is a
// PARTIAL release for the element universe, and a full block for the subtree-scoped truncation
// prepass (which lane6-scratch/r10/check-r10-anim-scope-geometry.mjs pins as a structural invariant).
// Recording that honestly is the point; forcing it to falsifier-zero would mean weakening the
// element-universe scope for a case it gets right.
const FIXTURES = [
  { name: 'anim-sibling-60', nodes: 60, where: 'sibling', keys: [{ opacity: '0.2' }, { opacity: '0.9' }], role: 'opportunity' },
  { name: 'anim-sibling-entropy-120', nodes: 120, where: 'sibling', keys: [{ transform: 'translateX(0px)' }, { transform: 'translateX(40px)' }], role: 'opportunity' },
  { name: 'anim-sibling-inherited-60', nodes: 60, where: 'sibling', keys: [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }], role: 'opportunity' },
  { name: 'anim-subtree-partial-60', nodes: 60, where: 'subtree', keys: [{ opacity: '0.4' }, { opacity: '1' }], role: 'opportunity' },
  { name: 'anim-ancestor-60', nodes: 60, where: 'ancestor', keys: [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }], role: 'falsifier' },
  { name: 'anim-ancestor-customprop-60', nodes: 60, where: 'ancestor', keys: [{ '--tone': 'rgb(1,2,3)' }, { '--tone': 'rgb(200,10,10)' }], role: 'falsifier', extraCss: '@property --tone{syntax:"<color>";inherits:true;initial-value:#000}.row{color:var(--tone)}' },
  { name: 'anim-ancestor-noninherited-60', nodes: 60, where: 'ancestor', keys: [{ paddingLeft: '0px' }, { paddingLeft: '24px' }], role: 'falsifier' },
  { name: 'anim-descendant-of-root-60', nodes: 60, where: 'childOfRoot', keys: [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }], role: 'falsifier' },
  { name: 'anim-self-60', nodes: 60, where: 'self', keys: [{ opacity: '0.4' }, { opacity: '1' }], role: 'falsifier' },
  { name: 'anim-shadow-60', nodes: 60, where: 'shadow', keys: [{ opacity: '0.2' }, { opacity: '0.9' }], role: 'falsifier' },
  { name: 'anim-none-60', nodes: 60, where: 'none', keys: null, role: 'control' },
]

const BASE_CSS = '.row{display:block;padding:2px;color:#334155}'

const SELECTED = FIXTURES.filter((f) => !ONLY.size || ONLY.has(f.name))

const browser = await launcher.launch({ headless: true })
const SELF = path.join(ROOT, 'lane6-scratch/r10/probe-r10-anim-scope.mjs')
const report = {
  schema: 'snapdom-r10-anim-scope-probe-v1',
  lane: 'R10-ANIM1',
  engine: ENGINE,
  playwright: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/playwright/package.json'), 'utf8')).version,
  bundleSha256: sha256File(BUNDLE_PATH),
  probeSha256: sha256File(SELF),
  fixtureSpecsSha256: sha256Text(stableJson(SELECTED)),
  claim: 'deterministic CSSOM crossing counts + exact raw parity; no wall-clock claim',
  fixtures: {},
  summary: {},
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1800 }, deviceScaleFactor: 1 })
  await page.goto(origin)
  await page.waitForFunction(() => window.__ready === true)

  for (const fx of SELECTED) {
    const arms = {}
    for (const scoped of [false, true]) {
      arms[scoped ? 'candidate' : 'historical'] = await page.evaluate(async ({ fx, scoped, baseCss }) => {
        const style = document.createElement('style')
        style.textContent = baseCss + (fx.extraCss || '')
        document.head.appendChild(style)

        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = document.createElement('div')
        host.appendChild(root)
        for (let i = 0; i < fx.nodes; i++) {
          const el = document.createElement('div')
          el.className = `row r${i}`
          el.textContent = `row ${i}`
          root.appendChild(el)
        }

        const live = []
        const freeze = (a) => { a.pause(); a.currentTime = 0; live.push(a) }
        const add = (el) => {
          const a = el.animate(fx.keys, { duration: 100000, iterations: Infinity })
          freeze(a)
          return a
        }
        if (fx.where === 'sibling') {
          const s = document.createElement('div')
          host.appendChild(s)
          add(s)
        } else if (fx.where === 'ancestor') {
          add(host)
        } else if (fx.where === 'childOfRoot') {
          const s = document.createElement('div')
          root.appendChild(s)
          add(s)
        } else if (fx.where === 'self') {
          add(root)
        } else if (fx.where === 'subtree') {
          add(root.lastElementChild)
        } else if (fx.where === 'shadow') {
          const sh = document.createElement('div')
          const shadow = sh.attachShadow({ mode: 'open' })
          const inner = document.createElement('span')
          shadow.appendChild(inner)
          root.appendChild(sh)
          add(inner)
        }

        const counters = {}
        const proto = CSSStyleDeclaration.prototype
        const original = proto.getPropertyValue
        let gpv = 0
        proto.getPropertyValue = function (prop) {
          gpv++
          return original.apply(this, arguments)
        }
        let raw
        let failure = null
        try {
          raw = await window.__m.snapdom.toRaw(root, {
            cache: 'disabled',
            burst: false,
            embedFonts: false,
            __styleShare: false,
            __animationScope: scoped,
            __animationScopeCounters: counters,
          })
        } catch (error) {
          failure = String(error && error.message || error)
        } finally {
          proto.getPropertyValue = original
          for (const a of live) a.cancel()
          root.remove()
          host.remove()
          style.remove()
        }
        return { raw, gpv, counters, failure }
      }, { fx, scoped, baseCss: BASE_CSS })
    }

    const h = arms.historical
    const c = arms.candidate
    const parity = !!(h.raw && c.raw && h.raw === c.raw)
    const saved = h.gpv - c.gpv
    const rec = {
      role: fx.role,
      where: fx.where,
      failure: h.failure || c.failure,
      rawParity: parity,
      rawBytes: h.raw ? h.raw.length : 0,
      gpv: { historical: h.gpv, candidate: c.gpv, saved },
      counters: { historical: h.counters, candidate: c.counters },
      index: c.counters?.index ?? null,
    }
    // Adjudication. Parity is required everywhere. The direction of the read delta is required to
    // match the fixture's role: a falsifier or control that drops reads is a regression, because it
    // means the scope released a veto it was supposed to keep.
    rec.expectSaved = fx.role === 'opportunity'
    rec.pass = parity && !rec.failure &&
      (fx.role === 'opportunity' ? saved > 0 : saved === 0)
    report.fixtures[fx.name] = rec
    console.log(
      `${fx.name.padEnd(30)} ${rec.role.padEnd(13)} raw=${parity ? 'EQ  ' : 'DIFF'} ` +
      `gpv ${String(h.gpv).padStart(6)}->${String(c.gpv).padStart(6)} saved=${String(saved).padStart(6)} ` +
      `universe ${c.counters?.elementUniverse ? `${c.counters.elementUniverse.released}r/${c.counters.elementUniverse.blocked}b` : '-'} ` +
      `${rec.pass ? 'PASS' : 'FAIL'}`,
    )
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const all = Object.values(report.fixtures)
report.summary = {
  fixtures: all.length,
  parityPass: all.every((f) => f.rawParity),
  rolePass: all.every((f) => f.pass),
  opportunitySaved: Object.fromEntries(
    all.filter((f) => f.role === 'opportunity').map((f) => [f.name, f.gpv.saved]),
  ),
  falsifierSaved: Object.fromEntries(
    all.filter((f) => f.role === 'falsifier').map((f) => [f.name, f.gpv.saved]),
  ),
  falsifierMustBeZero: all.filter((f) => f.role === 'falsifier').every((f) => f.gpv.saved === 0),
  controlMustBeZero: all.filter((f) => f.role === 'control').every((f) => f.gpv.saved === 0),
}
report.provenance = hostedProvenance({ engine: ENGINE })

const outDir = path.join(ROOT, 'lane6-scratch/r10/results')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `anim-scope-${ENGINE}.json`)
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
console.log(`\n${outFile}`)
console.log(`parity=${report.summary.parityPass} role=${report.summary.rolePass} falsifiersZero=${report.summary.falsifierMustBeZero}`)
if (!report.summary.parityPass || !report.summary.rolePass) process.exitCode = 1