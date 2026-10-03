#!/usr/bin/env node
/**
 * RS-A10 icon-ceiling validator. Fail-closed.
 *
 * The icon lane cannot produce a performance claim — no memo ships (see
 * docs/perf/RS_A10_ICON_RASTER_MEMO.md). What it CAN establish, and what this file enforces,
 * is the set of facts any future memo proposal would have to be measured against:
 *
 *   1. the per-node cost is real and is where this audit says it is — one forced layout and one
 *      PNG encode per icon, counted from outside the library;
 *   2. the fixture is self-contained: with the network cut, the output is byte-identical and the
 *      counters are identical, so nothing about the measurement is network luck;
 *   3. the all-distinct control has a ZERO ceiling, so a memo has nothing to win there — which is
 *      what makes a win on the repeated-glyph fixture attributable to deduplication rather than
 *      to having done less work in general;
 *   4. the no-icon control does no icon work at all, so the probe's own instrumentation is not
 *      a cost of its own.
 *
 * A green run here means the CEILING is trustworthy. It is not evidence that the memo was built.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}

const browser = String(arg('browser') || 'chromium')
const replicate = String(arg('replicate') || '0')
const file = path.resolve(ROOT, arg('file') || `lane6-scratch/r9/results/icon-ceiling-${browser}-r${replicate}.json`)

if (!fs.existsSync(file)) {
  console.error(`RS-A10 validator: artifact missing: ${path.relative(ROOT, file)}`)
  process.exit(1)
}

const report = JSON.parse(fs.readFileSync(file, 'utf8'))
const failures = []
const notes = []
const fail = (fixture, gate, detail) => failures.push(`${fixture}: ${gate} — ${detail}`)

if (report.schema !== 'snapdom-r9-hosted-bench-v1') {
  console.error(`RS-A10 validator: unexpected schema ${report.schema}`)
  process.exit(1)
}
if (report.provenance?.browser?.actualName !== browser) {
  fail('(harness)', 'browser identity', `requested ${browser}, measured ${report.provenance?.browser?.actualName}`)
}

const fixtures = report.fixtures || {}
if (!Object.keys(fixtures).length) {
  console.error('RS-A10 validator: artifact carries no fixtures')
  process.exit(1)
}

for (const [name, fx] of Object.entries(fixtures)) {
  const c = fx.counters
  const nodes = fx.ceiling?.iconNodes ?? 0
  const avoidable = fx.ceiling?.avoidableLayouts ?? null
  const isIcons = fx.meta?.mode === 'icons'

  // 2 — self-containment. Required for every fixture in the lane.
  if (fx.selfContainedPass !== true) {
    fail(name, 'warm-offline self-containment',
      `bytesStable=${fx.selfContainment?.bytesStable} countersStable=${fx.selfContainment?.countersStable}`)
  }

  // 1 — parity and instrumentation stability.
  if (!fx.parity) fail(name, 'raw parity', 'slot1 output !== slot2 output')
  if (fx.countersParity !== true) fail(name, 'counter parity', 'slot1 counters !== slot2 counters')

  if (!c) {
    fail(name, 'counters present', 'no counters recorded')
    continue
  }

  if (isIcons) {
    // 1 — the per-node cost, observed rather than assumed.
    if (c.iconRects !== nodes) {
      fail(name, 'forced layouts per icon', `expected ${nodes} measured spans, counted ${c.iconRects}`)
    }
    if (c.pngEncodes !== nodes) {
      fail(name, 'PNG encodes per icon', `expected ${nodes} toDataURL calls, counted ${c.pngEncodes}`)
    }
    // A memo would skip the font await on every hit, so the ceiling must be computable.
    if (c.fontLoads + c.fontReadies <= 0) {
      fail(name, 'font awaits observed', 'neither FontFaceSet.load nor fonts.ready was seen')
    }
  } else {
    // 4 — the no-icon control.
    for (const [k, v] of Object.entries(c)) {
      if (v !== 0) fail(name, 'no-icon control', `${k}=${v}, expected 0`)
    }
  }

  // 3 — the ceiling arithmetic, checked against the fixture's own ground truth.
  if (avoidable !== null && avoidable !== Math.max(0, nodes - (fx.ceiling.distinctKeys || 0))) {
    fail(name, 'ceiling arithmetic', `avoidable=${avoidable}`)
  }
  notes.push({
    fixture: name,
    mode: fx.meta?.mode,
    icons: nodes,
    distinctKeys: fx.ceiling?.distinctKeys ?? 0,
    measuredLayouts: c.iconRects,
    measuredEncodes: c.pngEncodes,
    measuredFontAwaits: c.fontLoads + c.fontReadies,
    avoidableIfMemoed: avoidable,
    effectPct: Number.isFinite(fx.candidate?.pct) ? Number(fx.candidate.pct.toFixed(2)) : null,
    selfContained: fx.selfContainedPass,
  })
}

console.log(`RS-A10 icon ceiling — ${browser} r${replicate} — ${path.relative(ROOT, file)}`)
console.table(notes)

if (failures.length) {
  console.error(`\nRS-A10 validator FAILED (${failures.length}):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\nCeiling is trustworthy. NO PERFORMANCE CLAIM — no memo ships on this branch.')