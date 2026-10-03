/**
 * Browser-free contract tests for the R9 governor v2.
 *
 * These exercise the pure functions and the state machine in governor.mjs against synthetic
 * evidence. No browser is launched, no Playwright import happens, and no network is touched:
 * `import ... from '../governor.mjs'` pulls in node builtins only.
 *
 *   node --test lane6-scratch/r9/tests/governor.contract.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATE_SCHEMA,
  EXPECTATIONS,
  GovernorRefusal,
  PLAN_SCHEMA,
  PROMOTABLE_EXPECTATIONS,
  RUN_DECISION_SCHEMA,
  VERDICTS,
  aggregatePhase,
  assertCandidateCannotLoosen,
  assertFixtureSelection,
  assertHostedEnvironment,
  closeoutSummary,
  closeoutVerdict,
  deriveSeed,
  hostedEnvironmentProblems,
  judgeRunEvidence,
  mergeRefProblems,
  promotionFrozen,
  resolveExpectation,
  runnerLevelEffect,
  scoutVerdict,
  unfrozenSlots,
  validateCandidate,
  validatePolicy,
} from '../governor.mjs'

const HEX64 = 'A'.repeat(64)
const GIT_SHA = 'b'.repeat(40)

/* ------------------------------------------------------------------ fixtures ----------------- */

function policy(overrides = {}) {
  return {
    schema: 'snapdom-r9-governor-policy-v2',
    policyId: 'test',
    repository: 'thelabcorner/snapdom',
    nodeVersion: '22.21.1',
    playwrightVersion: '1.55.1',
    runner: { os: 'Linux', image: 'ubuntu-24.04' },
    gate: {
      script: 'lane6-scratch/r5/run-with-timing-gate.mjs',
      samples: 8,
      intervalMs: 1000,
      maxMedianPct: 10,
      maxMeanPct: 12,
      maxPeakPct: 20,
      settle: { intervalMs: 1000, maxWaitMs: 30000, consecutive: 3, maxCpuPercent: 20 },
    },
    expectations: [...EXPECTATIONS],
    phases: {
      scout: { browsers: ['chromium'], role: 'kill-only', promotable: false, mandatory: false, replicates: 1 },
      confirm: { browsers: ['chromium'], role: 'inference', promotable: true, mandatory: true, replicates: 3 },
      engineGuard: { browsers: ['firefox', 'webkit'], role: 'guard', promotable: false, mandatory: true, replicates: 2 },
    },
    acquisition: {
      scout: { n: 24, warmup: 5, bootstrap: 12000, batch: 4, seed: 39457 },
      confirm: { n: 30, warmup: 6, bootstrap: 20000, batch: 4, seed: 78731 },
      engineGuard: { n: 18, warmup: 4, bootstrap: 8000, batch: 3, seed: 118087 },
    },
    suites: {
      standing: { fixtures: ['light-20cards', 'cards400-safe'], knownNoOpFixtures: [] },
      focus: { fixtures: ['focus-20', 'no-focus-400'], knownNoOpFixtures: ['no-focus-400'] },
      pseudo: { fixtures: ['pseudo-20', 'no-pseudo-400'], knownNoOpFixtures: ['no-pseudo-400'] },
    },
    improvement: { minGuardFixtures: 1, minKnownNoOpFixtures: 1 },
    promotion: {
      frozen: true,
      frozenBy: 'test',
      owner: { runId: '37088609368' },
      unfrozenSlots: [],
      epsilon: 0.02,
      equivalenceBand: 0.03,
      nonRegressionBand: 0.05,
      controlBand: 0.03,
      maxPairLogSd: 0.15,
    },
    ...overrides,
  }
}

function candidate(overrides = {}) {
  return {
    schema: CANDIDATE_SCHEMA,
    id: 'test-candidate',
    description: 'synthetic',
    mode: 'option-pair',
    suite: 'standing',
    expect: 'IMPROVEMENT',
    baselineRef: null,
    base: {},
    opt: {},
    primaryFixtures: ['light-20cards'],
    guardFixtures: ['cards400-safe'],
    knownNoOpFixtures: ['cards400-safe'],
    ...overrides,
  }
}

const HOSTED_ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'thelabcorner/snapdom',
  GITHUB_RUN_ID: '37088609368',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_JOB: 'confirm',
  GITHUB_WORKFLOW: 'snapDOM v3 R9 hosted benchmark',
  GITHUB_WORKFLOW_REF: 'thelabcorner/snapdom/.github/workflows/r9-hosted-bench.yml@refs/heads/perf/v3-r9-x',
  GITHUB_WORKFLOW_SHA: GIT_SHA,
  RUNNER_NAME: 'HostedAgent',
  RUNNER_OS: 'Linux',
  ImageOS: 'ubuntu24',
  ImageVersion: '20240810.1.0',
}

