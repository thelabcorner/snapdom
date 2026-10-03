#!/usr/bin/env node
/**
 * F4 stage and closeout aggregation. This is the ONLY place the 1% question may be answered.
 *
 * Unit of observation: ONE LOG POINT PER FRESH HOSTED RUNNER. The interval is a Student-t 95% over
 * those points, with the same table and the same semantics as the calibrated R9 self-null, so the
 * two lanes cannot disagree about what a confidence interval means here. Per-call and per-block
 * rows are never pooled across VMs: doing so would treat one runner's 24 blocks as 24 independent
 * observations and shrink the interval by sqrt(replicates), which is the cheapest available way to
 * manufacture a 1% claim out of a 5% instrument.
 *
 * Stages, in order:
 *   --stage=chromium  the primary 8-runner stage. Decides REJECT_PARTITION / PROMISING / INCONCLUSIVE.
 *   --stage=engines   the cross-engine guard, only reached when chromium promised. Per engine,
 *                     independently. Never averaged together and never pooled with chromium.
 *   --stage=closeout  combines the two into one machine state. Zero evidence is never green.
 *
* Every stage is fail-closed: an absent cell, an inadmissible cell, a duplicate cell, a document
 * belonging to another run or identity drift yields INCOMPLETE_EVIDENCE or PROVENANCE_FAILURE and a
 * non-zero exit, never a verdict. Harvested documents go through lib/artifacts.mjs first, so a
 * retried cell supersedes its own earlier copy instead of being counted twice.
 *   node lane6-scratch/r10-shadow/aggregate.mjs --stage=chromium
 */
import fs from 'node:fs'
import path from 'node:path'
import { runnerCi, heterogeneity, median, pct, withinEnvelope } from './lib/stats.mjs'
import { auditCells, expectedCells } from './lib/matrix.mjs'
import { resolveStageCells } from './lib/artifacts.mjs'
import { decideStage, decideEngines, decideCloseout, STATES } from './lib/decide.mjs'

const ROOT = process.cwd()
const LANE = path.resolve(ROOT, 'lane6-scratch/r10-shadow')
const PREP = path.join(LANE, 'prepared.json')
const CLOSEOUT_DIR = path.join(LANE, 'closeout')
const EXIT = { [STATES.REJECT]: 0, [STATES.PROMISING]: 0, [STATES.INCONCLUSIVE]: 0, [STATES.PROMISING_TO_DESIGN]: 0, [STATES.INCOMPLETE]: 2, [STATES.PROVENANCE]: 1 }

const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}

const STAGE = arg('stage', 'chromium')
const INPUT = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r10-shadow/decisions'))
const OUT = path.resolve(ROOT, arg('out', 'lane6-scratch/r10-shadow/closeout/' + STAGE + '.json'))
const ENGINE_GUARD = ['firefox', 'webkit']

if (!fs.existsSync(PREP)) throw new Error('prepared.json missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
const identity = {
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
}
const runId = process.env.GITHUB_RUN_ID || null

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
}

function harvest(dir) {
  const docs = []
  if (!fs.existsSync(dir)) return docs
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^f4-(chromium|firefox|webkit)-r\d+\.json$/.test(name)) continue
    try { docs.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) } catch { /* unreadable cell */ }
  }
  return docs
}

