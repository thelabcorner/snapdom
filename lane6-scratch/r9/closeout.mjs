#!/usr/bin/env node
/**
 * Terminal closeout for the R9 hosted benchmark lane.
 *
 * Closeout reads every phase's decision artifacts and reduces them to one outcome through the
 * governor's `closeoutVerdict`. It is structurally incapable of reporting success when a
 * preregistered phase contributed no usable evidence: zero evidence is INCOMPLETE_EVIDENCE, and a
 * clean negative result is NO_CLAIM. Neither is a promotion.
 */

import fs from 'node:fs'
import path from 'node:path'
import { arg, sha256File } from './protocol.mjs'
import { closeoutSummary, closeoutVerdict, readJson } from './governor.mjs'

const ROOT = process.cwd()
const POLICY_PATH = path.resolve(ROOT, 'lane6-scratch/r9/POLICY.json')
const PLAN_PATH = path.resolve(ROOT, 'lane6-scratch/r9/resolved-plan.json')
const INPUT_DIR = path.resolve(ROOT, arg('input-dir', 'lane6-scratch/r9/closeout-input'))
const OUT_PATH = path.resolve(ROOT, arg('out', 'lane6-scratch/r9/decisions/closeout.json'))

function fail(message) {
  console.error(`R9 closeout infrastructure failure: ${message}`)
  process.exit(1)
}
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

if (!fs.existsSync(POLICY_PATH)) fail('governor policy missing')
if (!fs.existsSync(PLAN_PATH)) fail('resolved plan missing; closeout cannot describe evidence it cannot identify')

const policy = readJson(POLICY_PATH)
const plan = readJson(PLAN_PATH)
if (plan.schema !== 'snapdom-r9-resolved-plan-v2') fail('resolved-plan schema mismatch')
if (sha256File(POLICY_PATH) !== plan.policySha256) fail('checked-out governor policy digest differs from immutable plan')

const docs = []
for (const file of walk(INPUT_DIR)) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value?.schema === 'snapdom-r9-aggregate-decision-v2' || value?.schema === 'snapdom-r9-run-decision-v2') {
      docs.push(value)
    }
  } catch {}
}

// Foreign identities are refused rather than summarised: a closeout may only speak about the
// candidate and policy that this run actually measured.
const aggregates = []
const runs = []
for (const value of docs) {
  if (value.candidateId !== plan.candidateId) fail(`closeout input carries a foreign candidate id ${value.candidateId}`)
  if (value.policySha256 !== plan.policySha256) fail('closeout input carries a foreign policy digest')
  if (value.schema === 'snapdom-r9-aggregate-decision-v2') aggregates.push(value)
  else runs.push(value)
}

const phases = {}
for (const aggregate of aggregates) {
  if (phases[aggregate.phase]?.aggregate) fail(`duplicate aggregate for phase ${aggregate.phase}`)
  phases[aggregate.phase] = { ...(phases[aggregate.phase] || {}), aggregate }
}
const scoutRuns = runs.filter((run) => run.phase === 'scout')
if (scoutRuns.length > 1) fail(`duplicate scout decisions (${scoutRuns.length})`)
if (scoutRuns.length) {
  const killed = scoutRuns.some((run) => run.verdict !== 'EVIDENCE_VALID')
  phases.scout = {
    ...(phases.scout || {}),
    scout: {
      verdict: killed ? 'SCOUT_KILL' : 'SCOUT_CLEARED',
      reason: killed
        ? scoutRuns.filter((run) => run.verdict !== 'EVIDENCE_VALID')
            .map((run) => run.reasons.join('; '))
            .join(' | ')
        : '',
    },
  }
}

// A preregistered phase that produced no artifact at all is reported as INCOMPLETE_EVIDENCE by the
// governor, not quietly omitted from the summary.
const closeout = closeoutVerdict({ candidateId: plan.candidateId, policy, phases })
closeout.policySha256 = plan.policySha256
closeout.measuredSha = plan.measuredSha

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
fs.writeFileSync(OUT_PATH, JSON.stringify(closeout, null, 2) + '\n')

writeOutput('outcome', closeout.outcome)
writeOutput('promotable', closeout.promotable ? 'true' : 'false')
writeOutput('is_evidence_failure', closeout.isEvidenceFailure ? 'true' : 'false')
writeOutput('closeout_path', path.relative(ROOT, OUT_PATH).replaceAll('\\', '/'))

appendSummary(closeoutSummary(closeout) + '\n')
console.log(JSON.stringify(closeout, null, 2))

if (closeout.isEvidenceFailure) process.exit(1)