function plan(policyRef, overrides = {}) {
  return {
    schema: PLAN_SCHEMA,
    candidateId: 'test-candidate',
    candidateManifest: 'lane6-scratch/r9/candidates/test.json',
    candidateManifestSha256: HEX64,
    policySha256: 'C'.repeat(64),
    measuredSha: GIT_SHA,
    measuredRef: 'refs/heads/perf/v3-r9-x',
    harnessRel: 'lane6-scratch/r9/bench-r9-controlled.mjs',
    protocolRel: 'lane6-scratch/r9/protocol.mjs',
    fixtureSourceRel: 'lane6-scratch/atlas/profiler/fixtures.mjs',
    governorRel: 'lane6-scratch/r9/governor.mjs',
    gateRel: 'lane6-scratch/r5/run-with-timing-gate.mjs',
    candidate: candidate(),
    selection: { fixtures: ['light-20cards', 'cards400-safe'], selected: ['light-20cards', 'cards400-safe'], primary: ['light-20cards'], guards: ['cards400-safe'], noOps: ['cards400-safe'] },
    phaseExpectations: { scout: 'CALIBRATION', confirm: 'IMPROVEMENT', engineGuard: 'NONREGRESSION' },
    frozen: promotionFrozen(policyRef),
    unfrozenSlots: unfrozenSlots(policyRef),
    thresholds: {
      epsilon: policyRef.promotion.epsilon,
      controlBand: policyRef.promotion.controlBand,
      equivalenceBand: policyRef.promotion.equivalenceBand,
      nonRegressionBand: policyRef.promotion.nonRegressionBand,
      maxPairLogSd: policyRef.promotion.maxPairLogSd,
    },
    acquisition: policyRef.acquisition,
    phaseSpec: policyRef.phases,
    gateSpec: policyRef.gate,
    runnerSpec: policyRef.runner,
    toolchainSpec: { nodeVersion: policyRef.nodeVersion, playwrightVersion: policyRef.playwrightVersion },
    ...overrides,
  }
}

function buildProvenance(policyRef) {
  return {
    schema: 'snapdom-r9-build-provenance-v2',
    candidateId: 'test-candidate',
    manifestSha256: HEX64,
    policySha256: 'C'.repeat(64),
    candidate: { gitSha: GIT_SHA, bundleSha256: 'D'.repeat(64), bundleBytes: 10 },
    baseline: { gitSha: null, bundleSha256: 'D'.repeat(64), bundleBytes: 10 },
    thresholds: policyRef.promotion.frozen ? {
      epsilon: policyRef.promotion.epsilon,
      controlBand: policyRef.promotion.controlBand,
      equivalenceBand: policyRef.promotion.equivalenceBand,
      maxPairLogSd: policyRef.promotion.maxPairLogSd,
    } : null,
    measurementFiles: {
      'lane6-scratch/r9/bench-r9-controlled.mjs': HEX64,
      'lane6-scratch/r9/protocol.mjs': HEX64,
      'lane6-scratch/atlas/profiler/fixtures.mjs': HEX64,
      'lane6-scratch/r9/governor.mjs': HEX64,
      'lane6-scratch/r5/run-with-timing-gate.mjs': HEX64,
    },
    toolchain: { node: policyRef.nodeVersion, playwrightVersion: policyRef.playwrightVersion },
    github: { runId: HOSTED_ENV.GITHUB_RUN_ID, runAttempt: HOSTED_ENV.GITHUB_RUN_ATTEMPT },
  }
}

function gateArtifact(policyRef, { browser, replicate, phase = 'confirm' }) {
  return {
    schema: 'snapdom-r9-timing-gate-v1',
    scriptSha256: HEX64,
    pass: true,
    sampling: { samples: policyRef.gate.samples, intervalMs: policyRef.gate.intervalMs },
    samples: new Array(policyRef.gate.samples).fill(0),
    settle: {
      pass: true,
      thresholds: {
        intervalMs: policyRef.gate.settle.intervalMs,
        maxWaitMs: policyRef.gate.settle.maxWaitMs,
        consecutive: policyRef.gate.settle.consecutive,
        maxCpuPercent: policyRef.gate.settle.maxCpuPercent,
      },
    },
    thresholds: { median: policyRef.gate.maxMedianPct, mean: policyRef.gate.maxMeanPct, max: policyRef.gate.maxPeakPct },
    hosted: {
      runId: HOSTED_ENV.GITHUB_RUN_ID,
      runAttempt: HOSTED_ENV.GITHUB_RUN_ATTEMPT,
      job: HOSTED_ENV.GITHUB_JOB,
      runnerName: HOSTED_ENV.RUNNER_NAME,
      workflow: HOSTED_ENV.GITHUB_WORKFLOW,
      workflowRef: HOSTED_ENV.GITHUB_WORKFLOW_REF,
      workflowSha: HOSTED_ENV.GITHUB_WORKFLOW_SHA,
    },
    command: [
      'node',
      'lane6-scratch/r9/run-candidate.mjs',
      '--phase=' + phase,
      '--browser=' + browser,
      '--replicate=' + replicate,
    ],
  }
}

