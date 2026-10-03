#!/usr/bin/env node
/**
 * R9 governor v2 — policy ownership, explicit expectation semantics, and fail-closed verdicts.
 *
 * This module is deliberately dependency-free (node builtins only) and browser-free so that the
 * entire governance contract can be exercised by `node --test` without launching any browser.
 *
 * Ownership model
 * ---------------
 *   lane6-scratch/r9/POLICY.json     owns every threshold, band, replicate count and batch size
 *   candidates/*.json                owns identity, intent and fixture selection ONLY
 *
 * A candidate manifest may never carry, raise, widen or lower a threshold. Attempting to do so is
 * refused at resolution time rather than silently ignored.
 *
 * Expectation semantics (closed set, no fail-open)
 * ------------------------------------------------
 *   CALIBRATION     instrument self-check. Never promotable.
 *   IMPROVEMENT     promotable. Requires guards AND no-op controls.
 *   EQUIVALENCE     promotable. Requires guards AND no-op controls.
 *   NONREGRESSION   promotable. Requires guards AND no-op controls.
 *
 * An absent or unknown expectation is a refusal, never a default.
 *
 * Verdicts
 * --------
 *   PROVENANCE_FAILURE    identity/provenance did not verify           -> fail closed (red)
 *   INCOMPLETE_EVIDENCE   a preregistered cell produced no usable evidence -> fail closed (red)
 *   NO_CLAIM              evidence is complete and valid but supports no promotable claim -> green,
 *                          explicitly not a success
 *   PROMOTABLE            evidence complete, valid, and clears the frozen policy -> green, eligible
 *
 * Zero evidence can never render as success: `closeoutVerdict` refuses any input in which an
 * entered phase contributed no usable cells.
 */

import fs from 'node:fs'
import path from 'node:path'

export const POLICY_SCHEMA = 'snapdom-r9-governor-policy-v2'
export const CANDIDATE_SCHEMA = 'snapdom-r9-candidate-v2'
export const PLAN_SCHEMA = 'snapdom-r9-resolved-plan-v2'
export const RUN_DECISION_SCHEMA = 'snapdom-r9-run-decision-v2'
export const SEED_STRIDE = 104729

/**
 * Deterministic fresh-runner acquisition seed.
 *
 * Policy owns the base seed; replicate identity owns the only offset. The same replicate uses the
 * same seed across browser engines so engine guards observe the same acquisition ordering.
 */
export function deriveSeed(baseSeed, replicate) {
  if (!Number.isInteger(baseSeed) || baseSeed < 0) {
    throw new GovernorRefusal('base seed must be an integer >= 0', { baseSeed })
  }
  if (!Number.isInteger(replicate) || replicate < 0) {
    throw new GovernorRefusal('replicate must be an integer >= 0 for seed derivation', { replicate })
  }
  return (baseSeed + replicate * SEED_STRIDE) >>> 0
}
export const AGGREGATE_SCHEMA = 'snapdom-r9-aggregate-decision-v2'
export const CLOSEOUT_SCHEMA = 'snapdom-r9-closeout-v2'

export const EXPECTATIONS = Object.freeze(['CALIBRATION', 'IMPROVEMENT', 'EQUIVALENCE', 'NONREGRESSION'])
export const PROMOTABLE_EXPECTATIONS = Object.freeze(['IMPROVEMENT', 'EQUIVALENCE', 'NONREGRESSION'])

export const VERDICTS = Object.freeze({
  // The single positive promotion verdict. Only a promotable inference phase (confirm) can emit it.
  PROMOTABLE: 'PROMOTABLE',
  // A non-promotable mandatory phase (engineGuard) whose gates all cleared. Deliberately NOT a
  // synonym for PROMOTABLE: it satisfies a mandatory guard while owning no promotion itself.
  GUARD_CLEARED: 'GUARD_CLEARED',
  NO_CLAIM: 'NO_CLAIM',
  INCOMPLETE_EVIDENCE: 'INCOMPLETE_EVIDENCE',
  PROVENANCE_FAILURE: 'PROVENANCE_FAILURE',
  SCOUT_KILL: 'SCOUT_KILL',
  SCOUT_CLEARED: 'SCOUT_CLEARED',
})

export const PHASES = Object.freeze(['scout', 'confirm', 'engineGuard'])

/**
 * Keys a candidate manifest is forbidden to carry. These are the exact keys that used to let a
 * candidate loosen its own measurement instrument.
 */
export const CANDIDATE_FORBIDDEN_KEYS = Object.freeze([
  'epsilon',
  'controlBand',
  'equivalenceBand',
  'nonRegressionBand',
  'maxPairLogSd',
  'noopBand',
  'noise',
  'noiseFloor',
  'replicates',
  'n',
  'batch',
  'warmup',
  'bootstrap',
  'seed',
  'thresholds',
  'bands',
  'promotion',
  'policy',
  'epsilonOverride',
  'bandOverride',
  'nodeVersion',
  'playwrightVersion',
])

const FORBIDDEN_NESTED_KEYS = Object.freeze([
  'epsilon', 'controlBand', 'equivalenceBand', 'nonRegressionBand', 'maxPairLogSd',
  'noopBand', 'replicates', 'n', 'batch', 'warmup', 'bootstrap', 'seed',
])

export class GovernorRefusal extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'GovernorRefusal'
    this.detail = detail
  }
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x)
const pct = (logRatio) => (Math.exp(logRatio) - 1) * 100
const isSha256 = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x)
const isGitSha = (x) => typeof x === 'string' && /^[0-9a-f]{40}$/i.test(x)

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function loadPolicy(root) {
  const file = path.resolve(root, 'lane6-scratch/r9/POLICY.json')
  if (!fs.existsSync(file)) throw new GovernorRefusal('governor policy missing', { file })
  return readJson(file)
}

/* ------------------------------------------------------------------ policy validation -------- */

