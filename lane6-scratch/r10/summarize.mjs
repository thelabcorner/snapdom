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
const EXPECTED_BROWSERS = ['chromium', 'firefox', 'webkit']
const EXPECTED_REPLICATES = [0, 1, 2, 3]
const expectedCells = new Set(
  EXPECTED_BROWSERS.flatMap((browser) => EXPECTED_REPLICATES.map((replicate) => `${browser}:${replicate}`))
)

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
const observedCells = new Map()
const candidateShas = new Set()
const bundleShas = new Set()

for (const file of files) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const match = path.basename(file).match(/^icon-ceiling-(chromium|firefox|webkit)-r([0-3])\.json$/)
  if (!match) {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: unexpected evidence filename ${path.basename(file)}`)
    continue
  }
  const fileBrowser = match[1]
  const replicate = Number(match[2])
  const cellKey = `${fileBrowser}:${replicate}`
  if (observedCells.has(cellKey)) {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: duplicate evidence cell ${cellKey}`)
    continue
  }
  observedCells.set(cellKey, file)

  const browser = report.provenance?.browser?.actualName || 'unknown'
  if (report.schema !== 'snapdom-r9-hosted-bench-v1') {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: ${cellKey} has unexpected schema ${report.schema}`)
  }
  if (browser !== fileBrowser) {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: ${cellKey} measured browser ${browser}`)
  }
  if (report.provenance?.protocol?.suite !== 'icon' || report.provenance?.protocol?.mode !== 'option-pair') {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: ${cellKey} has wrong suite/mode provenance`)
  }
  const candidateSha = report.provenance?.git?.candidateSha
  const baselineSha = report.provenance?.git?.baselineSha
  const candidateBundle = report.provenance?.bundles?.candidate?.sha256
  const baselineBundle = report.provenance?.bundles?.baseline?.sha256
  if (!candidateSha || candidateSha !== baselineSha) {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: ${cellKey} is not a same-git self comparison`)
  } else {
    candidateShas.add(candidateSha)
  }
  if (!candidateBundle || candidateBundle !== baselineBundle) {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: ${cellKey} is not a same-bundle self comparison`)
  } else {
    bundleShas.add(candidateBundle)
  }

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

const missingCells = [...expectedCells].filter((key) => !observedCells.has(key))
if (missingCells.length) {
  allGatesHeld = false
  console.error(`RS-A10 summarizer: missing preregistered cells: ${missingCells.join(', ')}`)
}
if (observedCells.size !== expectedCells.size) {
  allGatesHeld = false
  console.error(`RS-A10 summarizer: observed ${observedCells.size}/${expectedCells.size} unique cells`)
}
if (candidateShas.size !== 1) {
  allGatesHeld = false
  console.error(`RS-A10 summarizer: expected one measured git identity, saw ${candidateShas.size}`)
}
if (bundleShas.size !== 1) {
  allGatesHeld = false
  console.error(`RS-A10 summarizer: expected one measured bundle identity, saw ${bundleShas.size}`)
}
for (const browser of EXPECTED_BROWSERS) {
  if ((byBrowser.get(browser) || []).length !== EXPECTED_REPLICATES.length) {
    allGatesHeld = false
    console.error(`RS-A10 summarizer: ${browser} does not have exactly 4 usable reports`)
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
  expectedCells: expectedCells.size,
  observedCells: observedCells.size,
  complete: observedCells.size === expectedCells.size && missingCells.length === 0,
  candidateGitSha: candidateShas.size === 1 ? [...candidateShas][0] : null,
  bundleSha256: bundleShas.size === 1 ? [...bundleShas][0] : null,
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