function report(policyRef, { phase = 'confirm', browser = 'chromium', replicate = 0, logPoint = -0.05 } = {}) {
  const acquisition = policyRef.acquisition[phase]
  const fixtures = {}
  for (const name of ['light-20cards', 'cards400-safe']) {
    fixtures[name] = {
      parity: true,
      controlsPass: true,
      stabilityPass: true,
      noOpEquivalent: true,
      candidate: {
        logPoint: name === 'light-20cards' ? logPoint : 0,
        pct: logPoint * 100,
        ci95: [logPoint * 100 - 1, logPoint * 100 + 1],
        logRatios: { blocks: new Array(acquisition.n).fill(logPoint) },
      },
      baseNull: { ci95: [-0.5, 0.5] },
      optNull: { ci95: [-0.5, 0.5] },
      maxPairLogSd: 0.05,
      rawMaxCov: 0.05,
    }
  }
  return {
    schema: 'snapdom-r9-hosted-bench-v1',
    provenance: {
      github: {
        actions: true,
        repository: HOSTED_ENV.GITHUB_REPOSITORY,
        runId: HOSTED_ENV.GITHUB_RUN_ID,
        runAttempt: HOSTED_ENV.GITHUB_RUN_ATTEMPT,
        job: HOSTED_ENV.GITHUB_JOB,
        workflow: HOSTED_ENV.GITHUB_WORKFLOW,
        workflowRef: HOSTED_ENV.GITHUB_WORKFLOW_REF,
        workflowSha: HOSTED_ENV.GITHUB_WORKFLOW_SHA,
        ref: 'refs/heads/perf/v3-r9-x',
      },
      runner: {
        os: 'Linux',
        name: HOSTED_ENV.RUNNER_NAME,
        imageOs: HOSTED_ENV.ImageOS,
        imageVersion: HOSTED_ENV.ImageVersion,
      },
      node: { version: HOSTED_ENV.GITHUB_WORKFLOW_SHA ? `v${policyRef.nodeVersion}` : 'v' + policyRef.nodeVersion },
      toolchain: { node: 'v' + policyRef.nodeVersion },
      browser: { requested: browser, actualName: browser, actualVersion: '128.0.0', playwrightVersion: policyRef.playwrightVersion },
      code: {
        harness: { sha256: HEX64 },
        protocol: { sha256: HEX64 },
        fixtureSource: { sha256: HEX64 },
        governor: { sha256: HEX64 },
        manifestSha256: HEX64,
        policySha256: 'C'.repeat(64),
      },
      git: { candidateSha: GIT_SHA, baselineSha: GIT_SHA, measuredRef: 'refs/heads/perf/v3-r9-x' },
      bundles: { candidate: { sha256: 'D'.repeat(64) }, baseline: { sha256: 'D'.repeat(64) } },
      protocol: {
        mode: 'option-pair',
        suite: 'standing',
        expectation: plan(policyRef).phaseExpectations[phase],
        phase,
        replicate,
        n: acquisition.n,
        batch: acquisition.batch,
        warmup: acquisition.warmup,
        bootstrap: acquisition.bootstrap,
        seed: deriveSeed(acquisition.seed, replicate),
        epsilon: policyRef.promotion.epsilon,
        controlBand: policyRef.promotion.controlBand,
        noopBand: policyRef.promotion.equivalenceBand,
        maxPairLogSd: policyRef.promotion.maxPairLogSd,
        fixtureNames: ['light-20cards', 'cards400-safe'],
      },
    },
    fixtures,
  }
}