export function validatePolicy(policy) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }

  need(policy?.schema === POLICY_SCHEMA, `policy.schema must be ${POLICY_SCHEMA}`)
  need(typeof policy?.repository === 'string' && policy.repository.includes('/'), 'policy.repository must be owner/name')
  need(/^\d+\.\d+\.\d+$/.test(policy?.nodeVersion || ''), 'policy.nodeVersion must be exact x.y.z')
  need(/^\d+\.\d+\.\d+$/.test(policy?.playwrightVersion || ''), 'policy.playwrightVersion must be exact x.y.z')
  need(policy?.runner?.os === 'Linux', 'policy.runner.os must be Linux (hosted benchmark lane)')
  need(finite(policy?.gate?.maxMedianPct), 'policy.gate.maxMedianPct required')
  need(finite(policy?.gate?.maxMeanPct), 'policy.gate.maxMeanPct required')
  need(finite(policy?.gate?.maxPeakPct), 'policy.gate.maxPeakPct required')
  need(Number.isInteger(policy?.gate?.samples) && policy.gate.samples >= 3, 'policy.gate.samples must be an integer >= 3')
  need(Number.isInteger(policy?.gate?.intervalMs) && policy.gate.intervalMs >= 250, 'policy.gate.intervalMs must be >= 250')
  need(Number.isInteger(policy?.gate?.settle?.intervalMs) && policy.gate.settle.intervalMs >= 250,
    'policy.gate.settle.intervalMs must be >= 250')
  need(Number.isInteger(policy?.gate?.settle?.maxWaitMs) &&
    policy.gate.settle.maxWaitMs >= policy.gate.settle.intervalMs,
    'policy.gate.settle.maxWaitMs must be >= settle interval')
  need(Number.isInteger(policy?.gate?.settle?.consecutive) && policy.gate.settle.consecutive >= 1,
    'policy.gate.settle.consecutive must be >= 1')
  need(finite(policy?.gate?.settle?.maxCpuPercent) &&
    policy.gate.settle.maxCpuPercent >= 0 && policy.gate.settle.maxCpuPercent <= 100,
    'policy.gate.settle.maxCpuPercent must be within [0,100]')

  need(Array.isArray(policy?.expectations) && policy.expectations.length === EXPECTATIONS.length,
    `policy.expectations must be exactly [${EXPECTATIONS.join(', ')}]`)
  for (const expectation of EXPECTATIONS) {
    need(policy?.expectations?.includes(expectation), `policy.expectations missing ${expectation}`)
  }

  for (const phase of PHASES) {
    const spec = policy?.phases?.[phase]
    need(spec && typeof spec === 'object', `policy.phases.${phase} missing`)
    need(Array.isArray(spec?.browsers) && spec.browsers.length > 0, `policy.phases.${phase}.browsers missing`)
    for (const browser of spec?.browsers || []) {
      need(['chromium', 'firefox', 'webkit'].includes(browser), `policy.phases.${phase}.browsers has unsupported ${browser}`)
    }
    need(typeof spec?.role === 'string' && spec.role, `policy.phases.${phase}.role missing`)
    need(typeof spec?.promotable === 'boolean', `policy.phases.${phase}.promotable must be boolean`)
    need(typeof spec?.mandatory === 'boolean', `policy.phases.${phase}.mandatory must be boolean`)

    const acquisition = policy?.acquisition?.[phase]
    need(acquisition && typeof acquisition === 'object', `policy.acquisition.${phase} missing`)
    need(Number.isInteger(acquisition?.n) && acquisition.n >= 4, `policy.acquisition.${phase}.n must be an integer >= 4`)
    need(Number.isInteger(acquisition?.warmup) && acquisition.warmup >= 0, `policy.acquisition.${phase}.warmup must be an integer >= 0`)
    need(Number.isInteger(acquisition?.bootstrap) && acquisition.bootstrap >= 1000, `policy.acquisition.${phase}.bootstrap must be an integer >= 1000`)
    need(Number.isInteger(acquisition?.seed) && acquisition.seed >= 0, `policy.acquisition.${phase}.seed must be an integer >= 0`)
  }

  need(policy?.phases?.scout?.promotable === false, 'scout must be non-promotable')
  need(policy?.phases?.scout?.role === 'kill-only', 'scout role must be kill-only')

  for (const suite of ['standing', 'focus', 'pseudo']) {
    const entry = policy?.suites?.[suite]
    need(Array.isArray(entry?.fixtures) && entry.fixtures.length > 0, `policy.suites.${suite}.fixtures missing`)
    need(Array.isArray(entry?.knownNoOpFixtures), `policy.suites.${suite}.knownNoOpFixtures must be an array`)
    for (const fixture of entry?.fixtures || []) {
      need(!/[,\s]/.test(fixture), `policy.suites.${suite} fixture ${fixture} contains a comma or whitespace`)
    }
    for (const noOp of entry?.knownNoOpFixtures || []) {
      need(entry.fixtures.includes(noOp), `policy.suites.${suite} no-op ${noOp} is not in the fixture allowlist`)
    }
    if (entry?.fixtures) {
      need(new Set(entry.fixtures).size === entry.fixtures.length, `policy.suites.${suite}.fixtures contains duplicates`)
    }
  }

  const improvement = policy?.improvement || {}
  need(Number.isInteger(improvement.minGuardFixtures) && improvement.minGuardFixtures >= 1,
    'policy.improvement.minGuardFixtures must be an integer >= 1')
  need(Number.isInteger(improvement.minKnownNoOpFixtures) && improvement.minKnownNoOpFixtures >= 1,
    'policy.improvement.minKnownNoOpFixtures must be an integer >= 1')

  const promotion = policy?.promotion
  need(promotion && typeof promotion === 'object', 'policy.promotion missing')
  need(typeof promotion?.frozen === 'boolean', 'policy.promotion.frozen must be boolean')
  need(Array.isArray(promotion?.unfrozenSlots), 'policy.promotion.unfrozenSlots must be an array')
  need(isGitSha(promotion?.owner?.runId || '') || /^\d+$/.test(String(promotion?.owner?.runId ?? '')),
    'policy.promotion.owner.runId must be a hosted run id')

  if (promotion?.frozen === true) {
    for (const slot of promotion.unfrozenSlots || []) problems.push(`frozen policy still lists unfrozen slot ${slot}`)
    for (const key of ['epsilon', 'equivalenceBand', 'nonRegressionBand', 'controlBand', 'maxPairLogSd']) {
      need(finite(promotion[key]), `frozen policy requires numeric promotion.${key}`)
    }
    for (const phase of ['confirm', 'engineGuard']) {
      need(Number.isInteger(policy?.phases?.[phase]?.replicates) && policy.phases[phase].replicates >= 2,
        `frozen policy requires integer policy.phases.${phase}.replicates >= 2`)
    }
    for (const phase of PHASES) {
      need(Number.isInteger(policy?.acquisition?.[phase]?.batch) && policy.acquisition[phase].batch >= 1,
        `frozen policy requires integer policy.acquisition.${phase}.batch >= 1`)
    }
  }

  return problems
}

export function unfrozenSlots(policy) {
  const slots = []
  const promotion = policy?.promotion || {}
  if (promotion.frozen !== true) {
    for (const slot of promotion.unfrozenSlots || []) slots.push(slot)
    for (const key of ['epsilon', 'equivalenceBand', 'nonRegressionBand', 'controlBand', 'maxPairLogSd']) {
      if (!finite(promotion[key])) {
        const slot = `promotion.${key}`
        if (!slots.includes(slot)) slots.push(slot)
      }
    }
    for (const phase of ['confirm', 'engineGuard']) {
      if (!Number.isInteger(policy?.phases?.[phase]?.replicates)) {
        const slot = `phases.${phase}.replicates`
        if (!slots.includes(slot)) slots.push(slot)
      }
    }
    for (const phase of PHASES) {
      if (!Number.isInteger(policy?.acquisition?.[phase]?.batch)) {
        const slot = `acquisition.${phase}.batch`
        if (!slots.includes(slot)) slots.push(slot)
      }
    }
  }
  return slots
}

export function promotionFrozen(policy) {
  return policy?.promotion?.frozen === true && unfrozenSlots(policy).length === 0
}

/* ------------------------------------------------------------------ candidate validation ----- */

function forbiddenKeyHits(value, trail, hits) {
  if (!value || typeof value !== 'object') return hits
  for (const [key, child] of Object.entries(value)) {
    const where = trail ? `${trail}.${key}` : key
    if (FORBIDDEN_NESTED_KEYS.includes(key)) hits.push(where)
    if (child && typeof child === 'object' && !Array.isArray(child)) forbiddenKeyHits(child, where, hits)
  }
  return hits
}

