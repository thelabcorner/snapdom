#!/usr/bin/env node
/**
 * Resolves the committed benchmark identity and refuses anything the governor does not own.
 *
 * Everything numeric comes from lane6-scratch/r9/POLICY.json. The candidate manifest contributes
 * identity, intent, options and fixture selection — nothing else. A candidate that carries a
 * threshold is refused, not silently overridden.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import {
  GovernorRefusal,
  PLAN_SCHEMA,
  PHASES,
  assertCandidateCannotLoosen,
  assertFixtureSelection,
  assertHostedEnvironment,
  assertClaimableShape,
  loadPolicy,
  mergeRefProblems,
  promotionFrozen,
  readJson,
  resolveExpectation,
  unfrozenSlots,
  validateCandidate,
  validatePolicy,
} from './governor.mjs'

const ROOT = process.cwd()
const R9_ROOT = path.resolve(ROOT, 'lane6-scratch/r9')
const ACTIVE_REL = 'lane6-scratch/r9/ACTIVE_CANDIDATE.json'
const POLICY_REL = 'lane6-scratch/r9/POLICY.json'
const PLAN_REL = 'lane6-scratch/r9/resolved-plan.json'
const HARNESS_REL = 'lane6-scratch/r9/bench-r9-controlled.mjs'
const PROTOCOL_REL = 'lane6-scratch/r9/protocol.mjs'
const FIXTURE_SOURCE_REL = 'lane6-scratch/atlas/profiler/fixtures.mjs'
const GATE_REL = 'lane6-scratch/r5/run-with-timing-gate.mjs'

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function fail(message, detail) {
  console.error(`R9 candidate resolution refused: ${message}`)
  if (detail && Object.keys(detail).length) console.error(JSON.stringify(detail, null, 2))
  process.exit(1)
}

function guard(action) {
  try {
    return action()
  } catch (error) {
    if (error instanceof GovernorRefusal) fail(error.message, error.detail)
    throw error
  }
}

const activePath = path.resolve(ROOT, ACTIVE_REL)
if (!fs.existsSync(activePath)) fail(`missing ${ACTIVE_REL}`)
const active = readJson(activePath)
if (active.schema !== 'snapdom-r9-active-candidate-v2') fail('unsupported active-candidate schema')
if (typeof active.candidate !== 'string' || !active.candidate) fail('active candidate path missing')

const measuredSha = process.env.SNAPDOM_MEASURED_SHA || process.env.GITHUB_SHA || null
const measuredRef = process.env.SNAPDOM_MEASURED_REF || process.env.GITHUB_REF || null
guard(() => assertHostedEnvironment())
{
  const refProblems = mergeRefProblems(measuredRef || '')
  if (refProblems.length) fail(refProblems.join('; '))
  if (!/^[0-9a-f]{40}$/i.test(measuredSha || '')) fail('exact measured git SHA missing')
}

const policyProblems = validatePolicy(loadPolicy(ROOT))
if (policyProblems.length) fail(`governor policy is invalid:\n  - ${policyProblems.join('\n  - ')}`)
const policy = readJson(path.resolve(ROOT, POLICY_REL))

const candidateRoot = path.resolve(R9_ROOT, 'candidates')
const candidatePath = path.resolve(R9_ROOT, active.candidate)
{
  const rel = path.relative(candidateRoot, candidatePath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('active candidate must resolve strictly inside lane6-scratch/r9/candidates')
  }
}
if (!fs.existsSync(candidatePath)) fail(`candidate manifest not found: ${active.candidate}`)
const candidate = readJson(candidatePath)

guard(() => {
  const problems = validateCandidate(candidate, policy)
  if (problems.length) fail(`candidate manifest is invalid:\n  - ${problems.join('\n  - ')}`)
  assertCandidateCannotLoosen(candidate)
  const selection = assertFixtureSelection(candidate, policy)
  const phaseExpectations = {}
  for (const phase of PHASES) {
    phaseExpectations[phase] = resolveExpectation({
      phaseOverride: candidate.phases?.[phase]?.expect,
      candidateExpect: candidate.expect,
      phase,
      policy,
    })
    if (policy.phases[phase].promotable) assertClaimableShape(phaseExpectations[phase], selection, policy)
  }
  candidate.__selection = selection
  candidate.__phaseExpectations = phaseExpectations
})

const selection = candidate.__selection
const phaseExpectations = candidate.__phaseExpectations
delete candidate.__selection
delete candidate.__phaseExpectations

const require = createRequire(import.meta.url)
const installedPlaywright = require('playwright/package.json').version
if (installedPlaywright !== policy.playwrightVersion) {
  fail(`policy pins Playwright ${policy.playwrightVersion}, package resolves ${installedPlaywright}`)
}

const plan = {
  schema: PLAN_SCHEMA,
  generatedAt: new Date().toISOString(),
  candidateId: candidate.id,
  candidateManifest: path.relative(ROOT, candidatePath).replaceAll('\\', '/'),
  candidateManifestSha256: sha256File(candidatePath),
  activeCandidateSha256: sha256File(activePath),
  policySchema: policy.schema,
  policySha256: sha256File(path.resolve(ROOT, POLICY_REL)),
  measuredSha,
  measuredRef,
  harnessRel: HARNESS_REL,
  protocolRel: PROTOCOL_REL,
  fixtureSourceRel: FIXTURE_SOURCE_REL,
  governorRel: policy.governor,
  gateRel: GATE_REL,
  candidate,
  selection,
  phaseExpectations,
  frozen: promotionFrozen(policy),
  unfrozenSlots: unfrozenSlots(policy),
  // When the policy is unfrozen these stay null and the harness is invoked in a mode that
  // reports evidence validity only. No placeholder or provisional number is ever substituted.
  thresholds: {
    epsilon: finiteOrNull(policy.promotion.epsilon),
    controlBand: finiteOrNull(policy.promotion.controlBand),
    equivalenceBand: finiteOrNull(policy.promotion.equivalenceBand),
    nonRegressionBand: finiteOrNull(policy.promotion.nonRegressionBand),
    maxPairLogSd: finiteOrNull(policy.promotion.maxPairLogSd),
  },
  runnerSpec: policy.runner,
  toolchainSpec: {
    nodeVersion: policy.nodeVersion,
    playwrightVersion: policy.playwrightVersion,
  },
  acquisition: policy.acquisition,
  phaseSpec: policy.phases,
  gateSpec: policy.gate,
}

fs.mkdirSync(R9_ROOT, { recursive: true })
fs.writeFileSync(path.resolve(ROOT, PLAN_REL), JSON.stringify(plan, null, 2) + '\n')

const outputs = {
  candidate_id: candidate.id,
  candidate_manifest: plan.candidateManifest,
  candidate_manifest_sha256: plan.candidateManifestSha256,
  policy_sha256: plan.policySha256,
  mode: candidate.mode,
  baseline_ref: candidate.baselineRef || '',
  suite: candidate.suite,
  candidate_expect: candidate.expect,
  policy_frozen: String(plan.frozen),
  unfrozen_slots: plan.unfrozenSlots.join(','),
  confirm_replicates: String(policy.phases.confirm.replicates ?? ''),
  confirm_matrix: JSON.stringify(
    Array.from({ length: policy.phases.confirm.replicates ?? 0 }, (_, i) => i),
  ),
  engine_guard_replicates: String(policy.phases.engineGuard.replicates ?? ''),
  engine_guard_matrix: JSON.stringify(
    policy.phases.engineGuard.browsers.flatMap((browser) =>
      Array.from({ length: policy.phases.engineGuard.replicates ?? 0 }, (_, replicate) => ({ browser, replicate }))),
  ),
  expect_confirm: phaseExpectations.confirm,
  expect_engine_guard: phaseExpectations.engineGuard,
  measured_sha: plan.measuredSha,
  measured_ref: plan.measuredRef,
  plan_path: PLAN_REL,
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''))
}

console.log(JSON.stringify({ resolved: true, ...outputs }, null, 2))
