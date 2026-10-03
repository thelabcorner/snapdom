#!/usr/bin/env node
/**
 * F4 per-cell admissibility gate. Emits exactly three states and nothing else:
 *
 *   SAMPLE_VALID         this runner produced admissible evidence for its cell
 *   INCOMPLETE_EVIDENCE  the cell yielded nothing usable (blocked settle, blocked ambient gate,
 *                        harness failure, absent report, unstable runner, an A/A raw control outside
 *                        the outer envelope, or arms that are not byte-comparable)
 *   PROVENANCE_FAILURE   policy, bundle, measurement-hash, fixture-identity or runner-identity drift
 *
 * It deliberately does NOT answer the 1% question, and there is no code path here that can. A
 * single VM has no business setting a one-percent floor: that verdict is a property of the
 * runner-level aggregate in aggregate.mjs, and a per-cell verdict is exactly what made v1
 * inadmissible. Nothing below computes an effect comparison against the floor, and nothing below
 * emits a verdict field.
 *
 * What it DOES enforce, all of it per-runner and all of it about whether the observation can be
 * trusted at all:
 *   - the measurement hashes, bundle, policy and fixture manifest this run was frozen with;
 *   - finite, index-aligned observation blocks and positive timing rows;
 *   - a gross paired-log-ratio SD ceiling, kept separate from the outer envelope;
 *   - the A/A raw controls, recomputed here from the raw rows rather than trusted from the
 *     harness summary, so a tampered summary cannot hide a slot bias;
 *   - exact byte parity between the arms wherever the policy requires it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const LANE = path.resolve(ROOT, 'lane6-scratch/r10-shadow')
const PREP = path.join(LANE, 'prepared.json')
const SCHEMA = 'snapdom-r10-f4-wall-sample-v2'
const STATES = { VALID: 'SAMPLE_VALID', INCOMPLETE: 'INCOMPLETE_EVIDENCE', PROVENANCE: 'PROVENANCE_FAILURE' }
const EXIT = { [STATES.VALID]: 0, [STATES.INCOMPLETE]: 2, [STATES.PROVENANCE]: 1 }
const ENGINE_OFFSET = { chromium: 0, firefox: 1000003, webkit: 2000003 }
const LAYOUTS = ['effectForward', 'effectReverse', 'baseNullForward', 'baseNullReverse', 'optNullForward', 'optNullReverse']

const arg = (name, fallback = '') => {
  const p = `--${name}=`
  const hit = process.argv.find((x) => x.startsWith(p))
  return hit ? hit.slice(p.length) : fallback
}
const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const variance = (xs) => (xs.length < 2 ? NaN : (() => {
  const m = mean(xs)
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
})())
const toPct = (logRatio) => (Math.exp(logRatio) - 1) * 100

const browser = String(arg('browser')).toLowerCase()
const replicate = Number(arg('replicate'))
const gateExit = Number(arg('gate-exit', '1'))
const file = 'f4-' + browser + '-r' + replicate + '.json'

function emit(doc, state) {
  const out = path.join(LANE, 'decisions', file)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const payload = { ...doc, schema: SCHEMA, state, usable: state === STATES.VALID }
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n')
  console.log(JSON.stringify({
    file: path.relative(ROOT, out).replaceAll('\\', '/'),
    state,
    usable: payload.usable,
    reasons: payload.reasons || [],
  }, null, 2))
  process.exit(EXIT[state])
}

if (!fs.existsSync(PREP)) throw new Error('prepared.json missing')
const prepared = JSON.parse(fs.readFileSync(PREP, 'utf8'))
const policy = prepared.policy
const reportPath = path.resolve(LANE, 'results', file)
const base = {
  browser,
  replicate,
  // Attempt travels in the payload, never in a filename: see lib/artifacts.mjs.
  runId: process.env.GITHUB_RUN_ID || null,
  attempt: process.env.GITHUB_RUN_ATTEMPT || null,
  attemptIndex: Number(process.env.GITHUB_RUN_ATTEMPT || 0),
  job: process.env.GITHUB_JOB || null,
  policySha256: prepared.policySha256,
  candidateGitSha: prepared.candidateGitSha,
  bundleSha256: prepared.bundle.sha256,
}

// A blocked settle (exit 3) and a blocked ambient gate (exit 3) mean the same thing here: this
// cell observed nothing. Both are INCOMPLETE, never a performance statement.
if (gateExit === 3) emit({ ...base, reasons: ['AMBIENT_OR_SETTLE_BLOCKED'] }, STATES.INCOMPLETE)
if (gateExit !== 0) emit({ ...base, reasons: ['BENCH_FAILED exit ' + gateExit] }, STATES.INCOMPLETE)
if (!fs.existsSync(reportPath)) emit({ ...base, reasons: ['MISSING_REPORT'] }, STATES.INCOMPLETE)

let report
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) }
catch (e) { emit({ ...base, reasons: ['REPORT_PARSE ' + e.message] }, STATES.PROVENANCE) }

// ---- provenance ---------------------------------------------------------------------------------
const hard = []
const p = report.provenance || {}
if (report.schema !== 'snapdom-r10-f4-wall-report-v2') hard.push('report schema')
if (p.github?.actions !== true || p.github?.repository !== policy.repository) hard.push('GitHub Actions repository provenance')
if (!p.github?.runId || p.github.runId !== process.env.GITHUB_RUN_ID) hard.push('run id provenance')
if (!p.github?.job || p.github.job !== process.env.GITHUB_JOB) hard.push('job provenance')
if (!p.runner?.name || !p.runner?.imageOs || !p.runner?.imageVersion || p.runner?.os !== 'Linux') hard.push('hosted runner provenance')
if (p.browser?.requested !== browser || p.browser?.actualName !== browser || !p.browser?.actualVersion) hard.push('browser identity')
if (p.browser?.playwrightVersion !== policy.playwrightVersion) hard.push('Playwright version')
for (const [rel, field] of [
  ['lane6-scratch/r10-shadow/bench-f4.mjs', 'harness'],
  ['lane6-scratch/r9/protocol.mjs', 'protocol'],
  ['__tests__/helpers/shadowCards.js', 'fixtureSource'],
  ['lane6-scratch/r10-shadow/F4_POLICY.json', 'policy'],
]) {
  const value = p.code?.[field]
  if (!value || value.sha256 !== prepared.measurementFiles[rel]) hard.push('measurement hash ' + rel)
}
if (p.bundle?.sha256 !== prepared.bundle.sha256) hard.push('bundle identity')
const rp = p.protocol || {}
for (const [key, expected] of Object.entries({
  mode: 'option-pair',
  n: policy.sampling.n,
  batch: policy.sampling.batch,
  warmup: policy.sampling.warmup,
  bootstrap: policy.sampling.bootstrap,
  replicate,
  engineOffset: ENGINE_OFFSET[browser],
})) {
  if (rp[key] !== expected) hard.push('protocol field ' + key)
}
const expectedSeed = (policy.sampling.baseSeed + ENGINE_OFFSET[browser] + replicate * 104729) >>> 0
if (rp.seed !== expectedSeed) hard.push('seed')
if (JSON.stringify(rp.fixtureNames) !== JSON.stringify(policy.fixtures)) hard.push('fixture manifest/order')
if (JSON.stringify(Object.keys(report.fixtures || {})) !== JSON.stringify(policy.fixtures)) {
  hard.push('fixture result identity/order')
}
if (hard.length) emit({ ...base, reasons: hard }, STATES.PROVENANCE)

// ---- runner admissibility ----------------------------------------------------------------------
const N = policy.sampling.n
const envelope = policy.instrument.outerNullEnvelopePct
const grossSd = policy.instrument.grossMaxPairLogSd
const reasons = []
const fixtures = {}

const rawSlotBias = (layout, name) => mean(report.layouts[layout][name].rows.map((r) => Math.log(r.slot2 / r.slot1)))

for (const name of policy.fixtures) {
  const fx = report.fixtures[name]
  const blocks = fx?.effect?.logRatios?.blocks
  if (!Array.isArray(blocks) || blocks.length !== N || blocks.some((x) => !Number.isFinite(x))) {
    reasons.push(name + ': non-finite or misaligned effect blocks')
  }
  for (const layout of LAYOUTS) {
    const rows = report.layouts?.[layout]?.[name]?.rows
    if (!Array.isArray(rows) || rows.length !== N || rows.some((r) => !(r.slot1 > 0) || !(r.slot2 > 0))) {
      reasons.push(name + ': invalid ' + layout + ' rows')
    }
  }

  const withinBlockSd = Array.isArray(blocks) && blocks.length > 1 ? Math.sqrt(variance(blocks)) : NaN
  const withinSe = withinBlockSd / Math.sqrt(N)

  // A/A raw controls, recomputed from the raw rows. Slot order bias is the failure mode a fresh
  // hosted VM actually shows, and reading it here means the harness summary cannot hide it.
  const baseSlotBiasPct = toPct(rawSlotBias('baseNullForward', name))
  const optSlotBiasPct = toPct(rawSlotBias('optNullForward', name))
  const nullWorstPct = Math.max(Math.abs(baseSlotBiasPct), Math.abs(optSlotBiasPct))
  const nullEnvelopePass = nullWorstPct <= envelope
  if (!nullEnvelopePass) {
    reasons.push(name + ': A/A raw slot bias ' + nullWorstPct.toFixed(2) + '% outside the ' + envelope + '% envelope')
  }

  const stabilityPass = fx.maxPairLogSd <= grossSd
  if (!stabilityPass) {
    reasons.push(name + ': paired-log SD ' + fx.maxPairLogSd.toFixed(3) + ' above the gross ceiling ' + grossSd)
  }

  const byteParity = fx.byteParity.forward === true && fx.byteParity.reverse === true
  const parityRequired = !policy.parityExemptFixtures.includes(name)
  if (parityRequired && !byteParity) {
    reasons.push(name + ': ARM_BYTE_PARITY — the ceiling arm does not agree byte-for-byte with released')
  }

  // The no-op fixture runs identical code in both arms, so its raw effect IS a null and gets the
  // same envelope. This is what stops the control from being decorative.
  const noop = policy.noopFixtures.includes(name)
  const noopEffectPct = fx.effect.pct
  const noopRawPass = Math.abs(noopEffectPct) <= envelope
  if (noop && !noopRawPass) {
    reasons.push(name + ': no-op raw effect ' + noopEffectPct.toFixed(2) + '% outside the ' + envelope + '% envelope')
  }

  fixtures[name] = {
    meta: { noop, promotionExcluded: policy.promotionExcludedFixtures.includes(name), parityExempt: !parityRequired },
    effect: { logPoint: fx.effect.logPoint, pct: fx.effect.pct, ci95: fx.effect.ci95 },
    withinBlockSd,
    withinSe,
    baseNull: { logPoint: fx.baseNull.logPoint, pct: fx.baseNull.pct, ci95: fx.baseNull.ci95, slotBiasPct: baseSlotBiasPct },
    optNull: { logPoint: fx.optNull.logPoint, pct: fx.optNull.pct, ci95: fx.optNull.ci95, slotBiasPct: optSlotBiasPct },
    nulls: { envelopePass: nullEnvelopePass, worstSlotBiasPct: nullWorstPct, envelopePct: envelope },
    noopEffectRawPass: noop ? noopRawPass : null,
    byteParity,
    maxPairLogSd: fx.maxPairLogSd,
    rawMaxCov: fx.rawMaxCov,
    controls: { nullEnvelopePass, stabilityPass, parityPass: parityRequired ? byteParity : null },
  }
}

emit({
  ...base,
  reportSha256: shaFile(reportPath),
  runner: report.provenance.runner,
  browserVersion: report.provenance.browser.actualVersion,
  preregistered: { outerNullEnvelopePct: envelope, grossMaxPairLogSd: grossSd },
  note: 'Runner-level sample. This cell decides nothing about the 1% floor; see aggregate.mjs.',
  fixtures,
  reasons,
}, reasons.length ? STATES.INCOMPLETE : STATES.VALID)