/** Refuses any attempt by a candidate to own, raise or lower a measurement threshold. */
export function assertCandidateCannotLoosen(candidate) {
  const topLevel = CANDIDATE_FORBIDDEN_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(candidate || {}, key))
  if (topLevel.length) {
    throw new GovernorRefusal(
      `candidate owns policy fields [${topLevel.join(', ')}]; thresholds are policy-owned`,
      { keys: topLevel },
    )
  }
  const nested = forbiddenKeyHits(candidate, '', [])
  if (nested.length) {
    throw new GovernorRefusal(
      `candidate nests policy fields [${nested.join(', ')}]; thresholds are policy-owned`,
      { keys: nested },
    )
  }
  return true
}

export function fixtureAllowlist(policy, suite) {
  const entry = policy?.suites?.[suite]
  if (!entry) throw new GovernorRefusal(`unknown suite ${suite}`, { suite })
  return { fixtures: [...entry.fixtures], knownNoOpFixtures: [...(entry.knownNoOpFixtures || [])] }
}

/** Exact allowlist check: no unknown fixtures, no duplicates, no overlap, no partial selection. */
export function assertFixtureSelection(candidate, policy) {
  const allow = fixtureAllowlist(policy, candidate.suite)
  const primary = candidate.primaryFixtures
  const guards = candidate.guardFixtures
  const noOps = candidate.knownNoOpFixtures

  for (const [label, list] of [['primaryFixtures', primary], ['guardFixtures', guards], ['knownNoOpFixtures', noOps]]) {
    if (!Array.isArray(list)) throw new GovernorRefusal(`${label} must be an array`, { label })
    for (const name of list) {
      if (!allow.fixtures.includes(name)) {
        throw new GovernorRefusal(`${label} contains ${name}, which is not in the ${candidate.suite} allowlist`, {
          label, fixture: name, suite: candidate.suite, allowlist: allow.fixtures,
        })
      }
    }
    if (new Set(list).size !== list.length) throw new GovernorRefusal(`${label} contains duplicates`, { label })
  }

  const union = [...primary, ...guards]
  if (new Set(union).size !== union.length) {
    throw new GovernorRefusal('primaryFixtures and guardFixtures overlap', { primary, guards })
  }
  if (!union.length) throw new GovernorRefusal('candidate selects no fixtures', {})
  for (const name of noOps) {
    if (!union.includes(name)) throw new GovernorRefusal(`knownNoOpFixtures entry ${name} is not selected`, { fixture: name })
  }
  return { ...allow, selected: union, primary, guards, noOps }
}

export function validateCandidate(candidate, policy) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }

  need(candidate?.schema === CANDIDATE_SCHEMA, `candidate.schema must be ${CANDIDATE_SCHEMA}`)
  need(/^[a-z0-9][a-z0-9._-]{2,80}$/.test(candidate?.id || ''), 'candidate.id is invalid')
  need(['bundle-diff', 'option-pair'].includes(candidate?.mode), 'candidate.mode must be bundle-diff or option-pair')
  need(['standing', 'focus', 'pseudo'].includes(candidate?.suite), 'candidate.suite must be standing, focus or pseudo')
  need(typeof candidate?.description === 'string' && candidate.description.length > 0, 'candidate.description required')
  need(typeof candidate?.base === 'object' && candidate.base !== null, 'candidate.base must be an object')
  need(typeof candidate?.opt === 'object' && candidate.opt !== null, 'candidate.opt must be an object')

  if (candidate?.mode === 'bundle-diff') {
    need(isGitSha(candidate?.baselineRef || ''), 'bundle-diff requires a full 40-hex baselineRef')
  } else {
    need(candidate?.baselineRef === null, 'option-pair requires baselineRef=null (both arms are the same bundle)')
  }

  return problems
}

/**
 * Guards and no-op controls are mandatory for every promotable expectation, including
 * non-regression: a claim without a guard fixture and a no-op control is not admissible evidence.
 */
export function assertClaimableShape(expectation, selection, policy) {
  const requirements = policy.improvement
  if (!PROMOTABLE_EXPECTATIONS.includes(expectation)) return
  if (selection.guards.length < requirements.minGuardFixtures) {
    throw new GovernorRefusal(
      `${expectation} requires at least ${requirements.minGuardFixtures} guard fixture(s); got ${selection.guards.length}`,
      { expectation, guards: selection.guards },
    )
  }
  if (selection.noOps.length < requirements.minKnownNoOpFixtures) {
    throw new GovernorRefusal(
      `${expectation} requires at least ${requirements.minKnownNoOpFixtures} known no-op control fixture(s); got ${selection.noOps.length}`,
      { expectation, noOps: selection.noOps },
    )
  }
}

/* ------------------------------------------------------------------ expectation resolution --- */

/**
 * Resolves the expectation for a phase. Strictly closed set.
 * `phaseOverride` wins only when it is a known expectation.
 * Anything else — absent, unknown, non-string — is a refusal. There is no default and no
 * fall-through that could quietly turn an unrecognised intent into an eligible run.
 */
export function resolveExpectation({ phaseOverride, candidateExpect, phase, policy }) {
  const declared = phaseOverride ?? candidateExpect
  const where = phaseOverride !== undefined && phaseOverride !== null ? `phases.${phase}.expect` : 'candidate.expect'
  if (declared === undefined || declared === null || declared === '') {
    throw new GovernorRefusal(
      `no expectation declared for phase ${phase}; refusing to guess (${where})`,
      { phase, declared, allowed: EXPECTATIONS },
    )
  }
  if (typeof declared !== 'string') {
    throw new GovernorRefusal(`expectation for phase ${phase} must be a string`, { phase, declared })
  }
  const canonical = declared.trim().toUpperCase()
  if (!EXPECTATIONS.includes(canonical)) {
    throw new GovernorRefusal(
      `unknown expectation "${declared}" for phase ${phase}; allowed: ${EXPECTATIONS.join(', ')}`,
      { phase, declared, allowed: EXPECTATIONS },
    )
  }
  if (policy?.expectations && !policy.expectations.includes(canonical)) {
    throw new GovernorRefusal(`policy does not admit expectation ${canonical}`, { phase, declared: canonical })
  }
  if (canonical === 'CALIBRATION' && policy?.phases?.[phase]?.promotable) {
    throw new GovernorRefusal(
      `phase ${phase} is promotable and cannot run a CALIBRATION expectation`,
      { phase },
    )
  }
  return canonical
}

export function isPromotableExpectation(expectation) {
  return PROMOTABLE_EXPECTATIONS.includes(expectation)
}

/* ------------------------------------------------------------------ hosted identity -------- */

export const HOSTED_ENV_REQUIRED = Object.freeze([
  'GITHUB_ACTIONS',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_JOB',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'RUNNER_NAME',
  'ImageOS',
  'ImageVersion',
])

/**
 * Local browser execution is structurally impossible: the harness is hosted-only by
 * environment assertion, and every governor entry point re-asserts hosted provenance over
 * evidence it did not produce itself.
 */