test('replicate seeds are derived once from the policy base seed and remain engine-independent', () => {
  assert.equal(deriveSeed(78731, 0), 78731)
  assert.equal(deriveSeed(78731, 1), 183460)
  assert.equal(deriveSeed(78731, 2), 288189)
  assert.equal(deriveSeed(118087, 3), 432274)
  assert.throws(() => deriveSeed(-1, 0), GovernorRefusal)
  assert.throws(() => deriveSeed(78731, -1), GovernorRefusal)
})

/* ------------------------------------------------------------------ policy ownership -------- */

test('candidate manifests may not carry any threshold, band or replicate count', () => {
  const clean = candidate()
  assert.equal(assertCandidateCannotLoosen(clean), true)

  for (const key of ['epsilon', 'controlBand', 'equivalenceBand', 'nonRegressionBand', 'maxPairLogSd', 'replicates', 'batch', 'thresholds', 'policy', 'nodeVersion', 'playwrightVersion']) {
    assert.throws(
      () => assertCandidateCannotLoosen(candidate({ [key]: 0.5 })),
      GovernorRefusal,
      'candidate must not be able to own ' + key,
    )
  }
  assert.throws(
    () => assertCandidateCannotLoosen(candidate({ phases: { confirm: { epsilon: 0.5 } } })),
    /policy fields/,
  )
})

test('fixture selection must match the exact suite allowlist', () => {
  const p = policy()
  assert.equal(assertFixtureSelection(candidate(), p).selected.length, 2)
  assert.throws(() => assertFixtureSelection(candidate({ primaryFixtures: ['not-a-fixture'] }), p), /allowlist/)
  assert.throws(() => assertFixtureSelection(candidate({ guardFixtures: ['light-20cards'] }), p), /overlap/)
  assert.throws(() => assertFixtureSelection(candidate({ primaryFixtures: [], guardFixtures: [] }), p), /selects no fixtures/)
  assert.throws(() => assertFixtureSelection(candidate({ suite: 'focus' }), p), /not in the focus allowlist/)
})

test('valid policy passes; an unfrozen policy reports every unfrozen slot', () => {
  const frozen = policy()
  assert.deepEqual(validatePolicy(frozen), [])
  assert.equal(promotionFrozen(frozen), true)

  const open = policy({
    phases: { ...frozen.phases, confirm: { ...frozen.phases.confirm, replicates: null }, engineGuard: { ...frozen.phases.engineGuard, replicates: null } },
    acquisition: { ...frozen.acquisition, confirm: { ...frozen.acquisition.confirm, batch: null } },
    promotion: { ...frozen.promotion, frozen: false, frozenBy: null, unfrozenSlots: ['phases.confirm.replicates'], epsilon: null, equivalenceBand: null, controlBand: null, maxPairLogSd: null, nonRegressionBand: null },
  })
  assert.equal(promotionFrozen(open), false)
  assert.ok(unfrozenSlots(open).includes('phases.confirm.replicates'))
  assert.ok(unfrozenSlots(open).includes('phases.engineGuard.replicates'))
  assert.ok(unfrozenSlots(open).includes('acquisition.confirm.batch'))
  assert.ok(unfrozenSlots(open).includes('promotion.epsilon'))
  assert.ok(unfrozenSlots(open).includes('promotion.equivalenceBand'))
})

/* ------------------------------------------------------------------ expectation semantics --- */

test('an absent or unknown expectation is refused, never defaulted', () => {
  const p = policy()
  assert.equal(resolveExpectation({ candidateExpect: 'IMPROVEMENT', phase: 'confirm', policy: p }), 'IMPROVEMENT')
  assert.equal(resolveExpectation({ phaseOverride: 'NONREGRESSION', candidateExpect: 'IMPROVEMENT', phase: 'confirm', policy: p }), 'NONREGRESSION')
  assert.equal(resolveExpectation({ candidateExpect: 'equivalence', phase: 'confirm', policy: p }), 'EQUIVALENCE')

  for (const bad of [undefined, null, '', 'explore', 'FASTER', 42, {}]) {
    assert.throws(
      () => resolveExpectation({ candidateExpect: bad, phase: 'confirm', policy: p }),
      GovernorRefusal,
      'expectation must fail closed: ' + JSON.stringify(bad),
    )
  }
  // CALIBRATION can never be attached to a promotable phase.
  assert.throws(
    () => resolveExpectation({ candidateExpect: 'CALIBRATION', phase: 'confirm', policy: p }),
    /cannot run a CALIBRATION expectation/,
  )
  assert.deepEqual(PROMOTABLE_EXPECTATIONS, ['IMPROVEMENT', 'EQUIVALENCE', 'NONREGRESSION'])
})

/* ------------------------------------------------------------------ hosted-only ------------- */

