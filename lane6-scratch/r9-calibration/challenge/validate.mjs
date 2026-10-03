#!/usr/bin/env node
/**
 * Turn one hosted challenge artifact into one RUNNER-LEVEL decision document.
 *
 * Two jobs, both load-bearing:
 *
 * 1. PROVENANCE AND COMPLETENESS. Every hash, the exact git SHA, the run id, the job, the runner
 *    image and the browser identity are re-checked. A missing lane, a missing fixture, a raw-parity
 *    failure or a timed-call count that does not match the declared budget makes this cell
 *    INCOMPLETE_EVIDENCE. Zero evidence must never look like a successful benchmark.
 *
 * 2. THE CORRECTED DIAGNOSTICS. The ledger's section 6 lists three defects in the published
 *    calibration diagnostics. They are not silently reproduced here:
 *
 *    - `rawSlotBias` averaged both pages of a pair with the SAME sign, so it reported
 *      1/2 (mF + mR) where `crossoverEffect` computes 1/2 (mF - mR) — a quantity that differs by
 *      exactly mR, the very ratio the diagnostic exists to exclude. Here `crossoverSlotBias` uses
 *      the estimator's own sign convention, `rawPageRatio` publishes BOTH pages' own ratios
 *      separately, and `legacySameSignSlotBias` is retained only so the discrepancy stays visible.
 *    - `slotInteraction` was a difference of same-sign page averages and was therefore structurally
 *      blind to any pure slot effect. It is not published. In its place, `positionPremiumLog` is
 *      measured directly from the retained per-call rows as mean(log ms at first of pair) minus
 *      mean(log ms at second of pair): the position-conditional cost whose size the section 4
 *      mechanism needs and which the first calibration could not recover at all.
 *    - `withinSe` was read off the page-difference block series, which in a self-null is
 *      1/2 (v_forward - v_reverse) and is not the variance of either observation. Here
 *      `singlePageBlockSdLog` and `withinSeLog` come from ONE page's own per-block ratio series.
 *
 * The decision document deliberately carries NO per-call and NO per-page rows: it is the only thing
 * the closeout aggregates, and `assertRunnerLevelOnly` is applied to it before it is written.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { assertRunnerLevelOnly } from './algebra/aggregate-contract.mjs'
import { EQUAL_BUDGET_PAIRS, laneBudget, totalTimedCalls } from './algebra/call-budget.mjs'

const ROOT = process.cwd()
const CHAL = path.resolve(ROOT, 'lane6-scratch/r9-calibration/challenge')
const PREP = path.join(CHAL, 'prepared.json')
const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const sd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

const finish = (doc, code = 0) => {
  const dir = path.join(CHAL, 'decisions')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `topology-${doc.browser}-r${doc.replicate}.json`)
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
  console.log(JSON.stringify(doc, null, 2))
  process.exit(code)
}

if (!fs.existsSync(PREP)) throw new Error('prepared.json missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
const browser = String(arg('browser', policy.browser)).toLowerCase()
const replicate = Number(arg('replicate'))
const profile = arg('profile', 'primary')
const gateExit = Number(arg('gate-exit', '1'))
const reportPath = path.resolve(ROOT, 'lane6-scratch/r9/results', `topology-${browser}-r${replicate}.json`)

const baseDoc = {
  schema: 'snapdom-r9-hosted-topology-challenge-decision-v1',
  browser,
  replicate,
  profile,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
  github: {
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    job: process.env.GITHUB_JOB || null,
  },
}

if (gateExit === 3) finish({ ...baseDoc, state: 'INCOMPLETE_EVIDENCE', usable: false, reason: 'AMBIENT_BLOCKED' }, 2)
if (gateExit !== 0) finish({ ...baseDoc, state: 'HARNESS_FAILED', usable: false, reason: `challenge exit ${gateExit}` }, 1)
if (!fs.existsSync(reportPath)) finish({ ...baseDoc, state: 'INCOMPLETE_EVIDENCE', usable: false, reason: 'MISSING_REPORT' }, 2)

let report
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) }
catch (e) { finish({ ...baseDoc, state: 'PROVENANCE_FAILURE', usable: false, reason: `report parse: ${e.message}` }, 1) }

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------
const hard = []
const p = report.provenance || {}
const rp = p.protocol || {}
if (report.schema !== 'snapdom-r9-hosted-topology-challenge-v1') hard.push('report schema')
if (report.promotable !== false || report.performanceClaim !== false) hard.push('challenge must be marked non-promotable')
if (p.github?.actions !== true || p.github?.repository !== policy.repository) hard.push('GitHub Actions repository provenance')
if (!p.github?.runId || p.github.runId !== process.env.GITHUB_RUN_ID) hard.push('run id provenance')
if (!p.github?.job || p.github.job !== process.env.GITHUB_JOB) hard.push('job provenance')
if (p.runner?.os !== 'Linux' || !p.runner?.name || !p.runner?.imageOs || !p.runner?.imageVersion) hard.push('hosted runner provenance')
if (p.browser?.requested !== browser || p.browser?.actualName !== browser || !p.browser?.actualVersion) hard.push('browser identity')
if (p.browser?.playwrightVersion !== policy.playwrightVersion) hard.push('Playwright version')
if (p.code?.manifestSha256 !== prepared.policySha256) hard.push('policy identity')
for (const [key, field] of [
  ['lane6-scratch/r9/protocol.mjs', 'protocol'],
  ['lane6-scratch/atlas/profiler/fixtures.mjs', 'fixtureSource'],
  ['lane6-scratch/r9-calibration/challenge/bench-r9-topology.mjs', 'harness'],
  ['lane6-scratch/r9-calibration/challenge/algebra/call-budget.mjs', 'laneAlgebra'],
]) {
  if (p.code?.[field]?.sha256 !== prepared.measurementFiles[key]) hard.push(`measurement hash ${key}`)
}
if (p.git?.candidateSha !== prepared.candidateGitSha) hard.push('git SHA identity')
if (p.bundle?.sha256 !== prepared.bundle.sha256) hard.push('bundle identity')
if (rp.profile !== profile) hard.push(`profile identity (${rp.profile})`)
if (rp.policySha256 !== prepared.policySha256) hard.push('protocol policy identity')
const expectedSeed = (policy.baseSeed + replicate * 104729) >>> 0
if (rp.seed !== expectedSeed) hard.push('seed')
if (JSON.stringify(rp.fixtureNames) !== JSON.stringify(policy.fixtures)) hard.push('fixture manifest/order')
if (JSON.stringify(rp.lanes) !== JSON.stringify(policy.lanes)) hard.push('lane manifest/order')
if (rp.bootstrap !== policy.bootstrap) hard.push('bootstrap')
if (JSON.stringify(rp.positiveControl) !== JSON.stringify(policy.positiveControl)) hard.push('positive control identity')
if (hard.length) finish({ ...baseDoc, state: 'PROVENANCE_FAILURE', usable: false, reasons: hard }, 1)

// ---------------------------------------------------------------------------
// structural completeness + corrected diagnostics
// ---------------------------------------------------------------------------
const invalid = []
const sampling = policy.sampling[profile]
const totals = totalTimedCalls(sampling, policy.fixtures.length)
const fixtures = {}

for (const fixture of policy.fixtures) {
  const fx = report.fixtureResults?.[fixture]
  if (!fx) { invalid.push(`${fixture}: missing from the artifact`); continue }
  if (Object.keys(fx.lanes).length !== policy.lanes.length) invalid.push(`${fixture}: wrong lane count`)
  const perLane = {}

  for (const lane of policy.lanes) {
    const L = fx.lanes[lane]
    const declared = laneBudget(lane, sampling)
    if (!L) { invalid.push(`${fixture}/${lane}: lane missing`); continue }
    if (L.executedTimedCalls !== declared.timedCalls) {
      invalid.push(`${fixture}/${lane}: executed ${L.executedTimedCalls} timed calls, budget declares ${declared.timedCalls}`)
    }
    if (L.pages.length !== declared.pages) invalid.push(`${fixture}/${lane}: ${L.pages.length} pages, budget declares ${declared.pages}`)
    if (L.canonicalOrder.length !== declared.layouts) invalid.push(`${fixture}/${lane}: canonical layout list is not ${declared.layouts} long`)

    // The reversed lane must be an EXACT reversal of the unreversed one, and it must be the same
    // list that fed creation, warm and rotation.
    const reversed = policy.lanes.find((l) => l === 'current6Reversed')
    if (lane === 'current6Reversed') {
      const base = fx.lanes.current6?.canonicalOrder
      if (!base || JSON.stringify(L.canonicalOrder) !== JSON.stringify(base.slice().reverse())) {
        invalid.push(`${fixture}/${lane}: canonical list is not the exact reverse of current6`)
      }
    }
    if (lane === 'current6' && reversed) {
      const rev = fx.lanes[reversed]
      if (rev && JSON.stringify(rev.canonicalOrder) !== JSON.stringify(L.canonicalOrder.slice().reverse())) {
        invalid.push(`${fixture}/${lane}: reversed lane does not reverse this lane's canonical list`)
      }
    }
    for (const meta of L.pages) {
      if (!meta.oracle?.parity) invalid.push(`${fixture}/${lane}: raw parity failed on ${meta.layout}#${meta.page}`)
      if (L.identityCanary && !meta.physicalIdentityShared) {
        invalid.push(`${fixture}/${lane}: canary page ${meta.page} did not share one module URL across both slots`)
      }
    }
    if (L.pageRows.length !== declared.pages * declared.blocks) {
      invalid.push(`${fixture}/${lane}: ${L.pageRows.length} page rows, expected ${declared.pages * declared.blocks}`)
    }
    for (const row of L.pageRows) {
      if (!Number.isFinite(row.logRatio) || !(row.slot1 > 0) || !(row.slot2 > 0)) {
        invalid.push(`${fixture}/${lane}: non-finite block ratio`)
        break
      }
      if (row.nCalls !== 2 * declared.batch) {
        invalid.push(`${fixture}/${lane}: page block spent ${row.nCalls} calls, expected ${2 * declared.batch}`)
        break
      }
    }

    // Corrected slot diagnostics. Both pages' OWN ratios first, then the two sign conventions.
    const rowsByLayout = new Map()
    for (const row of L.pageRows) {
      if (!rowsByLayout.has(row.layout)) rowsByLayout.set(row.layout, [])
      rowsByLayout.get(row.layout).push(row)
    }
    const pageRatio = (layout) => {
      const rows = rowsByLayout.get(layout) || []
      return mean(rows.map((r) => Math.log(r.slot2 / r.slot1)))
    }
    const singlePage = (layout) => {
      const rows = rowsByLayout.get(layout) || []
      const s = sd(rows.map((r) => r.logRatio))
      return { blockSdLog: s, seLog: s / Math.sqrt(Math.max(1, rows.length)) }
    }

    const cells = L.cells.cells ?? null
    const doses = L.cells.doses ?? null
    // A cell name maps to a different physical layout in the two topologies: the current rig splits
    // each control pair across two pages, the blocked rig keeps one layout with several pages.
    const layoutOfCell = (cellName) => {
      if (L.topology === 'blocked') return cellName === 'candidate' ? 'effect' : cellName
      if (cellName === 'baseNull') return 'baseNullForward'
      if (cellName === 'optNull') return 'optNullForward'
      return 'effectForward'
    }
    const laneOut = {
      lane,
      topology: L.topology,
      role: L.role,
      treatmentSensitive: L.treatmentSensitive,
      identityCanary: L.identityCanary,
      executedTimedCalls: L.executedTimedCalls,
      declaredTimedCalls: declared.timedCalls,
      wallClockMs: L.wallClockMs,
      acquireMs: L.acquireMs,
      pages: L.pages.length,
      warmToFirstSampleGapMsMedian: (() => {
        const xs = L.pages.map((m) => m.warmToFirstSampleGapMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
        return xs.length ? xs[xs.length >> 1] : null
      })(),
      maxAbsBlockLogRatio: L.maxAbsBlockLogRatio,
      // position-conditional cost, measured from the retained per-call rows
      positionPremiumLog: L.diagnostics.positionPremiumLog,
      positionPremiumPct: L.diagnostics.positionPremiumPct,
      positionLogSd: L.diagnostics.positionLogSd,
      captureMsArmMean: L.diagnostics.captureMsArmMean,
      captureMsArmDeltaMs: L.diagnostics.captureMsArmDeltaMs,
      injectedCalls: L.diagnostics.injectedCalls,
      injectedArmMsMean: L.diagnostics.injectedArmMsMean,
      controlArmInjectMsMax: L.diagnostics.controlArmInjectMsMax,
      cells: cells
        ? Object.fromEntries(Object.entries(cells).map(([name, c]) => [name, {
          logPoint: c.logPoint, pct: c.pct, ci95: c.ci95,
          withinSeLog: singlePage(layoutOfCell(name)).seLog,
        }]))
        : null,
      doses: doses
        ? Object.fromEntries(Object.entries(doses).map(([name, d]) => [name, {
          iterations: d.iterations,
          treatment: { logPoint: d.treatment.logPoint, pct: d.treatment.pct, ci95: d.treatment.ci95 },
          treatmentNull: { logPoint: d.treatmentNull.logPoint, pct: d.treatmentNull.pct, ci95: d.treatmentNull.ci95 },
          recovery: { logPoint: d.recovery.logPoint, pct: d.recovery.pct },
        }]))
        : null,
      pageRatios: Object.fromEntries([...rowsByLayout.keys()].map((l) => [l, pageRatio(l)])),
      // A BLOCKED lane's controls live on a single layout, so its single-page SE is direct.
      singlePageBlockSdLog: L.topology === 'blocked' && rowsByLayout.has('baseNull')
        ? singlePage('baseNull').blockSdLog
        : null,
      crossoverSlotBias: L.topology === 'current' && rowsByLayout.has('baseNullForward')
        ? {
          baseNull: (pageRatio('baseNullForward') - pageRatio('baseNullReverse')) / 2,
          optNull: (pageRatio('optNullForward') - pageRatio('optNullReverse')) / 2,
          candidate: (pageRatio('effectForward') - pageRatio('effectReverse')) / 2,
        }
        : null,
      legacySameSignSlotBias: L.topology === 'current' && rowsByLayout.has('baseNullForward')
        ? {
          baseNull: (pageRatio('baseNullForward') + pageRatio('baseNullReverse')) / 2,
          optNull: (pageRatio('optNullForward') + pageRatio('optNullReverse')) / 2,
        }
        : null,
    }
    perLane[lane] = laneOut
  }

  // The positive control must have actually landed on one arm and only one arm.
  for (const lane of ['treatmentCurrent', 'treatmentBlocked']) {
    const L = perLane[lane]
    if (!L) continue
    if (!(L.injectedArmMsMean > 0)) invalid.push(`${fixture}/${lane}: injected arm never spent injected time`)
    if (!(L.controlArmInjectMsMax === 0)) invalid.push(`${fixture}/${lane}: control arm spent injected time (${L.controlArmInjectMsMax}ms)`)
  }

  fixtures[fixture] = { lanes: perLane, timedCalls: Object.fromEntries(policy.lanes.map((l) => [l, perLane[l]?.executedTimedCalls ?? 0])) }
}

const pairs = (report.runner?.equalBudgetPairsVerified || []).map((r) => ({ ...r, equal: r.executed[0] === r.executed[1] }))
if (pairs.length !== EQUAL_BUDGET_PAIRS.length) {
  invalid.push(`equal-budget pair count is ${pairs.length}, expected ${EQUAL_BUDGET_PAIRS.length}`)
}
for (const p2 of pairs) if (!p2.equal) invalid.push(`equal-cost claim violated on the artifact: ${p2.pair.join(' vs ')} = ${p2.executed.join('/')}`)
const executedTotal = Object.values(fixtures).reduce(
  (a, f) => a + Object.values(f.timedCalls).reduce((x, y) => x + y, 0), 0)
if (executedTotal !== totals.total) {
  invalid.push(`executed timed calls across the runner are ${executedTotal}, budget declares ${totals.total}`)
}

if (invalid.length) finish({ ...baseDoc, state: 'CHALLENGE_INVALID', usable: false, reasons: invalid }, 1)

const decision = {
  ...baseDoc,
  state: 'CHALLENGE_SAMPLE',
  usable: true,
  reportSha256: shaFile(reportPath),
  runner: p.runner,
  browserVersion: p.browser.actualVersion,
  laneOrder: report.laneOrder,
  seed: rp.seed,
  budget: {
    perLane: Object.fromEntries(policy.lanes.map((l) => [l, laneBudget(l, sampling)])),
    equalBudgetPairs: pairs,
    executedTimedCallsTotal: executedTotal,
    declaredTimedCallsTotal: totals.total,
  },
  fixtures,
}
assertRunnerLevelOnly(decision)
finish(decision, 0)