export function hostedEnvironmentProblems(env = process.env) {
  const problems = []
  if (env.GITHUB_ACTIONS !== 'true') problems.push('not running under GitHub Actions')
  for (const key of HOSTED_ENV_REQUIRED) {
    if (key === 'GITHUB_ACTIONS') continue
    if (!env[key]) problems.push(`missing hosted provenance ${key}`)
  }
  if (env.RUNNER_OS && env.RUNNER_OS !== 'Linux') problems.push(`RUNNER_OS=${env.RUNNER_OS} is not Linux`)
  return problems
}

export function assertHostedEnvironment(env = process.env) {
  const problems = hostedEnvironmentProblems(env)
  if (problems.length) {
    throw new GovernorRefusal(`hosted-only benchmark refused: ${problems.join('; ')}`, { problems })
  }
  return true
}

/**
 * Rejects pull-request merge refs outright. Measuring `refs/pull/N/merge` makes the measured
 * identity ambiguous between the merge commit and the head commit, so the lane refuses to start
 * rather than resolve that ambiguity silently.
 */
export function mergeRefProblems(ref = '') {
  const problems = []
  if (/^refs\/pull\/\d+\/(merge|head)$/.test(ref)) {
    problems.push(`ambiguous pull-request merge ref ${ref} is not a measurable identity`)
  }
  if (/^refs\/merge\//.test(ref)) problems.push(`merge queue ref ${ref} is not a measurable identity`)
  return problems
}

/* ------------------------------------------------------------------ identity verification --- */

/**
 * Verifies the raw provenance, harness, protocol, gate, workflow and toolchain identities carried
 * by a run report against the immutable identities frozen at prepare time.
 *
 * Every identity is compared, not merely presence-checked.
 */
export function verifyRunIdentities({ plan, report, build, gate, policy, env = process.env, phase, browser, replicate }) {
  const hard = []
  const provenance = report?.provenance || {}
  const code = provenance.code || {}
  const git = provenance.git || {}
  const bundles = provenance.bundles || {}
  const runner = provenance.runner || {}
  const browserProvenance = provenance.browser || {}

  if (report.schema !== 'snapdom-r9-hosted-bench-v1') hard.push('report schema mismatch')
  if (build?.schema !== 'snapdom-r9-build-provenance-v2') hard.push('build provenance schema mismatch')

  // toolchain identity
  const observedNode = String(provenance.toolchain?.node ?? provenance.node?.version ?? '').replace(/^v/, '')
  if (observedNode !== policy.nodeVersion) {
    hard.push(`node identity ${observedNode || '(missing)'} != policy ${policy.nodeVersion}`)
  }
  if (browserProvenance.playwrightVersion !== policy.playwrightVersion) {
    hard.push(`playwright identity ${browserProvenance.playwrightVersion} != policy ${policy.playwrightVersion}`)
  }
  if (build?.toolchain?.node !== policy.nodeVersion) hard.push('build-provenance node identity mismatch')
  if (build?.toolchain?.playwrightVersion !== policy.playwrightVersion) hard.push('build-provenance playwright identity mismatch')

  // harness / protocol / fixture-source identity
  if (!isSha256(code.harness?.sha256)) hard.push('harness digest missing from report provenance')
  if (code.harness?.sha256 !== build?.measurementFiles?.[plan.harnessRel]) hard.push('harness digest does not match prepare-stage identity')
  if (!isSha256(code.protocol?.sha256)) hard.push('protocol digest missing from report provenance')
  if (code.protocol?.sha256 !== build?.measurementFiles?.[plan.protocolRel]) hard.push('protocol digest does not match prepare-stage identity')
  if (!isSha256(code.fixtureSource?.sha256)) hard.push('fixture-source digest missing from report provenance')
  if (code.fixtureSource?.sha256 !== build?.measurementFiles?.[plan.fixtureSourceRel]) hard.push('fixture-source digest does not match prepare-stage identity')
  if (!isSha256(code.governor?.sha256)) hard.push('governor digest missing from report provenance')
  if (code.governor?.sha256 !== build?.measurementFiles?.[plan.governorRel]) hard.push('governor digest does not match prepare-stage identity')

  // workflow / runner identity
  if (provenance.github?.actions !== true) hard.push('report was not produced under GitHub Actions')
  if (provenance.github?.repository !== policy.repository) hard.push(`repository identity ${provenance.github?.repository} != policy ${policy.repository}`)
  if (provenance.github?.runId !== env.GITHUB_RUN_ID) hard.push('run id identity mismatch')
  if (provenance.github?.runAttempt !== env.GITHUB_RUN_ATTEMPT) hard.push('run attempt identity mismatch')
  if (provenance.github?.job !== env.GITHUB_JOB) hard.push('job identity mismatch')
  if (provenance.github?.workflow !== env.GITHUB_WORKFLOW) hard.push('workflow identity mismatch')
  if (provenance.github?.workflowRef !== env.GITHUB_WORKFLOW_REF) hard.push('workflow ref identity mismatch')
  if (provenance.github?.workflowSha !== env.GITHUB_WORKFLOW_SHA) hard.push('workflow sha identity mismatch')
  hard.push(...mergeRefProblems(plan.measuredRef))
  hard.push(...mergeRefProblems(git.measuredRef))
  if (git.measuredRef !== plan.measuredRef) hard.push('measured ref identity mismatch')
  if (!runner.name || runner.name !== env.RUNNER_NAME) hard.push('runner name identity mismatch')
  if (runner.imageOs !== env.ImageOS || runner.imageVersion !== env.ImageVersion) hard.push('runner image identity mismatch')
  if (runner.os !== policy.runner.os) hard.push(`runner os ${runner.os} != policy ${policy.runner.os}`)

  // browser identity
  if (browserProvenance.requested !== browser) hard.push('requested browser provenance mismatch')
  if (browserProvenance.actualName !== browser) hard.push('actual launched browser provenance mismatch')
  if (!browserProvenance.actualVersion) hard.push('actual browser version missing')

  // measured code identity
  if (code.manifestSha256 !== plan.candidateManifestSha256) hard.push('candidate manifest digest mismatch')
  if (code.policySha256 !== plan.policySha256) hard.push('policy digest missing from report provenance')
  if (build?.policySha256 !== plan.policySha256) hard.push('build provenance policy identity mismatch')
  if (git.candidateSha !== plan.measuredSha) hard.push('candidate git sha identity mismatch')
  if (build?.candidate?.gitSha !== plan.measuredSha) hard.push('prepare-stage candidate git sha mismatch')
  if (plan.phaseExpectations?.[phase] !== undefined &&
      provenance.protocol?.expectation !== plan.phaseExpectations[phase]) {
    hard.push(`expectation provenance ${provenance.protocol?.expectation} != plan ${plan.phaseExpectations[phase]}`)
  }
  if (provenance.protocol?.phase !== phase) hard.push(`report phase ${provenance.protocol?.phase} != ${phase}`)
  if (provenance.protocol?.replicate !== replicate) hard.push(`report replicate ${provenance.protocol?.replicate} != ${replicate}`)

  // acquisition identity must be policy-derived, not candidate-derived
  const acquisition = policy.acquisition[phase]
  for (const [key, expected] of Object.entries({
    n: acquisition.n,
    batch: acquisition.batch,
    warmup: acquisition.warmup,
    bootstrap: acquisition.bootstrap,
    seed: deriveSeed(acquisition.seed, replicate),
  })) {
    if (provenance.protocol?.[key] !== expected) hard.push(`policy acquisition drift: ${key} ${provenance.protocol?.[key]} != ${expected}`)
  }
  // The harness reports the no-op band under its measurement name; policy owns it as equivalenceBand.
  // The mapping is explicit so a rename can never silently skip verification.
  const THRESHOLD_KEYS = [['epsilon', 'epsilon'], ['controlBand', 'controlBand'], ['noopBand', 'equivalenceBand'], ['maxPairLogSd', 'maxPairLogSd']]
  for (const [key, policyKey] of THRESHOLD_KEYS) {
    const expected = build?.thresholds?.[policyKey]
    if (!finite(expected)) {
      hard.push(`policy threshold ${policyKey} is not frozen; the run could not be verified against policy`)
    } else if (provenance.protocol?.[key] !== expected) {
      hard.push(`policy threshold drift: ${key} ${provenance.protocol?.[key]} != ${expected}`)
    }
  }

  // bundle identity
  if (bundles.candidate?.sha256 !== build?.candidate?.bundleSha256) hard.push('candidate bundle digest does not match prepare-stage build provenance')
  if (plan.candidate.mode === 'bundle-diff') {
    if (bundles.baseline?.sha256 !== build?.baseline?.bundleSha256) hard.push('baseline bundle digest does not match prepare-stage build provenance')
    if (git.baselineSha !== plan.candidate.baselineRef) hard.push('baseline git sha mismatch')
    if (bundles.candidate?.sha256 === bundles.baseline?.sha256) hard.push('bundle-diff produced identical bundle digests')
  } else if (bundles.baseline?.sha256 !== bundles.candidate?.sha256) {
    hard.push('option-pair must measure the same bundle digest in both arms')
  }

  // ambient gate identity
  hard.push(...verifyGateIdentity({ gate, build, policy, env, phase, browser, replicate }))

  return hard
}

/**
 * The ambient gate is part of the measurement instrument, so its identity is verified, not
 * assumed: the artifact must exist, be a pass, have been produced by this run's gate script at
 * this run's identity, and its recorded command must be the exact command measured.
 */
export function verifyGateIdentity({ gate, build, policy, env = process.env, phase, browser, replicate }) {
  const hard = []
  if (!gate) return ['ambient gate artifact missing; timing was never gated']
  if (gate.schema !== 'snapdom-r9-timing-gate-v1') hard.push('ambient gate schema mismatch')
  if (gate.pass !== true) hard.push('ambient gate did not pass')
  if (gate.sampling?.samples !== policy.gate.samples) hard.push('ambient gate sample-count drift')
  if (gate.sampling?.intervalMs !== policy.gate.intervalMs) hard.push('ambient gate interval drift')
  if (!Array.isArray(gate.samples) || gate.samples.length !== policy.gate.samples) hard.push('ambient gate sample evidence incomplete')
  if (gate.thresholds?.median !== policy.gate.maxMedianPct) hard.push('ambient gate median threshold drift')
  if (gate.thresholds?.mean !== policy.gate.maxMeanPct) hard.push('ambient gate mean threshold drift')
  if (gate.thresholds?.max !== policy.gate.maxPeakPct) hard.push('ambient gate peak threshold drift')
  if (!gate.settle || gate.settle.pass !== true) hard.push('post-setup settle stage did not pass')
  if (gate.settle?.thresholds?.intervalMs !== policy.gate.settle.intervalMs) hard.push('settle interval drift')
  if (gate.settle?.thresholds?.maxWaitMs !== policy.gate.settle.maxWaitMs) hard.push('settle max-wait drift')
  if (gate.settle?.thresholds?.consecutive !== policy.gate.settle.consecutive) hard.push('settle consecutive-window drift')
  if (gate.settle?.thresholds?.maxCpuPercent !== policy.gate.settle.maxCpuPercent) hard.push('settle CPU threshold drift')
  if (!isSha256(gate.scriptSha256)) hard.push('ambient gate script digest missing')
  if (gate.scriptSha256 !== build?.measurementFiles?.[policy.gate.script]) hard.push('ambient gate script digest does not match prepare-stage identity')
  if (gate.hosted?.runId !== build?.github?.runId || gate.hosted?.runId !== env.GITHUB_RUN_ID) hard.push('ambient gate run id mismatch')
  // prepare/build provenance may come from an earlier workflow ATTEMPT when GitHub reruns only
  // failed jobs. Attempt identity is cell-local: the report and ambient gate must match the CURRENT
  // attempt, while the immutable prepared artifact is joined by run_id / SHA / policy / file hashes.
  if (gate.hosted?.runAttempt !== env.GITHUB_RUN_ATTEMPT) hard.push('ambient gate run attempt mismatch')
  if (gate.hosted?.job !== env.GITHUB_JOB) hard.push('ambient gate job identity mismatch')
  if (gate.hosted?.runnerName !== env.RUNNER_NAME) hard.push('ambient gate runner identity mismatch')
  if (gate.hosted?.workflow !== env.GITHUB_WORKFLOW) hard.push('ambient gate workflow identity mismatch')
  if (gate.hosted?.workflowRef !== env.GITHUB_WORKFLOW_REF) hard.push('ambient gate workflow-ref identity mismatch')
  if (gate.hosted?.workflowSha !== env.GITHUB_WORKFLOW_SHA) hard.push('ambient gate workflow-sha identity mismatch')

  const command = gate.command || []
  const expected = `lane6-scratch/r9/run-candidate.mjs`
  if (!command.includes(expected)) hard.push(`ambient gate did not wrap ${expected}`)
  if (!command.includes(`--phase=${phase}`)) hard.push(`ambient gate command does not name phase ${phase}`)
  if (!command.includes(`--browser=${browser}`)) hard.push(`ambient gate command does not name browser ${browser}`)
  if (!command.includes(`--replicate=${replicate}`)) hard.push(`ambient gate command does not name replicate ${replicate}`)
  return hard
}

/* ------------------------------------------------------------------ run-level evidence ------- */

/**
 * Judges one fresh-runner cell. Runner-level decisions establish evidence validity only; they can
 * never contribute a promotion verdict. All numeric inference happens at the aggregate.
 */
export function judgeRunEvidence({ plan, policy, report, build, gate, env, phase, browser, replicate }) {
  const expectation = plan.phaseExpectations[phase]
  const hard = verifyRunIdentities({ plan, report, build, gate, policy, env, phase, browser, replicate })

  const selection = plan.selection
  const observed = Object.keys(report.fixtures || {})
  const expectedFixtures = [...selection.selected]
  if (observed.length !== expectedFixtures.length || !expectedFixtures.every((name) => observed.includes(name))) {
    hard.push(`fixture identity mismatch expected=[${expectedFixtures.join(',')}] observed=[${observed.join(',')}]`)
  }

  const scientific = []
  const fixtures = {}
  for (const name of expectedFixtures) {
    const observedFixture = report.fixtures?.[name]
    if (!observedFixture) continue
    const reasons = []
    if (observedFixture.parity !== true) reasons.push('raw parity failed')
    if (observedFixture.controlsPass !== true) reasons.push('A/A and B/B equivalence controls failed')
    if (observedFixture.candidate?.logPoint === undefined || !finite(observedFixture.candidate?.logPoint)) {
      reasons.push('runner-level log-effect point estimate missing')
    }
    const blocks = observedFixture.candidate?.logRatios?.blocks
    if (!Array.isArray(blocks) || blocks.length !== policy.acquisition[phase].n) {
      reasons.push(`raw observation blocks missing or not exactly ${policy.acquisition[phase].n}`)
    }
    fixtures[name] = {
      primary: selection.primary.includes(name),
      guard: selection.guards.includes(name),
      knownNoOp: selection.noOps.includes(name),
      parity: observedFixture.parity === true,
      controlsPass: observedFixture.controlsPass === true,
      stabilityPass: observedFixture.stabilityPass === true,
      noOpEquivalent: observedFixture.noOpEquivalent === true,
      logPoint: observedFixture.candidate?.logPoint,
      pct: observedFixture.candidate?.pct,
      ci95: observedFixture.candidate?.ci95,
      maxPairLogSd: observedFixture.maxPairLogSd,
      rawMaxCov: observedFixture.rawMaxCov,
      observations: Array.isArray(blocks) ? blocks.length : 0,
      reasons,
    }
    scientific.push(...reasons.map((reason) => `${name}: ${reason}`))
  }

  // Every run decision carries the exact candidate and policy identity it was measured under, so
  // the aggregate can reject cross-candidate or cross-policy mixing without trusting filenames.
  const identity = {
    schema: RUN_DECISION_SCHEMA,
    candidateId: plan.candidateId,
    manifestSha256: plan.candidateManifestSha256,
    policySha256: plan.policySha256,
    measuredSha: plan.measuredSha,
    measuredRef: plan.measuredRef,
    expectation,
    phase,
    browser,
    replicate,
    promotable: false,
    promotableEver: false,
    fixtures,
  }

  if (hard.length) {
    return { ...identity, verdict: VERDICTS.PROVENANCE_FAILURE, reasons: hard, scientific, evidenceUsable: false }
  }

  const evidenceUsable = scientific.length === 0
  return {
    ...identity,
    verdict: evidenceUsable ? 'EVIDENCE_VALID' : VERDICTS.INCOMPLETE_EVIDENCE,
    reasons: scientific,
    scientific,
    evidenceUsable,
  }
}

/* ------------------------------------------------------------------ runner-level inference --- */

const T95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
  9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
  16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
}
const tCritical95 = (df) => T95[Math.min(20, Math.max(1, df))] ?? 1.96