/** Runner-level aggregate for one engine over its exact cell set. */
function aggregateEngine(engine, cells) {
  const samples = cells.map((key) => cells.get(key))
  const fixtures = {}
  for (const name of policy.fixtures) {
    const points = samples.map((d) => d.fixtures[name].effect.logPoint)
    const withinVars = samples.map((d) => d.fixtures[name].withinSe ** 2)
    const baseNullPoints = samples.map((d) => d.fixtures[name].baseNull.logPoint)
    const optNullPoints = samples.map((d) => d.fixtures[name].optNull.logPoint)
    const baseNull = runnerCi(baseNullPoints)
    const optNull = runnerCi(optNullPoints)
    const envelope = policy.instrument.outerNullEnvelopePct
    const noop = policy.noopFixtures.includes(name)
    fixtures[name] = {
      meta: samples[0].fixtures[name].meta,
      effect: runnerCi(points),
      baseNull,
      optNull,
      // The outer envelope applies to NULL quantities only: the two A/A nulls everywhere, plus the
      // no-op fixture's effect, whose two arms are the same code path. It never touches a shadow
      // fixture's effect, because 5% cannot say anything about 1%.
      nulls: {
        envelopePct: envelope,
        envelopePass: withinEnvelope(baseNull, envelope) && withinEnvelope(optNull, envelope),
        baseNullWorstPct: worstEnvelopePct(baseNull),
        optNullWorstPct: worstEnvelopePct(optNull),
      },
      noopEffectEnvelopePass: noop ? withinEnvelope(runnerCi(points), envelope) : null,
      heterogeneity: heterogeneity(points, withinVars),
      within: {
        medianBlockSd: median(samples.map((d) => d.fixtures[name].withinBlockSd)),
        medianSeLog: median(withinVars.map(Math.sqrt)),
      },
      diagnostics: {
        maxPairLogSd: Math.max(...samples.map((d) => d.fixtures[name].maxPairLogSd)),
        maxRawCov: Math.max(...samples.map((d) => d.fixtures[name].rawMaxCov)),
        byteParityAll: samples.every((d) => d.fixtures[name].byteParity === true),
        nullSlotBiasWorstPct: Math.max(...samples.map((d) => d.fixtures[name].nulls.worstSlotBiasPct)),
      },
      // Raw per-runner points are preserved verbatim. They are the evidence; the interval is a
      // summary of it.
      runnerPointsPct: points.map(pct),
      runnerLogPoints: points,
      runnerImageVersions: [...new Set(samples.map((d) => d.runner?.imageVersion).filter(Boolean))],
      browserVersions: [...new Set(samples.map((d) => d.browserVersion).filter(Boolean))],
      attempts: samples.map((d) => d.attemptIndex ?? 0),
    }
  }
  return { engine, replicates: samples.length, fixtures }
}

function worstEnvelopePct(q) {
  return Math.max(Math.abs(q.pct), ...q.ci95.map((v) => Math.abs(v)))
}

function failClosed(state, doc) {
  const summaryDoc = {
    schema: 'snapdom-r10-f4-wall-closeout-v2',
    state,
    complete: false,
    performanceClaim: false,
    note: 'Zero evidence can never read as a win. INCOMPLETE_EVIDENCE is a red lane, not a neutral one.',
    generatedAt: new Date().toISOString(),
    runId,
    stage: STAGE,
    policySha256: prepared.policySha256,
    candidateGitSha: prepared.candidateGitSha,
    bundleSha256: prepared.bundle.sha256,
    ...doc,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(summaryDoc, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'state=' + state + '\ncomplete=false\n')
  }
  summary('### F4 ' + STAGE + '\n\n**' + state + '** — no performance claim.\n\n')
    + (doc.reasons || []).map((r) => '- ' + r + '\n').join('')
  console.error(JSON.stringify(summaryDoc, null, 2))
  process.exit(EXIT[state])
}

const docs = harvest(INPUT)

/**
 * The harvested documents put through the retry rules before the matrix audit ever sees them.
 *
 * run_id-keyed names mean a rerun overwrites its own earlier copy rather than adding a second file,
 * so the common case is one document per cell. The rules still have to run: a document belonging to
 * another run is provenance drift rather than evidence, two documents claiming one cell at the same
 * attempt index are a conflict rather than a retry, and the highest attempt index supersedes.
 */
function stageCells(expected) {
  const resolved = resolveStageCells({ docs, expected, runId })
  if (resolved.ambiguous.length) {
    failClosed(STATES.PROVENANCE, {
      reasons: ['two files claim the same (runId, cell): ' + resolved.ambiguous.join(', ')],
    })
  }
  if (resolved.foreign.length) {
    failClosed(STATES.PROVENANCE, {
      reasons: ['documents belonging to another run: ' + resolved.foreign.join(', ')],
    })
  }
  return resolved
}

