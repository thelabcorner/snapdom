import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PSS_SETTLE_POLICY, sha256 } from '../asset-bench-lib.mjs'

const ROOT = process.cwd()
const script = path.resolve(ROOT, 'lane6-scratch/r10/asset-aggregate.mjs')

function fixtureDir(count = 6, mutate = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdom-r10-aggregate-'))
  const input = path.join(dir, 'input')
  fs.mkdirSync(input, { recursive: true })

  const prepared = {
    schema: 'snapdom-r10-asblob-prepared-v1',
    measurementGitSha: 'f'.repeat(40),
    candidateGitSha: 'a'.repeat(40),
    baselineGitSha: 'b'.repeat(40),
    playwrightVersion: '1.55.1',
    nodeVersion: 'v22.21.1',
    candidate: { sha256: 'C'.repeat(64) },
    baseline: { sha256: 'D'.repeat(64) },
    mechanism: { workerMinPayloadChars: 65536, maxImageBlobBytes: 67108864, retentionCapStatus: 'HYPOTHESIS' },
    acquisition: {
      runnerReplicates: 6,
      repeats: 8,
      warmup: 2,
      timingPrimary: 'capture',
      timingSecondary: 'capture+toCanvas',
      memoryPrimary: 'pre-capture to post-warmup process-tree PSS growth',
      memorySettlePolicy: PSS_SETTLE_POLICY,
    },
    measurementFiles: {
      'lane6-scratch/r10/assets-bench.mjs': sha256(
        fs.readFileSync(path.resolve(ROOT, 'lane6-scratch/r10/assets-bench.mjs')),
      ),
    },
    github: { repository: 'thelabcorner/snapdom', runId: '12345' },
  }
  const preparedPath = path.join(dir, 'prepared.json')
  fs.writeFileSync(preparedPath, JSON.stringify(prepared))
  const preparedSha256 = sha256(fs.readFileSync(preparedPath))

  for (let r = 0; r < count; r++) {
    const memoryState = (side, stage, pssKb) => ({
      stable: true,
      pssKb,
      rendererPssKb: Math.round(pssKb * 0.6),
      rssKb: pssKb * 2,
      anonShmemKb: pssKb,
      settleRangePssKb: 128,
      settleDriftPssKb: 32,
      rendererPids: [side === 'baseline' ? 21 : 31],
      identityKey: side + ':10,' + side + ':11',
      processCount: 2,
      stage,
    })
    const condition = (role, logPoint, rss) => {
      const baselineInitial = 100000 + r
      const candidateInitial = 100000 + r
      const baselineWarm = baselineInitial + 1000 + r
      const candidateWarm = candidateInitial + 1000 + r + rss
      const baselineFinal = baselineWarm + 50 + r
      const candidateFinal = candidateWarm + 60 + 2 * r
      return {
        role,
        fixture: 'large',
        csp: 'none',
        sweep: role === 'null-memo' ? 'same' : 'scale',
        timing: {
          logPoint,
          renderLogPoint: logPoint / 3,
          totalLogPoint: logPoint / 2,
          orderBiasLog: 0.001 * (r - 2.5),
        },
        memory: {
          candidateMinusBaselineRetentionKb: rss,
          candidateMinusBaselineSweepKb: 10 + r,
          candidateMinusBaselineTotalKb: rss + 10 + r,
          baseline: {
            initial: memoryState('baseline', 'initial', baselineInitial),
            warmed: memoryState('baseline', 'warmed', baselineWarm),
            final: memoryState('baseline', 'final', baselineFinal),
            warmupDeltaKb: 1000 + r,
            sweepDeltaKb: 50 + r,
            totalDeltaKb: 1050 + 2 * r,
          },
          candidate: {
            initial: memoryState('candidate', 'initial', candidateInitial),
            warmed: memoryState('candidate', 'warmed', candidateWarm),
            final: memoryState('candidate', 'final', candidateFinal),
            warmupDeltaKb: 1000 + r + rss,
            sweepDeltaKb: 60 + 2 * r,
            totalDeltaKb: 1060 + 3 * r + rss,
          },
        },
      }
    }
    const doc = {
      schema: 'snapdom-r10-asblob-runner-v1',
      replicate: r,
      provenance: {
        measurementGitSha: prepared.measurementGitSha,
        candidateGitSha: prepared.candidateGitSha,
        baselineGitSha: prepared.baselineGitSha,
        candidateBundleSha256: prepared.candidate.sha256,
        baselineBundleSha256: prepared.baseline.sha256,
        preparedSha256,
        measurementFiles: prepared.measurementFiles,
        nodeVersion: prepared.nodeVersion,
        playwrightVersion: prepared.playwrightVersion,
        browser: { name: 'chromium', version: '140.0.0' },
        github: { repository: prepared.github.repository, runId: prepared.github.runId, runAttempt: '1' },
        acquisition: {
          repeats: prepared.acquisition.repeats,
          warmup: prepared.acquisition.warmup,
          memorySettlePolicy: prepared.acquisition.memorySettlePolicy,
        },
        runner: { imageOs: 'ubuntu24', imageVersion: 'test' },
      },
      fixtures: { large: { width: 1200, height: 800, bytes: 123, sha256: 'E'.repeat(64) } },
      conditions: {
        'large-same': condition('null-memo', 0.001 * (r - 2.5), 5 + r),
        'large-scale': condition('claim', -0.08 + 0.002 * r, 100 + r),
        'large-csp': {
          ...condition('worker-negative', 0.0015 * (r - 2.5), 10 + r),
          csp: 'worker-none',
        },
      },
    }
    if (mutate) mutate(doc, r, prepared)
    const nested = path.join(input, 'runner-' + r)
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'runner-r' + r + '.json'), JSON.stringify(doc))
  }
  return { dir, input, preparedPath, out: path.join(dir, 'summary.json') }
}