/**
 * The single inference primitive: a Student-t 95% CI across fresh-runner log-effect point
 * estimates. Raw samples stay runner-local; only one number per runner crosses the runner boundary.
 */
export function runnerLevelEffect(points) {
  const usable = points.filter(finite)
  if (usable.length < 2) {
    return { available: false, logPoint: null, pct: null, ci95: null, runnerSdLog: null, n: usable.length }
  }
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length
  const variance = usable.reduce((a, b) => a + (b - mean) ** 2, 0) / (usable.length - 1)
  const sd = Math.sqrt(variance)
  const half = tCritical95(usable.length - 1) * sd / Math.sqrt(usable.length)
  return {
    available: true,
    logPoint: mean,
    pct: pct(mean),
    ci95: [pct(mean - half), pct(mean + half)],
    runnerSdLog: sd,
    n: usable.length,
  }
}

/** Every preregistered cell for a phase. All of them are mandatory. */
export function expectedCells(candidate, policy, phase) {
  const spec = policy.phases[phase]
  const replicates = spec.replicates
  if (!Number.isInteger(replicates) || replicates < 1) {
    throw new GovernorRefusal(`policy.phases.${phase}.replicates is not frozen`, { phase })
  }
  const cells = []
  for (const browser of spec.browsers) {
    for (let replicate = 0; replicate < replicates; replicate += 1) cells.push({ browser, replicate })
  }
  return cells
}