test('local browser execution is structurally refused', () => {
  assert.ok(hostedEnvironmentProblems({}).length > 0)
  assert.throws(() => assertHostedEnvironment({}), GovernorRefusal)
  assert.throws(() => assertHostedEnvironment({ ...HOSTED_ENV, GITHUB_ACTIONS: 'false' }), /GitHub Actions/)
  assert.throws(() => assertHostedEnvironment({ ...HOSTED_ENV, RUNNER_OS: 'Windows' }), /not Linux/)
  assert.equal(assertHostedEnvironment(HOSTED_ENV), true)
})

test('pull-request merge refs are refused as ambiguous identities', () => {
  assert.deepEqual(mergeRefProblems('refs/heads/perf/v3-r9-x'), [])
  assert.ok(mergeRefProblems('refs/pull/42/merge').length)
  assert.ok(mergeRefProblems('refs/pull/42/head').length)
  assert.ok(mergeRefProblems('refs/merge/queue').length)
})

/* ------------------------------------------------------------------ run-level evidence ------ */

test('a clean hosted run is evidence-valid and can never be promotable', () => {
  const p = policy()
  const decision = judgeRunEvidence({
    plan: plan(p),
    policy: p,
    report: report(p),
    build: buildProvenance(p),
    gate: gateArtifact(p, { browser: 'chromium', replicate: 0 }),
    env: HOSTED_ENV,
    phase: 'confirm',
    browser: 'chromium',
    replicate: 0,
  })
  assert.equal(decision.verdict, 'EVIDENCE_VALID')
  assert.equal(decision.evidenceUsable, true)
  assert.equal(decision.promotable, false)
  assert.equal(decision.promotableEver, false)
  assert.equal(decision.schema, RUN_DECISION_SCHEMA)
})

test('provenance mismatch is PROVENANCE_FAILURE and fails closed', () => {
  const p = policy()
  const base = {
    plan: plan(p), policy: p,
    build: buildProvenance(p),
    gate: gateArtifact(p, { browser: 'chromium', replicate: 0 }),
    env: HOSTED_ENV, phase: 'confirm', browser: 'chromium', replicate: 0,
  }

  const wrongHarness = report(p)
  wrongHarness.provenance.code.harness.sha256 = 'E'.repeat(64)
  assert.equal(judgeRunEvidence({ ...base, report: wrongHarness }).verdict, VERDICTS.PROVENANCE_FAILURE)

  const wrongWorkflow = report(p)
  wrongWorkflow.provenance.github.workflowSha = 'f'.repeat(40)
  assert.equal(judgeRunEvidence({ ...base, report: wrongWorkflow }).verdict, VERDICTS.PROVENANCE_FAILURE)

  const wrongRunnerImage = report(p)
  wrongRunnerImage.provenance.runner.imageVersion = '20200101.0.0.0'
  assert.equal(judgeRunEvidence({ ...base, report: wrongRunnerImage }).verdict, VERDICTS.PROVENANCE_FAILURE)

  const localReport = report(p)
  localReport.provenance.github.actions = false
  assert.equal(judgeRunEvidence({ ...base, report: localReport }).verdict, VERDICTS.PROVENANCE_FAILURE)

  const mergeRef = report(p)
  mergeRef.provenance.git.measuredRef = 'refs/pull/42/merge'
  assert.equal(judgeRunEvidence({ ...base, report: mergeRef }).verdict, VERDICTS.PROVENANCE_FAILURE)

  const badGate = gateArtifact(p, { browser: 'chromium', replicate: 0 })
  badGate.pass = false
  assert.equal(judgeRunEvidence({ ...base, report: report(p), gate: badGate }).verdict, VERDICTS.PROVENANCE_FAILURE)

  assert.equal(judgeRunEvidence({ ...base, report: report(p), gate: null }).verdict, VERDICTS.PROVENANCE_FAILURE)
})

test('unusable evidence is INCOMPLETE_EVIDENCE, distinct from a provenance failure', () => {
  const p = policy()
  const base = {
    plan: plan(p), policy: p,
    build: buildProvenance(p),
    gate: gateArtifact(p, { browser: 'chromium', replicate: 0 }),
    env: HOSTED_ENV, phase: 'confirm', browser: 'chromium', replicate: 0,
  }
  const parityFail = report(p)
  parityFail.fixtures['light-20cards'].parity = false
  const decision = judgeRunEvidence({ ...base, report: parityFail })
  assert.equal(decision.verdict, VERDICTS.INCOMPLETE_EVIDENCE)
  assert.equal(decision.evidenceUsable, false)
  assert.notEqual(decision.verdict, VERDICTS.PROVENANCE_FAILURE)

  const dropped = report(p)
  delete dropped.fixtures['cards400-safe']
  assert.equal(judgeRunEvidence({ ...base, report: dropped }).verdict, VERDICTS.PROVENANCE_FAILURE)
})

