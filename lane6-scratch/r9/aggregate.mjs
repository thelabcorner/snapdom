#!/usr/bin/env node
/**
 * Runner-level aggregation — the primary and only inference stage.
 *
 * One number per fresh runner crosses the runner boundary (its log-effect point estimate). Raw
 * samples stay runner-local. Every preregistered cell is mandatory: a single missing or unusable
 * cell yields INCOMPLETE_EVIDENCE, never a partial claim.
 *
 * When the promotion policy is not frozen this stage still runs and still validates evidence, but
 * it is structurally incapable of returning PROMOTABLE — it returns NO_CLAIM with the list of
 * unfrozen slots. No provisional threshold is ever substituted.
 */

import fs from 'node:fs'
import path from 'node:path'
import { arg } from './protocol.mjs'
import {
  GovernorRefusal,
  PLAN_SCHEMA,
  aggregatePhase,
  cellKey,
  loadPolicy,
  promotionFrozen,
  readJson,
  validatePolicy,
} from './governor.mjs'

const ROOT = process.cwd()
const PLAN_PATH = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const POLICY_PATH = path.resolve(ROOT, 'lane6-scratch/r9/POLICY.json')
const PHASE = arg('phase', 'confirm')
const INPUT_DIR = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r9/aggregate-input'))
const OUT_PATH = path.resolve(ROOT, arg('out', 'lane6-scratch/r9/decisions/aggregate-confirm.json'))

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
}
function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.json')) out.push(p)
  }
  return out
}

if (!fs.existsSync(PLAN_PATH)) {
  console.error('R9 aggregate infrastructure failure: resolved plan missing')
  process.exit(1)
}
if (!['confirm', 'engineGuard'].includes(PHASE)) {
  console.error('R9 aggregate infrastructure failure: aggregate supports confirm or engineGuard only')
  process.exit(1)
}

const policyProblems = validatePolicy(readJson(POLICY_PATH))
if (policyProblems.length) {
  console.error('R9 aggregate infrastructure failure: invalid governor policy\n  - ' + policyProblems.join('\n  - '))
  process.exit(1)
}
const policy = readJson(POLICY_PATH)

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
if (plan.schema !== PLAN_SCHEMA) {
  console.error('R9 aggregate infrastructure failure: resolved-plan schema mismatch')
  process.exit(1)
}

const decisions = []
for (const file of walk(INPUT_DIR)) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value?.schema === 'snapdom-r9-run-decision-v2' && value.phase === PHASE) decisions.push(value)
  } catch {}
}

const seen = new Set()
for (const decision of decisions) {
  const key = cellKey(decision.browser, decision.replicate)
  if (seen.has(key)) {
    console.error('R9 aggregate infrastructure failure: duplicate decision ' + key)
    process.exit(1)
  }
  seen.add(key)
}

let aggregate
try {
  aggregate = aggregatePhase({ plan, policy, phase: PHASE, decisions })
} catch (error) {
  if (error instanceof GovernorRefusal) {
    // aggregatePhase handles intentionally-unfrozen policy slots itself. Reaching this catch means
    // the governor refused malformed/incoherent evidence. Preserve immutable identity so closeout
    // can still verify and fail closed rather than receiving an anonymous artifact.
    aggregate = {
      schema: 'snapdom-r9-aggregate-decision-v2',
      candidateId: plan.candidateId,
      manifestSha256: plan.candidateManifestSha256,
      policySha256: plan.policySha256,
      measuredSha: plan.measuredSha,
      measuredRef: plan.measuredRef,
      verdict: 'INCOMPLETE_EVIDENCE',
      promotable: false,
      expectation: plan.phaseExpectations[PHASE],
      phase: PHASE,
      reasons: [error.message],
      blockers: ['GOVERNOR_REFUSAL'],
      browsers: {},
      evidenceCells: { expected: 0, observed: decisions.length, usable: 0 },
    }
  } else {
    throw error
  }
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
fs.writeFileSync(OUT_PATH, JSON.stringify(aggregate, null, 2) + '\n')
writeOutput('verdict', aggregate.verdict)
writeOutput('promotable', aggregate.promotable ? 'true' : 'false')
writeOutput('evidence_usable', aggregate.verdict !== 'INCOMPLETE_EVIDENCE' && aggregate.verdict !== 'PROVENANCE_FAILURE' ? 'true' : 'false')
writeOutput('decision_path', path.relative(ROOT, OUT_PATH).replaceAll('\\', '/'))

const rows = []
for (const [browser, group] of Object.entries(aggregate.browsers || {})) {
  for (const [name, fx] of Object.entries(group.fixtures || {})) {
    const ci = Array.isArray(fx.ci95)
      ? '[' + fx.ci95.map((v) => (Number.isFinite(v) ? v.toFixed(2) : String(v))).join(', ') + ']%'
      : 'unavailable'
    rows.push('| ' + browser + ' | ' + name + ' | ' +
      (Number.isFinite(fx.pct) ? fx.pct.toFixed(2) + '%' : 'n/a') + ' | ' + ci + ' | ' +
      (fx.primary ? 'primary' : fx.guard ? 'guard' : 'fixture') + ' |')
  }
}

appendSummary([
  '### R9 runner-level aggregate · ' + plan.candidateId + ' · ' + PHASE,
  '',
  '**' + aggregate.verdict + '** — promotable: **' + (aggregate.promotable ? 'yes' : 'no') + '**',
  '',
  'Method: Student-t 95% CI across fresh-runner log-effect point estimates; raw samples remain runner-local',
  '',
  '| browser | fixture | runner-mean effect | 95% runner-level CI | role |',
  '|---|---|---:|---:|---|',
  ...rows,
  '',
  ...(aggregate.reasons || []).map((x) => '- ' + x),
  '',
  aggregate.frozen
    ? ''
    : '- promotion policy is NOT frozen; unfrozen slots: `' + (aggregate.unfrozenSlots || []).join('`, `') + '`',
  '',
].filter((line) => line !== '').join('\n'))

console.log(JSON.stringify(aggregate, null, 2))

// Fail closed on identity/integrity failures and on incomplete preregistered evidence. A clean
// NO_CLAIM is a valid green run; INCOMPLETE_EVIDENCE and PROVENANCE_FAILURE are not.
if (aggregate.verdict === 'PROVENANCE_FAILURE' || aggregate.verdict === 'INCOMPLETE_EVIDENCE') {
  process.exit(1)
}
void loadPolicy
void promotionFrozen