export function cellKey(browser, replicate) {
  return `${browser}:${replicate}`
}

/**
 * Runner-level aggregation is the primary and only inference. A phase is adjudicated only when
 * every preregistered cell exists and is evidence-usable; a single missing or unusable cell makes
 * the phase INCOMPLETE_EVIDENCE, never a partial claim.
 */
export function aggregatePhase({ plan, policy, phase, decisions }) {
  const spec = policy.phases[phase]
  const expectation = plan.phaseExpectations[phase]
  let cells
  try {
    cells = expectedCells(plan.candidate, policy, phase)
  } catch (error) {
    return {
      schema: AGGREGATE_SCHEMA,
      candidateId: plan.candidateId,
      manifestSha256: plan.candidateManifestSha256,
      policySha256: plan.policySha256,
      measuredSha: plan.measuredSha,
      measuredRef: plan.measuredRef,
      verdict: VERDICTS.NO_CLAIM,
      promotable: false,
      expectation,
      phase,
      frozen: false,
      reasons: [error.message],
      blockers: ['POLICY_NOT_FROZEN'],
      unfrozenSlots: unfrozenSlots(policy),
      browsers: {},
      evidenceCells: { expected: 0, observed: 0, usable: 0 },
    }
  }

  const byKey = new Map()

  const blockers = []
  const hard = []
  for (const decision of decisions) {
    if (decision.schema !== RUN_DECISION_SCHEMA) hard.push(`unexpected decision schema ${decision.schema}`)
    if (decision.candidateId !== plan.candidateId) hard.push(`candidate id mismatch across decisions (${decision.candidateId})`)
    if (decision.manifestSha256 !== plan.candidateManifestSha256) hard.push('manifest digest mismatch across decisions')
    if (decision.policySha256 !== plan.policySha256) hard.push('policy digest mismatch across decisions')
    if (decision.phase !== phase) hard.push(`decision phase mismatch (${decision.phase})`)
    if (decision.promotableEver !== false) hard.push('runner-level decision claims promotability; refused')
    byKey.set(cellKey(decision.browser, decision.replicate), decision)
  }

  const observedKeys = new Set(byKey.keys())
  const missing = []
  for (const cell of cells) {
    const key = cellKey(cell.browser, cell.replicate)
    if (!observedKeys.has(key)) {
      missing.push(key)
      continue
    }
    const decision = byKey.get(key)
    if (decision.verdict === VERDICTS.PROVENANCE_FAILURE) {
      blockers.push('PROVENANCE_FAILURE')
      hard.push(`${key}: PROVENANCE_FAILURE (${decision.reasons.join('; ')})`)
    } else if (decision.verdict !== 'EVIDENCE_VALID') {
      missing.push(key)
    }
  }

  const extra = [...observedKeys].filter((key) => !cells.some((cell) => cellKey(cell.browser, cell.replicate) === key))
  for (const key of extra) hard.push(`unpreregistered decision ${key} present in aggregate input`)

  const selection = plan.selection
  const browsers = {}
  for (const browser of spec.browsers) {
    const replicateDecisions = cells
      .filter((cell) => cell.browser === browser)
      .map((cell) => byKey.get(cellKey(browser, cell.replicate)))
      .filter(Boolean)
    const fixtures = {}
    for (const name of selection.selected) {
      const effect = runnerLevelEffect(replicateDecisions.map((d) => d.fixtures?.[name]?.logPoint))
      fixtures[name] = {
        primary: selection.primary.includes(name),
        guard: selection.guards.includes(name),
        knownNoOp: selection.noOps.includes(name),
        ...effect,
        replicatePct: replicateDecisions.map((d) => d.fixtures?.[name]?.pct ?? null),
        allReplicatesControlsPass: replicateDecisions.every((d) => d.fixtures?.[name]?.controlsPass === true),
        allReplicatesParity: replicateDecisions.every((d) => d.fixtures?.[name]?.parity === true),
        allReplicatesNoOpEquivalent: replicateDecisions.every((d) => d.fixtures?.[name]?.noOpEquivalent === true),
      }
    }
    browsers[browser] = {
      replicates: replicateDecisions.map((d) => ({ replicate: d.replicate, verdict: d.verdict })),
      fixtures,
    }
  }

  const evidenceCells = {
    expected: cells.length,
    observed: byKey.size,
    usable: cells.length - missing.length,
  }

  const frozen = promotionFrozen(policy)
  const base = {
    schema: AGGREGATE_SCHEMA,
    candidateId: plan.candidateId,
    manifestSha256: plan.candidateManifestSha256,
    policySha256: plan.policySha256,
    measuredSha: plan.measuredSha,
    measuredRef: plan.measuredRef,
    expectation,
    phase,
    frozen,
    unfrozenSlots: unfrozenSlots(policy),
    thresholds: frozen ? { ...policy.promotion } : null,
    browsers,
    evidenceCells,
  }

  if (hard.length) return { ...base, verdict: VERDICTS.PROVENANCE_FAILURE, promotable: false, reasons: hard, blockers: [...new Set(['PROVENANCE_FAILURE', ...blockers])] }
  if (missing.length) {
    return {
      ...base,
      verdict: VERDICTS.INCOMPLETE_EVIDENCE,
      promotable: false,
      reasons: [`missing or unusable preregistered cells: ${missing.join(', ')}`],
      blockers: [...new Set(['INCOMPLETE_EVIDENCE', ...blockers])],
    }
  }

  const scientific = []
  for (const [browser, group] of Object.entries(browsers)) {
    for (const [name, fixture] of Object.entries(group.fixtures)) {
      if (!fixture.allReplicatesControlsPass) scientific.push(`${browser}/${name}: at least one fresh runner failed A/A or B/B controls`)
      if (!fixture.allReplicatesParity) scientific.push(`${browser}/${name}: at least one fresh runner failed raw parity`)
      if (!fixture.available) scientific.push(`${browser}/${name}: runner-level inference requires >= 2 fresh runners`)
    }
  }

  if (!frozen) {
    return {
      ...base,
      verdict: VERDICTS.NO_CLAIM,
      promotable: false,
      reasons: [
        ...scientific,
        `promotion policy is not frozen (${(base.unfrozenSlots || []).join(', ')}); hosted calibration ${policy.promotion.owner.runId} owns these values`,
      ],
      blockers: [...new Set(['POLICY_NOT_FROZEN'])],
    }
  }

  const evaluated = evaluateExpectation({ expectation, policy, browsers, selection })
  const reasons = [...scientific, ...evaluated.reasons]
  const cleared = reasons.length === 0
  return {
    ...base,
    // Only a phase explicitly owned as promotable by policy may ever emit PROMOTABLE.
    // Mandatory guard phases have their own positive terminal state and remain non-promotable.
    verdict: reasons.length
      ? VERDICTS.NO_CLAIM
      : spec.promotable
        ? VERDICTS.PROMOTABLE
        : VERDICTS.GUARD_CLEARED,
    promotable: cleared && spec.promotable,
    cleared,
    reasons,
    blockers: reasons.length ? [...new Set(['GATES_NOT_CLEARED'])] : [],
    inference: evaluated,
  }
}