// ---- chromium stage ----------------------------------------------------------------------------
if (STAGE === 'chromium') {
  const expected = expectedCells(policy, ['chromium'])
  const cells = stageCells(expected)
  const audit = auditCells({ docs: cells.docs, expected, identity })
  if (audit.wrongIdentity.length) {
    failClosed(STATES.PROVENANCE, { reasons: ['cell identity drift: ' + audit.wrongIdentity.join(', ')] })
  }
  if (!audit.complete) {
    failClosed(STATES.INCOMPLETE, {
      reasons: ['matrix incomplete'],
      expectedSamples: expected.length,
      discoveredSamples: cells.docs.length,
      missing: cells.missing.length ? cells.missing : audit.missing,
      duplicate: [...new Set([...audit.duplicate, ...cells.duplicated])],
      unusable: audit.unusable,
      stray: audit.stray,
    })
  }
  const group = aggregateEngine('chromium', audit.byKey)
  const verdict = decideStage(group.fixtures, policy)
  const out = {
    schema: 'snapdom-r10-f4-wall-closeout-v2',
    state: verdict.state,
    complete: true,
    performanceClaim: false,
    stage: STAGE,
    stageMeaning: verdict.state === STATES.PROMISING
      ? 'CONTINUE_TO_ENGINES: the ceiling clears the practical floor on at least one splitting-free fixture.'
      : verdict.state === STATES.REJECT
        ? 'The cross-engine guard is skipped to save public runner minutes.'
        : 'The cross-engine guard is skipped and no replicates are added automatically.',
    generatedAt: new Date().toISOString(),
    runId,
    policySha256: prepared.policySha256,
    candidateGitSha: prepared.candidateGitSha,
    bundleSha256: prepared.bundle.sha256,
    thresholds: policy.thresholds,
    instrument: policy.instrument,
    replicates: group.replicates,
    fixtures: group.fixtures,
    reasons: verdict.reasons,
    detail: verdict.detail,
    rule: policy.decision,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'state=' + verdict.state + '\ncomplete=true\n')
  }
  const rows = Object.entries(group.fixtures).map(([name, fx]) =>
    '| ' + name + ' | ' + fx.effect.pct.toFixed(2) + '% | ['
    + fx.effect.ci95.map((v) => v.toFixed(2)).join(', ') + '] | '
    + (fx.effect.runnerSdLog * 100).toFixed(2) + '% | ' + (fx.heterogeneity.I2 * 100).toFixed(1) + '% |')
  summary([
    '### F4 chromium stage (8 fresh runners)',
    '',
    '**' + verdict.state + '** — ceiling measurement; a PROMISING result authorises DESIGNING the '
      + 'sound partition, never shipping it.',
    '',
    '- practical floor: ' + policy.thresholds.practicalFloorPct + '% (a preregistered practical floor, not a significance threshold)',
    '- outer null envelope: ±' + policy.instrument.outerNullEnvelopePct + '% from R9 calibration run 37097245291 (nulls only)',
    '',
    '| fixture | aggregate effect | runner 95% CI | runner SD(log) | I² |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    '',
  ].join('\n'))
  console.log(JSON.stringify({ state: verdict.state, replicates: group.replicates, reasons: verdict.reasons }, null, 2))
  process.exit(EXIT[verdict.state])
}