function runAggregate(f, expected = 6) {
  // Synthetic contract fixtures deliberately use fake immutable identities. Do not let the parent
  // GitHub Actions job inject its real run identity into this child; production aggregation keeps
  // those environment checks enabled.
  const env = { ...process.env }
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID']) delete env[key]
  return spawnSync(process.execPath, [
    script,
    '--input-dir=' + f.input,
    '--prepared=' + f.preparedPath,
    '--out=' + f.out,
    '--expected=' + expected,
  ], { cwd: ROOT, encoding: 'utf8', env })
}

test('aggregate CLI consumes exactly one complete point per runner', () => {
  const f = fixtureDir(6)
  const p = runAggregate(f)

  assert.equal(p.status, 0, p.stderr)
  const summary = JSON.parse(fs.readFileSync(f.out, 'utf8'))
  assert.equal(summary.state, 'EXPERIMENT_COMPLETE')
  assert.equal(summary.observedRunners, 6)
  assert.equal(summary.measurementGitSha, 'f'.repeat(40))
  assert.equal(summary.conditions['large-scale'].timing.capture.n, 6)
  assert.equal(summary.conditions['large-scale'].timing.endToEnd.n, 6)
  assert.ok(summary.conditions['large-scale'].timing.capture.pct < 0)
  assert.ok(summary.conditions['large-scale'].timing.endToEnd.pct < 0)
  assert.equal(summary.conditions['large-scale'].memory.candidateMinusBaselineRetentionKb.n, 6)
  assert.equal(summary.matchedMemoryControls['large-scale'].control, 'large-csp')
  assert.equal(summary.matchedMemoryControls['large-scale'].effectKb.n, 6)
  assert.equal(summary.performanceClaim, false)
})

test('aggregate CLI fails closed when a preregistered runner is missing', () => {
  const f = fixtureDir(5)
  const p = runAggregate(f)

  assert.notEqual(p.status, 0)
  const summary = JSON.parse(fs.readFileSync(f.out, 'utf8'))
  assert.equal(summary.state, 'INCOMPLETE_EVIDENCE')
  assert.deepEqual(summary.missing, [5])
  assert.equal(summary.performanceClaim, false)
})

test('aggregate CLI fails closed on wrong measurement identity', () => {
  const f = fixtureDir(6, (doc, r) => {
    if (r === 4) doc.provenance.measurementGitSha = '0'.repeat(40)
  })
  const p = runAggregate(f)

  assert.notEqual(p.status, 0)
  const summary = JSON.parse(fs.readFileSync(f.out, 'utf8'))
  assert.deepEqual(summary.wrongIdentity, [4])
})

test('aggregate CLI refuses a runner with missing or non-finite primary evidence', () => {
  const f = fixtureDir(6, (doc, r) => {
    if (r === 2) delete doc.conditions['large-scale'].timing.totalLogPoint
  })
  const p = runAggregate(f)

  assert.notEqual(p.status, 0)
  const summary = JSON.parse(fs.readFileSync(f.out, 'utf8'))
  assert.ok(summary.invalidEvidence.some((x) => x.includes('r2/large-scale')))
})

test('aggregate CLI refuses fixture identity drift', () => {
  const f = fixtureDir(6, (doc, r) => {
    if (r === 3) doc.fixtures.large.sha256 = '0'.repeat(64)
  })
  const p = runAggregate(f)

  assert.notEqual(p.status, 0)
  const summary = JSON.parse(fs.readFileSync(f.out, 'utf8'))
  assert.ok(summary.invalidEvidence.some((x) => x.includes('r3: fixture identity mismatch')))
})