/** Closed-set expectation semantics, evaluated on runner-level aggregates only. */
export function evaluateExpectation({ expectation, policy, browsers, selection }) {
  const reasons = []
  const promotion = policy.promotion
  const epsilonPct = promotion.epsilon * 100
  const equivalencePct = promotion.equivalenceBand * 100
  const nonRegressionPct = promotion.nonRegressionBand * 100
  const within = (fixture, bandPct) => fixture.ci95 && fixture.ci95[0] >= -bandPct && fixture.ci95[1] <= bandPct

  for (const [browser, group] of Object.entries(browsers)) {
    for (const [name, fixture] of Object.entries(group.fixtures)) {
      if (!fixture.allReplicatesNoOpEquivalent && fixture.knownNoOp) {
        reasons.push(`${browser}/${name}: pre-registered no-op effect did not prove equivalence on every runner`)
      }
      if (!fixture.available) continue

      if (expectation === 'CALIBRATION') {
        if (!within(fixture, equivalencePct)) {
          reasons.push(`${browser}/${name}: self-null calibration effect is not inside ±${equivalencePct.toFixed(2)}%`)
        }
      } else if (expectation === 'IMPROVEMENT') {
        if (fixture.primary) {
          if (!(fixture.ci95[1] < -epsilonPct)) {
            reasons.push(`${browser}/${name}: runner-level CI does not clear the ±${epsilonPct.toFixed(2)}% improvement epsilon`)
          }
        } else if (fixture.guard) {
          if (fixture.ci95[0] > nonRegressionPct) {
            reasons.push(`${browser}/${name}: guard fixture shows a significant regression`)
          }
        }
      } else if (expectation === 'EQUIVALENCE') {
        if (!within(fixture, equivalencePct)) {
          reasons.push(`${browser}/${name}: runner-level CI is outside the ±${equivalencePct.toFixed(2)}% equivalence band`)
        }
      } else if (expectation === 'NONREGRESSION') {
        if (fixture.ci95[0] > nonRegressionPct) {
          reasons.push(`${browser}/${name}: runner-level CI shows a significant regression`)
        }
      } else {
        throw new GovernorRefusal(`unknown expectation ${expectation}`, { expectation })
      }
    }
  }

  if (isPromotableExpectation(expectation)) {
    if (selection.guards.length < policy.improvement.minGuardFixtures) {
      reasons.push(`${expectation} requires >= ${policy.improvement.minGuardFixtures} guard fixture(s)`)
    }
    if (selection.noOps.length < policy.improvement.minKnownNoOpFixtures) {
      reasons.push(`${expectation} requires >= ${policy.improvement.minKnownNoOpFixtures} known no-op control(s)`)
    }
  }

  return { expectation, reasons, promotable: reasons.length === 0 }
}

/* ------------------------------------------------------------------ scout -------------------- */

export const SCOUT_KILL_STATES = Object.freeze([
  VERDICTS.PROVENANCE_FAILURE,
  VERDICTS.INCOMPLETE_EVIDENCE,
])

/**
 * Scout may kill. It may never promote: a scout decision is structurally incapable of carrying a
 * promotable verdict, so a passing scout contributes nothing to any later claim.
 */
export function scoutVerdict(decision) {
  if (decision.promotableEver !== false) {
    throw new GovernorRefusal('scout decision claims promotability; refused', {})
  }
  if (decision.verdict === VERDICTS.PROVENANCE_FAILURE) return { killed: true, reason: 'scout provenance failure', verdict: VERDICTS.SCOUT_KILL }
  if (decision.verdict !== 'EVIDENCE_VALID') return { killed: true, reason: `scout evidence incomplete: ${decision.reasons.join('; ')}`, verdict: VERDICTS.SCOUT_KILL }
  return { killed: false, reason: '', verdict: 'SCOUT_CLEARED' }
}

