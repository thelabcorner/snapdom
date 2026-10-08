import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/r10-asset-bench.yml'), 'utf8')
const harnessSource = fs.readFileSync(path.resolve(process.cwd(), 'lane6-scratch/r10/assets-bench.mjs'), 'utf8')
const entrySource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.js'), 'utf8')

test('R10 workflow has prepare, fresh-runner and aggregate stages only', () => {
  for (const job of ['prepare', 'runner', 'aggregate']) {
    assert.match(source, new RegExp('^  ' + job + ':$', 'm'))
  }
  assert.equal(source.includes('pull_request:'), false)
})

test('measurement head is separate from exact frozen candidate and baseline mechanisms', () => {
  assert.match(source, /MEASUREMENT_SHA: \$\{\{ github\.sha \}\}/)
  assert.match(source, /CANDIDATE_SHA: d391556b80be7a6d97bc4834d2ce6e24137515b2/)
  assert.match(source, /BASELINE_SHA: c523ddb6e141846d55af1c8f315f65babbc32a7e/)
  assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$MEASUREMENT_SHA"/)
  assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$CANDIDATE_SHA"/)
  assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$BASELINE_SHA"/)
  assert.match(source, /git diff --exit-code "\$CANDIDATE_SHA"/)
  assert.match(source, /src\/core\/cache\.js/)
  assert.match(source, /src\/modules\/compress\.js/)
  assert.match(source, /src\/modules\/images\.js/)
})

test('fresh-runner matrix is six independent Chromium replicas', () => {
  assert.match(source, /replicate: \[0, 1, 2, 3, 4, 5\]/)
  assert.match(source, /max-parallel: 6/)
  assert.match(source, /runs-on: ubuntu-24\.04/)
})

test('runner is guarded by setup settle and ambient CPU gate', () => {
  assert.match(source, /node lane6-scratch\/r10\/host-settle\.mjs/)
  assert.match(source, /node lane6-scratch\/r5\/run-with-timing-gate\.mjs -- node lane6-scratch\/r10\/assets-bench\.mjs/)
  assert.match(source, /--prepared=lane6-scratch\/r10\/prepared\.json/)
})

test('artifact identities are retry-stable and do not depend on run_attempt', () => {
  assert.equal(source.includes('github.run_attempt'), false)
  assert.match(source, /name: r10-asset-prepared-\$\{\{ github\.run_id \}\}/)
  assert.match(source, /name: r10-asset-runner-r\$\{\{ matrix\.replicate \}\}-\$\{\{ github\.run_id \}\}/)
  assert.match(source, /pattern: r10-asset-runner-r\*-\$\{\{ github\.run_id \}\}/)
  assert.match(source, /name: r10-asset-summary-\$\{\{ github\.run_id \}\}/)
  assert.ok((source.match(/overwrite: true/g) || []).length >= 3)
})

test('only aggregate consumes the fresh-runner artifacts', () => {
  assert.match(source, /Aggregate one point per fresh runner/)
  assert.match(source, /asset-aggregate\.mjs/)
  assert.match(source, /--expected=6/)
})

test('hosted pages instrument Worker before dynamically importing the served snapdom bundle', () => {
  assert.match(entrySource, /export \{ snapdom \} from/)
  const scriptStart = harnessSource.indexOf('function scriptFor(side)')
  const scriptEnd = harnessSource.indexOf('\nasync function serve()', scriptStart)
  const pageBuilder = harnessSource.slice(scriptStart, scriptEnd)
  const workerWrap = pageBuilder.indexOf('"  window.Worker = InstrumentedWorker"')
  const dynamicImport = pageBuilder.indexOf('"const { snapdom } = await import')
  assert.ok(workerWrap >= 0, 'Worker instrumentation missing from emitted page script')
  assert.ok(dynamicImport > workerWrap, 'snapdom page import must be emitted after Worker instrumentation')
  assert.equal(pageBuilder.includes('{ default: snapdom } = await import'), false)
  assert.match(pageBuilder, /const bundle = side === 'candidate' \? '\/candidate\.mjs' : '\/baseline\.mjs'/)
})