/* ------------------------------------------------------------------ runner-level inference --- */

test('runner-level inference needs at least two fresh runners and pools no raw samples', () => {
  assert.equal(runnerLevelEffect([0.1]).available, false)
  const two = runnerLevelEffect([-0.05, -0.05])
  assert.equal(two.available, true)
  assert.equal(two.n, 2)
  assert.ok(Array.isArray(two.ci95))
})

function runDecisions(p, count, overrides = {}) {
  return Array.from({ length: count }, (_, replicate) => {
    const decision = judgeRunEvidence({
      plan: plan(p),
      policy: p,
      report: report(p, { replicate, ...overrides }),
      build: buildProvenance(p),
      gate: gateArtifact(p, { browser: 'chromium', replicate }),
      env: HOSTED_ENV,
      phase: 'confirm',
      browser: 'chromium',
      replicate,
    })
    return decision
  })
}

function guardDecisions(p) {
  const out = []
  for (const browser of p.phases.engineGuard.browsers) {
    for (let replicate = 0; replicate < p.phases.engineGuard.replicates; replicate += 1) {
      out.push({
        schema: RUN_DECISION_SCHEMA,
        candidateId: 'test-candidate',
        manifestSha256: HEX64,
        policySha256: 'C'.repeat(64),
        phase: 'engineGuard',
        browser,
        replicate,
        expectation: 'NONREGRESSION',
        promotable: false,
        promotableEver: false,
        verdict: 'EVIDENCE_VALID',
        evidenceUsable: true,
        reasons: [],
        fixtures: {
          'light-20cards': {
            logPoint: 0,
            pct: 0,
            ci95: [-1, 1],
            parity: true,
            controlsPass: true,
            noOpEquivalent: true,
          },
          'cards400-safe': {
            logPoint: 0,
            pct: 0,
            ci95: [-1, 1],
            parity: true,
            controlsPass: true,
            noOpEquivalent: true,
          },
        },
      })
    }
  }
  return out
}

test('all preregistered replicas are mandatory: a missing cell is INCOMPLETE_EVIDENCE', () => {
  const p = policy()
  const full = runDecisions(p, 3)
  const ok = aggregatePhase({ plan: plan(p), policy: p, phase: 'confirm', decisions: full })
  assert.equal(ok.evidenceCells.expected, 3)
  assert.equal(ok.evidenceCells.usable, 3)
  assert.equal(ok.candidateId, 'test-candidate')
  assert.equal(ok.manifestSha256, HEX64)
  assert.equal(ok.policySha256, 'C'.repeat(64))
  assert.equal(ok.measuredSha, GIT_SHA)
  assert.equal(ok.measuredRef, 'refs/heads/perf/v3-r9-x')
  assert.equal(ok.verdict, VERDICTS.PROMOTABLE)
  assert.equal(ok.promotable, true)

  const partial = aggregatePhase({ plan: plan(p), policy: p, phase: 'confirm', decisions: full.slice(0, 2) })
  assert.equal(partial.verdict, VERDICTS.INCOMPLETE_EVIDENCE)
  assert.equal(partial.promotable, false)
  assert.match(partial.reasons.join(' '), /missing or unusable preregistered cells/)

  // A cell that ran but produced unusable evidence is as mandatory as a cell that never ran:
  // it must still block the phase rather than silently shrink the matrix.
  const degradedReport = report(p, { replicate: 2 })
  degradedReport.fixtures['light-20cards'].parity = false
  const unusable = aggregatePhase({
    plan: plan(p), policy: p, phase: 'confirm',
    decisions: [full[0], full[1], judgeRunEvidence({
      plan: plan(p), policy: p,
      report: degradedReport,
      build: buildProvenance(p),
      gate: gateArtifact(p, { browser: 'chromium', replicate: 2 }),
      env: HOSTED_ENV, phase: 'confirm', browser: 'chromium', replicate: 2,
    })],
  })
  assert.equal(unusable.verdict, VERDICTS.INCOMPLETE_EVIDENCE)
  assert.equal(unusable.promotable, false)
  assert.equal(unusable.evidenceCells.observed, 3)
  assert.ok(unusable.evidenceCells.usable < unusable.evidenceCells.expected)
})