// ---- engine guard ------------------------------------------------------------------------------
if (STAGE === 'engines') {
  const expected = expectedCells(policy, ENGINE_GUARD)
  const picked = stageCells(expected)
  const audit = auditCells({ docs: picked.docs, expected, identity })
  if (audit.wrongIdentity.length) {
    failClosed(STATES.PROVENANCE, { reasons: ['cell identity drift: ' + audit.wrongIdentity.join(', ')] })
  }
  if (!audit.complete) {
    failClosed(STATES.INCOMPLETE, {
      reasons: ['engine matrix incomplete'],
      expectedSamples: expected.length,
      discoveredSamples: picked.docs.length,
      missing: picked.missing.length ? picked.missing : audit.missing,
      duplicate: [...new Set([...audit.duplicate, ...picked.duplicated])],
      unusable: audit.unusable,
      stray: audit.stray,
    })
  }
  const perEngine = {}
  for (const engine of ENGINE_GUARD) {
    const cells = new Map([...audit.byKey].filter(([k]) => k.startsWith(engine + ':')))
    perEngine[engine] = aggregateEngine(engine, cells).fixtures
  }
  const verdict = decideEngines(perEngine, policy)
  const out = {
    schema: 'snapdom-r10-f4-wall-closeout-v2',
    state: verdict.state,
    complete: true,
    performanceClaim: false,
    stage: STAGE,
    stageMeaning: 'Per-engine aggregates, judged independently. Engines are never averaged together.',
    generatedAt: new Date().toISOString(),
    runId,
    policySha256: prepared.policySha256,
    candidateGitSha: prepared.candidateGitSha,
    bundleSha256: prepared.bundle.sha256,
    thresholds: policy.thresholds,
    instrument: policy.instrument,
    engines: perEngine,
    perEngineStates: verdict.perEngine,
    reasons: verdict.reasons,
    rule: policy.decision,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'state=' + verdict.state + '\ncomplete=true\n')
  }
  summary('### F4 cross-engine guard\n\n**' + verdict.state + '** — per engine, independently.\n\n')
    + Object.entries(verdict.perEngine).map(([e, v]) => '- ' + e + ': ' + v.state + '\n').join('')
  console.log(JSON.stringify({ state: verdict.state, perEngine: verdict.perEngine }, null, 2))
  process.exit(EXIT[verdict.state])
}

// ---- closeout ----------------------------------------------------------------------------------
if (STAGE === 'closeout') {
  const readStage = (stage) => {
    const p = path.join(CLOSEOUT_DIR, stage + '.json')
    if (!fs.existsSync(p)) return null
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
  }
  const chromium = readStage('chromium')
  const engines = readStage('engines')
  const verdict = decideCloseout({ chromium, engines, policy })
  const out = {
    schema: 'snapdom-r10-f4-wall-closeout-v2',
    state: verdict.state,
    complete: Boolean(chromium && chromium.complete) && (verdict.state !== STATES.INCOMPLETE),
    performanceClaim: false,
    stage: STAGE,
    generatedAt: new Date().toISOString(),
    runId,
    policySha256: prepared.policySha256,
    candidateGitSha: prepared.candidateGitSha,
    bundleSha256: prepared.bundle.sha256,
    thresholds: policy.thresholds,
    instrument: policy.instrument,
    chromium: chromium && {
      state: chromium.state, replicates: chromium.replicates, reasons: chromium.reasons, fixtures: chromium.fixtures,
    },
    engines: engines && {
      state: engines.state, perEngineStates: engines.perEngineStates, reasons: engines.reasons, engines: engines.engines,
    },
    engineStates: verdict.engineStates,
    reasons: verdict.reasons,
    rule: policy.decision,
    interpretation: verdict.state === STATES.PROMISING_TO_DESIGN
      ? 'The ceiling clears the preregistered practical floor on Chromium and the cross-engine guard agrees. This authorises BUILDING the sound per-root partition. It is not a promotion and not a production claim.'
      : verdict.state === STATES.REJECT
        ? 'The ceiling does not earn the architecture work. The per-root partition is rejected on this evidence.'
        : verdict.state === STATES.INCONCLUSIVE
          ? 'The present instrument cannot separate the ceiling from the practical floor. Replicates are not added automatically and no further architecture work is authorised.'
          : 'The evidence is incomplete or its provenance failed. Nothing is claimed.',
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'state=' + verdict.state + '\ncomplete=' + out.complete + '\n')
  }
  summary('### F4 closeout\n\n**' + verdict.state + '**\n\n' + out.interpretation + '\n')
  console.log(JSON.stringify({ state: verdict.state, reasons: verdict.reasons }, null, 2))
  process.exit(EXIT[verdict.state])
}

throw new Error('unknown --stage=' + STAGE)