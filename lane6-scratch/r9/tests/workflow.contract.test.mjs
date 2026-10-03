/**
 * Browser-free static contract for the hosted R9 workflow.
 *
 * This does not execute Actions or a browser. It pins the control-plane vocabulary and artifact
 * topology so governor-v2 cannot silently coexist with legacy eligible/state wiring.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const FILE = path.join(ROOT, '.github/workflows/r9-hosted-bench.yml')
const raw = fs.readFileSync(FILE, 'utf8')
const bench = fs.readFileSync(path.join(ROOT, 'lane6-scratch/r9/bench-r9-controlled.mjs'), 'utf8')
const build = fs.readFileSync(path.join(ROOT, 'lane6-scratch/r9/build-provenance.mjs'), 'utf8')
const doc = yaml.load(raw)

test('workflow parses and carries the complete v2 job graph', () => {
  assert.deepEqual(
    Object.keys(doc.jobs),
    ['prepare', 'scout', 'confirm', 'aggregate', 'engine-guard', 'engine-aggregate', 'closeout'],
  )
})

test('pull-request merge refs are not a measurement trigger', () => {
  assert.doesNotMatch(raw, /^\s{2}pull_request:/m)
  assert.doesNotMatch(raw, /github\.event\.pull_request/)
  assert.match(raw, /MEASURED_REF:\s*\$\{\{ github\.ref \}\}/)
})

test('legacy eligible/state vocabulary is absent from workflow outputs', () => {
  assert.doesNotMatch(raw, /outputs\.eligible/)
  assert.doesNotMatch(raw, /outputs\.state/)
  assert.match(raw, /scout_killed:/)
  assert.match(raw, /promotable:/)
  assert.match(raw, /guard_verdict:/)
})

test('unfrozen policy is refused before candidate resolution or any browser job', () => {
  const preflight = raw.indexOf('Refuse unfrozen promotion policy before candidate resolution')
  const resolve = raw.indexOf('Resolve committed benchmark identity')
  assert.ok(preflight >= 0 && resolve > preflight, 'policy preflight must precede candidate resolution')
  assert.match(raw, /promotionFrozen\(policy\)/)
})

test('scout is kill-only and confirmation is the only inference gate', () => {
  assert.match(raw, /Chromium scout \(kill-only, never promotes\)/)
  assert.match(raw, /if: needs\.scout\.outputs\.scout_killed == 'false'/)
  assert.match(raw, /The runner-level aggregate is the ONLY Chromium inference stage/)
  assert.match(raw, /if: needs\.aggregate\.outputs\.promotable == 'true'/)
})

test('engine guard cells carry browser and replicate from policy', () => {
  assert.match(raw, /matrix\.entry\.browser/)
  assert.match(raw, /matrix\.entry\.replicate/)
  assert.match(raw, /fromJSON\(needs\.prepare\.outputs\.engine_guard_matrix\)/)
  assert.doesNotMatch(raw, /phase=engineGuard --replicate=0/)
})

test('engine decision artifact producer and consumer use the same prefix', () => {
  const producer = 'r9-decisions-${{ needs.prepare.outputs.candidate_id }}-'
  assert.ok(raw.includes('name: ' + producer))
  assert.ok(raw.includes('pattern: ' + producer + '*-'))
})

test('artifact addressing is retry-stable while run-attempt remains evidence provenance', () => {
  // A rerun-failed-jobs attempt does not rerun successful prepare/aggregate jobs. Artifact names
  // therefore belong to the immutable workflow run, not the mutable attempt number.
  assert.doesNotMatch(raw, /github\.run_attempt/)

  const uploads = Object.values(doc.jobs).flatMap((job) =>
    (job.steps || []).filter((step) => String(step.uses || '').includes('actions/upload-artifact@')),
  )
  assert.equal(uploads.length, 7)
  for (const step of uploads) {
    assert.match(String(step.with?.name || ''), /github\.run_id/)
    assert.equal(step.with?.overwrite, true, `${step.name} must replace only its stable run/cell artifact`)
  }

  const preparedName = 'r9-prepared-${{ needs.prepare.outputs.candidate_id }}-${{ github.run_id }}'
  assert.ok(raw.includes('name: ' + preparedName), 'downstream jobs must reuse the attempt-1 prepared bundle')
  assert.match(raw, /r9-confirm-\$\{\{ needs\.prepare\.outputs\.candidate_id \}\}-r\$\{\{ matrix\.replicate \}\}-\$\{\{ github\.run_id \}\}/)
  assert.match(raw, /r9-decisions-\$\{\{ needs\.prepare\.outputs\.candidate_id \}\}-\$\{\{ matrix\.entry\.browser \}\}-r\$\{\{ matrix\.entry\.replicate \}\}-\$\{\{ github\.run_id \}\}/)

  // Attempt identity is still recorded and verified INSIDE evidence, just never used as storage identity.
  assert.match(build, /GITHUB_RUN_ATTEMPT/)
})

test('benchmark report actually emits the v2 identities the verifier requires', () => {
  for (const required of [
    'expectation: EXPECTATION',
    'phase: PHASE',
    'replicate: REPLICATE',
    'policySha256:',
    'governor:',
    'measuredRef:',
  ]) {
    assert.ok(bench.includes(required), 'bench provenance missing ' + required)
  }
  assert.match(build, /plan\.toolchainSpec\?\.playwrightVersion/)
  assert.match(build, /process\.version\.replace\(\/\^v\//)
  assert.match(build, /plan\.governorRel/)
})

test('closeout is machine-computed, fail-closed, and no legacy shell verdict remains', () => {
  assert.match(raw, /node lane6-scratch\/r9\/closeout\.mjs/)
  assert.match(raw, /Refuse closeout without prepared identity/)
  assert.doesNotMatch(raw, /FULL HOSTED GATES CLEARED/)
  assert.match(raw, /r9-closeout-/)
})