test('an unpreregistered extra cell is a provenance failure, not a free extra sample', () => {
  const p = policy()
  const decisions = runDecisions(p, 3)
  const extra = { ...decisions[2], replicate: 3 }
  const aggregate = aggregatePhase({ plan: plan(p), policy: p, phase: 'confirm', decisions: [...decisions, extra] })
  assert.equal(aggregate.verdict, VERDICTS.PROVENANCE_FAILURE)
  assert.equal(aggregate.promotable, false)
})

test('a runner-level decision that claims promotability is refused', () => {
  const p = policy()
  const decisions = runDecisions(p, 3)
  decisions[1] = { ...decisions[1], promotableEver: true }
  assert.equal(
    aggregatePhase({ plan: plan(p), policy: p, phase: 'confirm', decisions }).verdict,
    VERDICTS.PROVENANCE_FAILURE,
  )
})

test('an unfrozen promotion policy can never yield PROMOTABLE even with perfect evidence', () => {
  const frozen = policy()
  const decisions = runDecisions(frozen, 3)

  const open = policy({
    phases: { ...frozen.phases, confirm: { ...frozen.phases.confirm, replicates: 3 } },
    acquisition: frozen.acquisition,
    promotion: {
      ...frozen.promotion,
      frozen: false,
      unfrozenSlots: ['promotion.epsilon', 'promotion.equivalenceBand', 'promotion.nonRegressionBand', 'promotion.controlBand', 'promotion.maxPairLogSd'],
      epsilon: null, equivalenceBand: null, nonRegressionBand: null, controlBand: null, maxPairLogSd: null,
    },
  })
  const aggregate = aggregatePhase({ plan: plan(open), policy: open, phase: 'confirm', decisions })
  assert.equal(aggregate.frozen, false)
  assert.equal(aggregate.verdict, VERDICTS.NO_CLAIM)
  assert.equal(aggregate.promotable, false)
  assert.ok(aggregate.reasons.join(' ').includes('not frozen'))
  assert.ok(aggregate.unfrozenSlots.includes('promotion.epsilon'))
})

test('an unfrozen replicate count cannot even be aggregated into a claim', () => {
  const frozen = policy()
  const open = policy({
    phases: { ...frozen.phases, confirm: { ...frozen.phases.confirm, replicates: null } },
    acquisition: frozen.acquisition,
    promotion: { ...frozen.promotion, frozen: false, unfrozenSlots: ['phases.confirm.replicates'] },
  })
  const aggregate = aggregatePhase({ plan: plan(open), policy: open, phase: 'confirm', decisions: [] })
  assert.equal(aggregate.verdict, VERDICTS.NO_CLAIM)
  assert.equal(aggregate.promotable, false)
  assert.deepEqual(aggregate.blockers, ['POLICY_NOT_FROZEN'])
})

test('engine guards can clear but can never own a promotion verdict', () => {
  const p = policy()
  const guard = aggregatePhase({
    plan: plan(p),
    policy: p,
    phase: 'engineGuard',
    decisions: guardDecisions(p),
  })
  assert.equal(guard.candidateId, 'test-candidate')
  assert.equal(guard.policySha256, 'C'.repeat(64))
  assert.equal(guard.verdict, VERDICTS.GUARD_CLEARED)
  assert.equal(guard.promotable, false)
  assert.equal(guard.cleared, true)
  assert.equal(guard.evidenceCells.expected, 4)
  assert.equal(guard.evidenceCells.usable, 4)
})

/* ------------------------------------------------------------------ scout ------------------- */

test('scout may kill but can never promote', () => {
  const clean = { verdict: 'EVIDENCE_VALID', promotableEver: false, reasons: [] }
  assert.equal(scoutVerdict(clean).killed, false)
  assert.equal(scoutVerdict(clean).verdict, 'SCOUT_CLEARED')

  assert.equal(scoutVerdict({ verdict: VERDICTS.PROVENANCE_FAILURE, promotableEver: false, reasons: ['x'] }).killed, true)
  const incomplete = scoutVerdict({ verdict: VERDICTS.INCOMPLETE_EVIDENCE, promotableEver: false, reasons: ['parity failed'] })
  assert.equal(incomplete.killed, true)
  assert.equal(incomplete.verdict, VERDICTS.SCOUT_KILL)

  assert.throws(() => scoutVerdict({ verdict: 'PROMOTABLE', promotableEver: true, reasons: [] }), GovernorRefusal)

  const p = policy()
  const decision = judgeRunEvidence({
    plan: plan(p), policy: p,
    report: report(p, { phase: 'scout' }),
    build: buildProvenance(p),
    gate: gateArtifact(p, { browser: 'chromium', replicate: 0, phase: 'scout' }),
    env: HOSTED_ENV, phase: 'scout', browser: 'chromium', replicate: 0,
  })
  assert.equal(decision.promotable, false)
  assert.equal(decision.promotableEver, false)
})

