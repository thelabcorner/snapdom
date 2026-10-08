import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const runner = fs.readFileSync(new URL('../../r10/assets-bench.mjs', import.meta.url),'utf8')
const workflow = fs.readFileSync(new URL('../../../.github/workflows/r12-bitmap-pss.yml', import.meta.url),'utf8')
const preparation = fs.readFileSync(new URL('../../r10/prepare.mjs', import.meta.url),'utf8')
test('R12 compares two AS-BLOB sources with identical Blob route expectations', () => {
  assert.match(runner,/both R12 sides must post one exact fetched Blob/)
  assert.match(runner,/for \(const side of \['baseline','candidate'\]\)/)
  assert.match(runner,/assertWarmCandidateRoute\(condition, observed.routes/)
  assert.equal(runner.includes('baseline memory page exposed candidate route counters'),false)
  assert.equal(runner.includes('baseline did not post exactly one large string payload'),false)
})
test('R12 native PSS evidence pins frozen candidate and frozen AS-BLOB baseline', () => {
  assert.match(workflow,/CANDIDATE_SHA: ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b/)
  assert.match(workflow,/BASELINE_SHA: d391556b80be7a6d97bc4834d2ce6e24137515b2/)
  assert.match(runner,/settleCdpProcessPss\(cdp, PSS_SETTLE_POLICY\)/)
  assert.match(runner,/candidateMinusBaselineRetentionKb/)
  assert.match(workflow,/matrix:\n {8}replicate: \[0, 1, 2, 3, 4, 5\]/)
})

test('R12 provenance hashes the R12 workflow and does not require absent R10 YAML', () => {
  assert.ok(workflow.includes('prepare.mjs --workflow=.github/workflows/r12-bitmap-pss.yml'))
  assert.ok(preparation.includes("const workflowRel = arg('workflow', '.github/workflows/r10-asset-bench.yml')"))
  assert.ok(preparation.includes('const measurementFiles = [') && preparation.includes('  workflowRel,'))
})
