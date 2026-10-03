import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = process.cwd()
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/r10-icon-ceiling.yml'), 'utf8')

test('icon ceiling workflow is diagnostic-only and cross-engine by preregistration', () => {
  assert.match(workflow, /browser:\s*\[chromium, firefox, webkit\]/)
  assert.match(workflow, /REPLICATES:\s*'\[0,1,2,3\]'/)
  assert.match(workflow, /NOT a performance lane/)
  assert.match(workflow, /cannot emit a claim/)
})

test('browser install is followed by adaptive settle and ambient timing gate', () => {
  const install = workflow.indexOf('Install pinned browser')
  const settle = workflow.indexOf('Wait for browser-install CPU tail to settle')
  const gate = workflow.indexOf('run-with-timing-gate.mjs --')
  const bench = workflow.indexOf('bench-r9-controlled.mjs', gate)
  assert.ok(install >= 0 && settle > install && gate > settle && bench > gate)
})

test('workflow uses the known-good exact setup-node pin everywhere', () => {
  const refs = [...workflow.matchAll(/actions\/setup-node@([0-9a-f]{40})/g)].map((m) => m[1])
  assert.ok(refs.length >= 4)
  assert.deepEqual([...new Set(refs)], ['49933ea5288caeca8642d1e84afbd3f7d6820020'])
})

test('artifact identity is stable across failed-job reruns', () => {
  assert.equal(workflow.includes('github.run_attempt'), false)
  assert.match(workflow, /name: r10-icon-prepared-\$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /name: r10-icon-ceiling-\$\{\{ matrix\.browser \}\}-r\$\{\{ matrix\.replicate \}\}-\$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /pattern: r10-icon-ceiling-\*-\$\{\{ github\.run_id \}\}/)
  assert.match(workflow, /name: r10-icon-summary-\$\{\{ github\.run_id \}\}/)
})

test('same-bundle ceiling provenance declares the same exact git identity on both arms', () => {
  assert.match(workflow, /SNAPDOM_CANDIDATE_GIT_SHA:\s*\$\{\{ env\.CANDIDATE_SHA \}\}/)
  assert.match(workflow, /SNAPDOM_BASELINE_GIT_SHA:\s*\$\{\{ env\.CANDIDATE_SHA \}\}/)
})

test('ceiling artifacts retain host-settle and ambient-gate evidence', () => {
  assert.match(workflow, /lane6-scratch\/r10\/icon-host-settle\.json/)
  assert.match(workflow, /lane6-scratch\/r5\/results\/timing-environment-latest\.json/)
})
