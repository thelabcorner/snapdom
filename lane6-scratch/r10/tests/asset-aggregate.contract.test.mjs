import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = process.cwd()
const script = path.resolve(ROOT, 'lane6-scratch/r10/asset-aggregate.mjs')

function fixtureDir(count = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdom-r10-aggregate-'))
  const input = path.join(dir, 'input')
  fs.mkdirSync(input, { recursive: true })

  const prepared = {
    schema: 'snapdom-r10-asblob-prepared-v1',
    candidateGitSha: 'a'.repeat(40),
    baselineGitSha: 'b'.repeat(40),
    playwrightVersion: '1.55.1',
    candidate: { sha256: 'C'.repeat(64) },
    baseline: { sha256: 'D'.repeat(64) },
    mechanism: { workerMinPayloadChars: 65536, maxImageBlobBytes: 67108864, retentionCapStatus: 'HYPOTHESIS' },
  }
  const preparedPath = path.join(dir, 'prepared.json')
  fs.writeFileSync(preparedPath, JSON.stringify(prepared))

  for (let r = 0; r < count; r++) {
    const condition = (role, logPoint, rss) => ({
      role,
      fixture: 'large',
      csp: 'none',
      sweep: role === 'null-memo' ? 'same' : 'scale',
      timing: { logPoint },
      memory: {
        candidateMinusBaselineRetentionKb: rss,
        candidateMinusBaselineSweepKb: 10 + r,
        candidateMinusBaselineTotalKb: rss + 10 + r,
        baseline: { warmupDeltaKb: 1000 + r, sweepDeltaKb: 50 + r, totalDeltaKb: 1050 + 2 * r },
        candidate: {
          warmupDeltaKb: 1000 + r + rss,
          sweepDeltaKb: 60 + 2 * r,
          totalDeltaKb: 1060 + 3 * r + rss,
        },
      },
    })
    const doc = {
      schema: 'snapdom-r10-asblob-runner-v1',
      replicate: r,
      provenance: {
        candidateGitSha: prepared.candidateGitSha,
        baselineGitSha: prepared.baselineGitSha,
        candidateBundleSha256: prepared.candidate.sha256,
        baselineBundleSha256: prepared.baseline.sha256,
        playwrightVersion: prepared.playwrightVersion,
        github: { runAttempt: '1' },
        runner: { imageVersion: 'test' },
        browser: { version: '140.0.0' },
      },
      fixtures: { large: { bytes: 1, sha256: 'E'.repeat(64) } },
      conditions: {
        'large-same': condition('null-memo', 0.001 * (r - 2.5), 5 + r),
        'large-scale': condition('claim', -0.08 + 0.002 * r, 100 + r),
      },
    }
    const nested = path.join(input, 'runner-' + r)
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'runner-r' + r + '.json'), JSON.stringify(doc))
  }
  return { dir, input, preparedPath, out: path.join(dir, 'summary.json') }
}

test('aggregate CLI consumes one point per runner and emits a complete summary', () => {
  const f = fixtureDir(6)
  const p = spawnSync(process.execPath, [
    script,
    '--input-dir=' + f.input,
    '--prepared=' + f.preparedPath,
    '--out=' + f.out,
    '--expected=6',
  ], { cwd: ROOT, encoding: 'utf8' })

  assert.equal(p.status, 0, p.stderr)
  const summary = JSON.parse(fs.readFileSync(f.out, 'utf8'))
  assert.equal(summary.state, 'EXPERIMENT_COMPLETE')
  assert.equal(summary.observedRunners, 6)
  assert.equal(summary.conditions['large-scale'].timing.n, 6)
  assert.ok(summary.conditions['large-scale'].timing.pct < 0)
  assert.equal(summary.performanceClaim, false)
})

test('aggregate CLI fails closed when a preregistered runner is missing', () => {
  const f = fixtureDir(5)
  const p = spawnSync(process.execPath, [
    script,
    '--input-dir=' + f.input,
    '--prepared=' + f.preparedPath,
    '--out=' + f.out,
    '--expected=6',
  ], { cwd: ROOT, encoding: 'utf8' })

  assert.notEqual(p.status, 0)
  const summary = JSON.parse(fs.readFileSync(f.out, 'utf8'))
  assert.equal(summary.state, 'INCOMPLETE_EVIDENCE')
  assert.deepEqual(summary.missing, [5])
  assert.equal(summary.performanceClaim, false)
})
