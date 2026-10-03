#!/usr/bin/env node
/**
 * RS-A10 icon-ceiling cross-engine aggregate.
 *
 * Aggregates the per-replicate ceiling artifacts into the Amdahl statement the audit needs:
 * what share of a capture the icon path is, and what a PERFECT memo of it would therefore be
 * worth. Reported per engine because the forced layout and the PNG encode are both engine work.
 *
 * The derivation, using only fixtures the lane already runs:
 *   T0  = no-icon-120            — capture cost with zero icon work
 *   Td  = icon-distinct-120      — N icons, ZERO dedup ceiling
 *   Tr  = icon-repeat-120        — N icons, N-1 of them avoidable
 *   perIconCost  = (Td - T0) / N
 *   memoableShare= (Tr - T0) / Tr
 *   idealSpeedup = 1 / (1 - memoableShare)      — i.e. an infinitely fast icon path
 *
 * `idealSpeedup` is a CEILING on the whole idea, not an estimate of it. The sound alternative
 * (key on the measured rect) removes only the PNG encode, which is the smaller of the two
 * engine costs, so its realisable share is strictly below this number and is NOT measured here.
 * Say so rather than implying otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}

const inputDir = path.resolve(ROOT, arg('input-dir') || 'lane6-scratch/r10/inputs')
const N = 120

const median = (xs) => {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return NaN
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function collect(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...collect(abs)); continue }
    if (entry.name.startsWith('icon-ceiling-') && entry.name.endsWith('.json')) out.push(abs)
  }
  return out
}

if (!fs.existsSync(inputDir)) {
  console.error(`RS-A10 summarizer: input dir missing: ${path.relative(ROOT, inputDir)}`)
  process.exit(1)
}
const files = collect(inputDir)
if (!files.length) {
  console.error('RS-A10 summarizer: no ceiling artifacts found')
  process.exit(1)
}

/** mean slot1 ms for one fixture across every replicate artifact. */
const timeByFixture = (reports, name) => {
  const rows = reports
    .map((r) => r.layouts?.effectForward?.[name]?.slot1?.mean)
    .filter(Number.isFinite)
  return median(rows)
}

const byBrowser = new Map()
let allGatesHeld = true

for (const file of files) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const browser = report.provenance?.browser?.actualName || 'unknown'
  if (!byBrowser.has(browser)) byBrowser.set(browser, [])
  byBrowser.get(browser).push(report)

  // Defense in depth: the per-replicate validator already gated these, but the closeout must
  // not report a trustworthy ceiling if any contributing artifact failed its own gates.
  for (const [name, fx] of Object.entries(report.fixtures || {})) {
    if (fx.selfContainedPass !== true || !fx.parity || fx.countersParity !== true) {
      allGatesHeld = false
      console.error(`RS-A10 summarizer: ${browser}/${name} failed its gates`)
    }
  }
}

const rows = []
for (const [browser, reports] of [...byBrowser].sort()) {
  const t0 = timeByFixture(reports, 'no-icon-120')
  const td = timeByFixture(reports, 'icon-distinct-120')
  const tr = timeByFixture(reports, 'icon-repeat-120')

  const perIconCost = Number.isFinite(td) && Number.isFinite(t0) ? (td - t0) / N : NaN
  const memoableShare = Number.isFinite(tr) && Number.isFinite(t0) && tr > 0 ? (tr - t0) / tr : NaN
  const idealSpeedup = Number.isFinite(memoableShare) && memoableShare < 1 ? 1 / (1 - memoableShare) : NaN

  const repeat = reports[0]?.fixtures?.['icon-repeat-120']?.ceiling
  const distinct = reports[0]?.fixtures?.['icon-distinct-120']?.ceiling
  const probeCounters = reports[0]?.fixtures?.['icon-repeat-120']?.counters

  rows.push({
    engine: browser,
    replicates: reports.length,
    t0_noIcons_ms: Number.isFinite(t0) ? Number(t0.toFixed(2)) : null,
    td_distinct_ms: Number.isFinite(td) ? Number(td.toFixed(2)) : null,
    tr_repeat_ms: Number.isFinite(tr) ? Number(tr.toFixed(2)) : null,
    perIconCost_ms: Number.isFinite(perIconCost) ? Number(perIconCost.toFixed(4)) : null,
    memoableShare_pct: Number.isFinite(memoableShare) ? Number((memoableShare * 100).toFixed(1)) : null,
    idealSpeedup_pct: Number.isFinite(idealSpeedup) ? Number(((idealSpeedup - 1) * 100).toFixed(1)) : null,
    observedLayouts: probeCounters?.iconRects ?? null,
    observedEncodes: probeCounters?.pngEncodes ?? null,
    avoidableIfMemoed: repeat?.avoidableLayouts ?? null,
    distinctCeiling: distinct?.avoidableLayouts ?? null,
  })
}

const summary = {
  schema: 'snapdom-r10-icon-ceiling-summary-v1',
  generatedAt: new Date().toISOString(),
  artifacts: files.length,
  allGatesHeld,
  iconsPerFixture: N,
  derivation:
    'perIconCost=(T_distinct-T_none)/N; memoableShare=(T_repeat-T_none)/T_repeat; idealSpeedup=1/(1-memoableShare)',
  claim: 'CEILING ONLY — no memo ships on this branch (docs/perf/RS_A10_ICON_RASTER_MEMO.md). The sound alternative removes only the PNG encode, so its realisable share is strictly below idealSpeedup and is not measured here.',
  rows,
}

const outPath = path.join(ROOT, 'lane6-scratch/r10/summary.json')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n')

console.log('### RS-A10 icon raster ceiling')
console.log()
console.log(`- artifacts: \`${files.length}\`  ·  gates held: \`${allGatesHeld}\``)
console.log()
console.log('| engine | reps | per-icon cost (ms) | memoable share | ideal speedup (ceiling) | layouts observed | avoidable if memoed |')
console.log('|---|---:|---:|---:|---:|---:|---:|')
for (const r of rows) {
  console.log(
    `| ${r.engine} | ${r.replicates} | ${r.perIconCost_ms ?? '—'} | ${r.memoableShare_pct != null ? r.memoableShare_pct + '%' : '—'} | ` +
    `${r.idealSpeedup_pct != null ? '+' + r.idealSpeedup_pct + '%' : '—'} | ${r.observedLayouts ?? '—'} | ${r.avoidableIfMemoed ?? '—'} |`
  )
}
console.log()
console.log('**CEILING ONLY. NO PERFORMANCE CLAIM.** The memo was not built: its key aliases live ambient CSS on the measuring span and cannot be made exact. See `docs/perf/RS_A10_ICON_RASTER_MEMO.md`.')
console.log()
console.log(`_artifact: \`lane6-scratch/r10/summary.json\`_`)

if (!allGatesHeld) process.exit(1)