/* ------------------------------------------------------------------ closeout ---------------- */

/**
 * Closeout is fail-closed on evidence presence. It is structurally incapable of reporting success
 * when a preregistered phase contributed nothing, and it separates "no claim" from "success".
 */
export function closeoutVerdict({ candidateId, policy, phases }) {
  const phasesOut = []
  const blockers = []
  let hasProvenanceFailure = false
  let hasIncompleteEvidence = false
  let noClaim = false

  const push = (phase, verdict, reasons = [], evidenceCells = null) => {
    const spec = policy.phases[phase] || {}
    const entry = {
      phase,
      role: spec.role,
      ownsPromotion: !!spec.promotable,
      mandatory: !!spec.mandatory,
      verdict,
      reasons,
      evidenceCells,
      failClosed: verdict === VERDICTS.PROVENANCE_FAILURE ||
        verdict === VERDICTS.INCOMPLETE_EVIDENCE ||
        verdict === VERDICTS.SCOUT_KILL,
    }
    phasesOut.push(entry)
    if (verdict === VERDICTS.PROVENANCE_FAILURE) {
      hasProvenanceFailure = true
      blockers.push(`${phase}: PROVENANCE_FAILURE`)
    } else if (verdict === VERDICTS.INCOMPLETE_EVIDENCE || verdict === VERDICTS.SCOUT_KILL) {
      hasIncompleteEvidence = true
      blockers.push(`${phase}: ${verdict}`)
    } else if (verdict === VERDICTS.NO_CLAIM) {
      noClaim = true
    }
    return entry
  }

  // Scout is a kill-only admission phase. A cleared scout is permission to continue, never evidence
  // of improvement. Missing scout state is an incomplete pipeline because the hosted workflow
  // always preregisters and enters it before inference.
  const scout = phases.scout?.scout || null
  if (!scout) {
    push('scout', VERDICTS.INCOMPLETE_EVIDENCE, ['scout produced no decision'])
  } else if ([VERDICTS.SCOUT_CLEARED, VERDICTS.SCOUT_KILL].includes(scout.verdict)) {
    push('scout', scout.verdict, scout.reason ? [scout.reason] : [])
  } else {
    push('scout', VERDICTS.INCOMPLETE_EVIDENCE, [`scout carried invalid verdict ${scout.verdict}`])
  }

  // Chromium confirmation is the ONLY phase that can own a promotion claim.
  const confirm = phases.confirm?.aggregate || null
  if (!confirm) {
    push('confirm', VERDICTS.INCOMPLETE_EVIDENCE, ['confirm aggregate missing'])
  } else {
    push('confirm', confirm.verdict, confirm.reasons || [], confirm.evidenceCells || null)
    if (confirm.verdict === VERDICTS.GUARD_CLEARED) {
      hasIncompleteEvidence = true
      blockers.push('confirm: guard-only verdict on promotion-owning phase')
    }
  }

  // Guards are mandatory only after Chromium actually clears a promotable claim. A clean
  // Chromium NO_CLAIM intentionally skips them and remains a clean NO_CLAIM.
  const confirmClaims = confirm?.verdict === VERDICTS.PROMOTABLE
  const guard = phases.engineGuard?.aggregate || null
  if (confirmClaims) {
    if (!guard) {
      push('engineGuard', VERDICTS.INCOMPLETE_EVIDENCE, ['mandatory engine guard aggregate missing'])
    } else if (guard.verdict === VERDICTS.PROMOTABLE) {
      push('engineGuard', VERDICTS.PROVENANCE_FAILURE,
        ['engineGuard illegally claimed PROMOTABLE; guard phases never own promotion'],
        guard.evidenceCells || null)
    } else {
      push('engineGuard', guard.verdict, guard.reasons || [], guard.evidenceCells || null)
    }
  } else if (guard) {
    // If a guard artifact exists even though Chromium did not claim promotion, retain it for
    // provenance and fail closed on integrity errors, but it cannot resurrect the claim.
    if (guard.verdict === VERDICTS.PROMOTABLE) {
      push('engineGuard', VERDICTS.PROVENANCE_FAILURE,
        ['engineGuard illegally claimed PROMOTABLE; guard phases never own promotion'],
        guard.evidenceCells || null)
    } else {
      push('engineGuard', guard.verdict, guard.reasons || [], guard.evidenceCells || null)
    }
  }

  const confirmEvidence = confirm?.evidenceCells?.usable || 0
  const zeroEvidence = confirmEvidence === 0
  if (zeroEvidence && !hasProvenanceFailure) {
    hasIncompleteEvidence = true
    blockers.push('confirm: no usable runner-level evidence')
  }

  const guardCleared = !confirmClaims || guard?.verdict === VERDICTS.GUARD_CLEARED
  let outcome
  if (hasProvenanceFailure) outcome = VERDICTS.PROVENANCE_FAILURE
  else if (hasIncompleteEvidence) outcome = VERDICTS.INCOMPLETE_EVIDENCE
  else if (!promotionFrozen(policy)) outcome = VERDICTS.NO_CLAIM
  else if (confirmClaims && guardCleared && !noClaim) outcome = VERDICTS.PROMOTABLE
  else outcome = VERDICTS.NO_CLAIM

  return {
    schema: CLOSEOUT_SCHEMA,
    candidateId,
    policySha256: null,
    frozen: promotionFrozen(policy),
    unfrozenSlots: unfrozenSlots(policy),
    outcome,
    promotable: outcome === VERDICTS.PROMOTABLE,
    isSuccess: outcome === VERDICTS.PROMOTABLE,
    isEvidenceFailure: outcome === VERDICTS.PROVENANCE_FAILURE || outcome === VERDICTS.INCOMPLETE_EVIDENCE,
    blockedBy: [...new Set(blockers)],
    reasons: [...new Set(blockers)],
    phases: phasesOut,
    zeroEvidence,
  }
}

/** Summary text for a closeout document. Never describes zero evidence as success. */
export function closeoutSummary(closeout) {
  const lines = [
    '### snapDOM R9 hosted benchmark closeout',
    '',
    `- candidate: \`${closeout.candidateId}\``,
    `- promotion policy: ${closeout.frozen ? 'frozen' : `NOT frozen — ${closeout.unfrozenSlots.join(', ')}`}`,
    '',
  ]
  for (const entry of closeout.phases) {
    lines.push(`- ${entry.phase} (${entry.role}): \`${entry.verdict}\``)
    for (const reason of entry.reasons || []) lines.push(`  - ${reason}`)
  }
  lines.push('')
  if (closeout.outcome === VERDICTS.PROMOTABLE) {
    lines.push('**EVIDENCE ELIGIBLE.** This is evidence eligibility under the frozen policy, not an automatic code promotion.')
  } else if (closeout.outcome === VERDICTS.NO_CLAIM) {
    lines.push('**NO PERFORMANCE CLAIM.** Evidence was complete and valid but supports no promotable claim under the frozen policy.')
  } else {
    lines.push(`**EVIDENCE FAILURE (${closeout.blockedBy.join(', ')}).** Zero or unusable evidence can never render as success.`)
  }
  return lines.join('\n')
}
