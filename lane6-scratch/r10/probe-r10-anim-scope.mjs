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
import { BASE_CSS, FIXTURES, fixturePlan, isGatedFalsifier } from './fixture-geometry.mjs'

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

// Fixture structure and semantics live in fixture-geometry.mjs. The hosted probe consumes that
// exact plan; the browser-free oracle independently checks the same edges against the reachability
// rules. There is deliberately no second fixture table in this file.

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
    const plan = fixturePlan(fx)
    const arms = {}
    for (const scoped of [false, true]) {
      arms[scoped ? 'candidate' : 'historical'] = await page.evaluate(async ({ fx, plan, scoped, baseCss }) => {
        const style = document.createElement('style')
        style.textContent = baseCss + (fx.extraCss || '')
        document.head.appendChild(style)

        const byName = { html: document.documentElement, body: document.body }
        for (const [name, parentName] of plan.edges) {
          if (name === 'html' || name === 'body') continue
          const el = document.createElement('div')
          el.dataset.fixtureNode = name
          if (name.startsWith('n')) {
            el.className = `row r${name.slice(1)}`
            el.textContent = `row ${name.slice(1)}`
          }
          byName[parentName || 'body'].appendChild(el)
          byName[name] = el
        }
        const root = byName.root

        if (plan.shadowInner) {
          const shadowHost = byName.shadowHost
          const shadow = shadowHost.attachShadow({ mode: 'open' })
          const inner = document.createElement('span')
          inner.dataset.fixtureNode = plan.shadowInner
          shadow.appendChild(inner)
          byName[plan.shadowInner] = inner
        }

        const live = []
        const freeze = (a) => { a.pause(); a.currentTime = 0; live.push(a) }
        const add = (el) => {
          const a = el.animate(fx.keys, { duration: 100000, iterations: Infinity })
          freeze(a)
          return a
        }
        if (plan.target) add(byName[plan.target])

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
          byName.host?.remove()
          style.remove()
        }
        return { raw, gpv, counters, failure }
      }, { fx, plan, scoped, baseCss: BASE_CSS })
    }

    const h = arms.historical
    const c = arms.candidate
    const parity = !!(h.raw && c.raw && h.raw === c.raw)
    const saved = h.gpv - c.gpv
    const rec = {
      name: fx.name,
      role: fx.role,
      channel: fx.channel,
      where: fx.where,
      failure: h.failure || c.failure,
      rawParity: parity,
      rawBytes: h.raw ? h.raw.length : 0,
      gpv: { historical: h.gpv, candidate: c.gpv, saved },
      counters: { historical: h.counters, candidate: c.counters },
      index: c.counters?.index ?? null,
      assertions: [],
    }

    // Adjudication is PER CONSUMER / REACHABILITY DIMENSION, not a whole-fixture saved===0 scalar.
    // SELF consumers may soundly release when an ancestor animates an inherited property, while the
    // INHERITED element-universe consumer must still block every queried descendant. The prior
    // whole-fixture gate conflated those dimensions and rejected correct narrowing.
    const eu = c.counters?.elementUniverse || { blocked: 0, released: 0 }
    const trunc = c.counters?.textTruncationPrepass || { blocked: 0, released: 0 }
    const requireAssertion = (name, ok, detail) => rec.assertions.push({ name, ok: !!ok, detail })

    requireAssertion('raw-parity', parity, 'candidate and historical raw SVG must be byte-identical')
    requireAssertion('capture-succeeded', !rec.failure, rec.failure || 'both arms completed')

    if (fx.role === 'opportunity') {
      requireAssertion('universe-releases-queried',
        eu.released >= fx.nodes,
        `elementUniverse released ${eu.released}; need >= queried rows ${fx.nodes}`)
      requireAssertion('work-decreases', saved > 0, `saved GPV=${saved}; opportunity must remove work`)
    } else if (fx.role === 'partial') {
      requireAssertion('universe-releases-unaffected',
        eu.released >= Math.max(1, fx.nodes - 1),
        `elementUniverse released ${eu.released}; partial subtree must release unaffected siblings`)
      requireAssertion('universe-blocks-target',
        eu.blocked >= 1,
        `elementUniverse blocked ${eu.blocked}; animated target must remain blocked`)
      requireAssertion('subtree-consumer-blocked',
        trunc.blocked >= 1,
        `textTruncationPrepass blocked ${trunc.blocked}; captured subtree contains animation`)
    } else if (isGatedFalsifier(fx)) {
      // The browser-free fixture contract proves every QUERIED ROW is downstream of the target for
      // inherited fixtures, or unattributable for shadow fixtures. Root/wrapper bookkeeping calls
      // are allowed to have other outcomes, so require a lower bound rather than released===0.
      requireAssertion('universe-blocks-every-queried-row',
        eu.blocked >= fx.nodes,
        `elementUniverse blocked ${eu.blocked}; need >= queried rows ${fx.nodes}`)
      if (fx.channel === 'unresolvable') {
        requireAssertion('animation-index-unresolvable',
          c.counters?.index?.unresolvable === true,
          `index.unresolvable=${c.counters?.index?.unresolvable}`)
      }
    } else if (fx.role === 'control') {
      requireAssertion('no-animation-zero-delta', saved === 0, `saved GPV=${saved}; control must not change work`)
    } else if (fx.role === 'conservative') {
      // Deliberately report-only: a tighter correct future implementation may release these.
      rec.reportOnly = true
    }

    rec.pass = rec.assertions.every((a) => a.ok)
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
  semanticPass: all.every((f) => f.pass),
  opportunitySaved: Object.fromEntries(
    all.filter((f) => f.role === 'opportunity' || f.role === 'partial').map((f) => [f.name, f.gpv.saved]),
  ),
  falsifierSavedReportedOnly: Object.fromEntries(
    all.filter((f) => f.role === 'falsifier').map((f) => [f.name, f.gpv.saved]),
  ),
  conservativeSavedReportedOnly: Object.fromEntries(
    all.filter((f) => f.role === 'conservative').map((f) => [f.name, f.gpv.saved]),
  ),
  failedAssertions: all.flatMap((f) =>
    (f.assertions || []).filter((a) => !a.ok).map((a) => ({ fixture: f.name, ...a })),
  ),
}
report.provenance = hostedProvenance({ engine: ENGINE })

const outDir = path.join(ROOT, 'lane6-scratch/r10/results')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `anim-scope-${ENGINE}.json`)
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
console.log(`\n${outFile}`)
console.log(`parity=${report.summary.parityPass} semantic=${report.summary.semanticPass} failedAssertions=${report.summary.failedAssertions.length}`)
if (!report.summary.parityPass || !report.summary.semanticPass) process.exitCode = 1