/* ------------------------------------------------------------------ closeout ---------------- */

test('closeout is fail-closed and requires a cleared mandatory guard for final promotion', () => {
  const p = policy()
  const scoutClear = { scout: { verdict: VERDICTS.SCOUT_CLEARED, reason: '' } }
  const confirmPromotable = {
    aggregate: {
      verdict: VERDICTS.PROMOTABLE,
      reasons: [],
      evidenceCells: { expected: 3, observed: 3, usable: 3 },
    },
  }
  const guardClear = {
    aggregate: {
      verdict: VERDICTS.GUARD_CLEARED,
      reasons: [],
      evidenceCells: { expected: 4, observed: 4, usable: 4 },
    },
  }

  const zero = closeoutVerdict({ candidateId: 'test-candidate', policy: p, phases: {} })
  assert.equal(zero.outcome, VERDICTS.INCOMPLETE_EVIDENCE)
  assert.equal(zero.promotable, false)
  assert.equal(zero.isSuccess, false)
  assert.equal(zero.zeroEvidence, true)
  assert.match(closeoutSummary(zero), /EVIDENCE FAILURE/)

  const killed = closeoutVerdict({
    candidateId: 'c',
    policy: p,
    phases: { scout: { scout: { verdict: VERDICTS.SCOUT_KILL, reason: 'scout provenance failure' } } },
  })
  assert.equal(killed.outcome, VERDICTS.INCOMPLETE_EVIDENCE)
  assert.equal(killed.isSuccess, false)

  // A clean Chromium NO_CLAIM intentionally skips the expensive engine guards and stays a clean
  // NO_CLAIM rather than being mislabelled as missing evidence.
  const noClaim = closeoutVerdict({
    candidateId: 'c',
    policy: p,
    phases: {
      scout: scoutClear,
      confirm: {
        aggregate: {
          verdict: VERDICTS.NO_CLAIM,
          reasons: ['gate not cleared'],
          evidenceCells: { expected: 3, observed: 3, usable: 3 },
        },
      },
    },
  })
  assert.equal(noClaim.outcome, VERDICTS.NO_CLAIM)
  assert.equal(noClaim.isSuccess, false)
  assert.match(closeoutSummary(noClaim), /NO PERFORMANCE CLAIM/)

  // A promotable Chromium claim without its mandatory guard is incomplete, never a success.
  const missingGuard = closeoutVerdict({
    candidateId: 'c',
    policy: p,
    phases: { scout: scoutClear, confirm: confirmPromotable },
  })
  assert.equal(missingGuard.outcome, VERDICTS.INCOMPLETE_EVIDENCE)
  assert.equal(missingGuard.promotable, false)

  const eligible = closeoutVerdict({
    candidateId: 'c',
    policy: p,
    phases: { scout: scoutClear, confirm: confirmPromotable, engineGuard: guardClear },
  })
  assert.equal(eligible.outcome, VERDICTS.PROMOTABLE)
  assert.equal(eligible.isSuccess, true)
  assert.match(closeoutSummary(eligible), /EVIDENCE ELIGIBLE/)

  // Guard phases are structurally forbidden from claiming PROMOTABLE themselves.
  const illegalGuardPromotion = closeoutVerdict({
    candidateId: 'c',
    policy: p,
    phases: {
      scout: scoutClear,
      confirm: confirmPromotable,
      engineGuard: {
        aggregate: {
          verdict: VERDICTS.PROMOTABLE,
          reasons: [],
          evidenceCells: { expected: 4, observed: 4, usable: 4 },
        },
      },
    },
  })
  assert.equal(illegalGuardPromotion.outcome, VERDICTS.PROVENANCE_FAILURE)
  assert.equal(illegalGuardPromotion.promotable, false)
})

/* ------------------------------------------------------------------ candidate schema ------- */

test('candidate validation rejects an incomplete manifest', () => {
  const p = policy()
  assert.deepEqual(validateCandidate(candidate(), p), [])
  assert.ok(validateCandidate(candidate({ schema: 'snapdom-r9-candidate-v1' }), p).length > 0)
  assert.ok(validateCandidate(candidate({ mode: 'bundle-diff', baselineRef: 'nope' }), p).length > 0)
  assert.ok(validateCandidate(candidate({ suite: 'unknown' }), p).length > 0)
})
