/**
 * The workflow and the provenance freeze are the two places where a gate can be quietly weakened
 * without any test going red, because both are configuration rather than logic. These contracts
 * read the shipped YAML and the shipped prepare.mjs as text and as behaviour, and pin the
 * properties that make the gate sound:
 *
 *  - production src is proven byte-identical to the frozen candidate before anything runs;
 *  - the candidate and baseline are compiled from separate exact checkouts;
 *  - all three engines are required, and a missing one is INCOMPLETE_EVIDENCE;
 *  - the browser actually installed is the engine named, not "all of them";
 *  - concurrency is scoped, so a cancelled run cannot be mistaken for a gate that never answered;
 *  - the aggregate is the only thing that can report success, and it exits non-zero otherwise;
 *  - no step anywhere measures time or prints a performance number.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASELINE_SHA, CANDIDATE_SHA, ENGINES, cellMatrixSha256 } from '../fidelity-lib.mjs'

const ROOT = process.cwd()
const WORKFLOW = fs.readFileSync(path.resolve(ROOT, '.github/workflows/r11-fidelity.yml'), 'utf8')
const AGGREGATE = path.resolve(ROOT, 'lane6-scratch/r11/fidelity-aggregate.mjs')
const RUNNER = path.resolve(ROOT, 'lane6-scratch/r11/fidelity-run.mjs')
const PREPARE = path.resolve(ROOT, 'lane6-scratch/r11/prepare.mjs')
const LIB = path.resolve(ROOT, 'lane6-scratch/r11/fidelity-lib.mjs')

const hostedEnv = (extra = {}) => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'thelabcorner/snapdom',
  ...extra,
})

/** Run a script without the hosted identity leaking in, unless the test wants it. */
function run(script, args, env = {}) {
  const child = { ...process.env }
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID']) delete child[key]
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...child, ...env },
  })
}

// --------------------------------------------------------------------------
// Workflow shape
// --------------------------------------------------------------------------

test('the workflow has exactly the four stages and no pull_request trigger', () => {
  for (const job of ['contracts:', 'prepare:', 'engine:', 'accept:']) {
    assert.match(WORKFLOW, new RegExp('^  ' + job, 'm'), 'missing job ' + job)
  }
  // Only the trigger key is forbidden; `github.event.pull_request.number` in the concurrency group
  // is a different thing entirely and is deliberately absent from the triggers.
  assert.equal(/^ {2}pull_request(_target)?:/m.test(WORKFLOW), false)
  assert.equal(/secrets\./.test(WORKFLOW), false)
  assert.match(WORKFLOW, /^permissions:\n  contents: read$/m)
  // A secrets reference would make the gate unrunnable for a fork and untrustworthy for a reader.
  assert.equal(/secrets\./.test(WORKFLOW), false)
  assert.equal(/runs-on:.*self-hosted/.test(WORKFLOW), false)
  assert.equal(/runs-on: (?!ubuntu-24\.04)/.test(WORKFLOW), false)
})

test('the workflow triggers only on the measurement branch', () => {
  assert.match(WORKFLOW, /branches:\n {6}- 'perf\/v3-r11-fidelity-gate'/)
  assert.match(WORKFLOW, /workflow_dispatch:/)
})

test('concurrency is scoped to workflow and ref, and supersedes stale work', () => {
  // A static group serialises every branch behind one lane and never supersedes anything, and a run
  // cancelled by GitHub's pending-workflow limit is indistinguishable from a gate that never answered.
  assert.match(WORKFLOW, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/)
  assert.match(WORKFLOW, /cancel-in-progress: true/)
  assert.equal(/group: r11-fidelity-\$\{\{ github\.sha \}\}/.test(WORKFLOW), false)
})

test('the frozen candidate and baseline SHAs are the exact commits', () => {
  assert.match(WORKFLOW, new RegExp('CANDIDATE_SHA: ' + CANDIDATE_SHA))
  assert.match(WORKFLOW, new RegExp('BASELINE_SHA: ' + BASELINE_SHA))
  assert.match(WORKFLOW, /MEASUREMENT_SHA: \$\{\{ github\.sha \}\}/)
  assert.equal(WORKFLOW.includes('MEASUREMENT_SHA: ' + CANDIDATE_SHA), false)
})

test('production src is proven byte-identical to the candidate before anything runs', () => {
  const identityStep = WORKFLOW.slice(
    WORKFLOW.indexOf('Prove production src is byte-identical'),
    WORKFLOW.indexOf('Run the frozen browser-free mechanism proof'),
  )
  assert.match(identityStep, /git diff --exit-code "\$CANDIDATE_SHA"/)
  for (const area of ['src', 'types', 'packages', 'esbuild.config.mjs', 'package.json', 'package-lock.json']) {
    assert.ok(
      new RegExp('(?:^|\\s)' + area.replaceAll('.', '\\.') + '(?:\\s|$)', 'm').test(identityStep),
      'identity check must cover ' + area,
    )
  }
  assert.match(identityStep, /test "\$\(git rev-parse HEAD\)" = "\$MEASUREMENT_SHA"/)
  assert.match(identityStep, /git fetch --no-tags --depth=1 origin "\$CANDIDATE_SHA"/)
})

test('the two bundles under comparison are compiled from separate exact checkouts', () => {
  assert.match(WORKFLOW, /ref: \$\{\{ env\.CANDIDATE_SHA \}\}\n {10}path: __r11_candidate/)
  assert.match(WORKFLOW, /ref: \$\{\{ env\.BASELINE_SHA \}\}\n {10}path: __r11_baseline/)
  assert.match(WORKFLOW, /test "\$\(git rev-parse HEAD\)" = "\$CANDIDATE_SHA"/)
  assert.match(WORKFLOW, /test "\$\(git rev-parse HEAD\)" = "\$BASELINE_SHA"/)
  assert.match(WORKFLOW, /cp dist\/snapdom\.mjs \.\.\/lane6-scratch\/r11\/bundles\/candidate\.mjs/)
  assert.match(WORKFLOW, /cp dist\/snapdom\.mjs \.\.\/lane6-scratch\/r11\/bundles\/baseline\.mjs/)
})

test('the engine matrix is chromium, firefox and webkit, with no early cancellation', () => {
  assert.match(WORKFLOW, /engine: \[chromium, firefox, webkit\]/)
  assert.match(WORKFLOW, /fail-fast: false/)
  assert.match(WORKFLOW, /--expected-engines=chromium,firefox,webkit/)
  for (const engine of ENGINES) {
    assert.match(WORKFLOW, new RegExp('r11-fidelity-engine-\\$\\{\\{ matrix\\.engine \\}\\}-\\$\\{\\{ github\\.run_id \\}\\}'))
    assert.ok(WORKFLOW.includes(engine))
  }
})

test('the browser installed is the engine named, never the whole set', () => {
  // inputs.* is only populated by workflow_dispatch, so on push `npx playwright install --with-deps ${{ inputs.browser }}`
  // expands with an EMPTY argument and installs every browser while BROWSER names one.
  assert.equal(/inputs\.browser/.test(WORKFLOW), false)
  assert.match(WORKFLOW, /BROWSER: \$\{\{ matrix\.engine \}\}/)
  assert.match(WORKFLOW, /npx playwright install --with-deps "\$\{BROWSER:\?BROWSER must name one engine\}"/)
})

test('artifact identities are retry-stable and do not depend on run_attempt', () => {
  assert.equal(WORKFLOW.includes('github.run_attempt'), false)
  for (const name of [
    'r11-fidelity-prepared-${{ github.run_id }}',
    'r11-fidelity-engine-${{ matrix.engine }}-${{ github.run_id }}',
    'r11-fidelity-summary-${{ github.run_id }}',
  ]) {
    assert.ok(WORKFLOW.includes(name), 'missing artifact name ' + name)
  }
  assert.match(WORKFLOW, /pattern: r11-fidelity-engine-\*-\$\{\{ github\.run_id \}\}/)
  assert.ok((WORKFLOW.match(/overwrite: true/g) || []).length >= 3)
})

test('only the accept stage consumes engine artifacts, and it runs even after an engine fails', () => {
  assert.match(
    WORKFLOW,
    / {2}accept:\n {4}name: Cross-engine fidelity acceptance\n {4}needs: \[contracts, prepare, engine\]\n {4}if: always\(\) && needs\.contracts\.result == 'success' && needs\.prepare\.result == 'success'/,
  )
  assert.match(WORKFLOW, /fidelity-aggregate\.mjs/)
  const acceptStage = WORKFLOW.slice(WORKFLOW.indexOf('  accept:'))
  assert.equal(acceptStage.includes('download-artifact'), true)
  const engineStage = WORKFLOW.slice(WORKFLOW.indexOf('  engine:'), WORKFLOW.indexOf('  accept:'))
  assert.equal(engineStage.includes('fidelity-aggregate.mjs'), false)
})

test('the existing authoritative suites are reused rather than reimplemented', () => {
  const reuse = WORKFLOW.slice(
    WORKFLOW.indexOf('Reuse the existing authoritative'),
    WORKFLOW.indexOf('Collect fidelity evidence'),
  )
  for (const suite of [
    '__tests__/visual.fidelity.crossengine.test.js',
    '__tests__/compress.syncfallback.test.js',
    '__tests__/modules.images.dataUrlPassthrough.test.js',
    '__tests__/exporters.rasterize.routes.test.js',
    '__tests__/regression.imageSelection.test.js',
  ]) {
    assert.ok(reuse.includes(suite), 'expected the existing suite to be reused: ' + suite)
  }
  assert.match(reuse, /--browser\.headless/)
})

test('the browser-free mechanism proof runs in CI, not only on a developer machine', () => {
  assert.match(WORKFLOW, /npm run test:asset-proof/)
  // A directory argument is a module path to node, not a test discovery root, and a discovery root
  // would also let a future contract be added and silently left out of the gate.
  assert.match(WORKFLOW, /node --test "lane6-scratch\/r11\/tests\/\*\.test\.mjs"/)
  const discovered = fs
    .readdirSync(path.resolve(ROOT, 'lane6-scratch/r11/tests'))
    .filter((f) => f.endsWith('.test.mjs'))
  assert.ok(discovered.length >= 2, 'the gate must have contract files to run')
  for (const file of discovered) {
    assert.ok(
      WORKFLOW.includes('lane6-scratch/r11/tests/*.test.mjs'),
      'the glob must cover ' + file,
    )
  }
})

test('no step anywhere measures time or reports a performance number', () => {
  // Contents, not paths: scanning the file NAMES would make this contract vacuous.
  const sources = { workflow: WORKFLOW, lib: readFile(LIB), runner: readFile(RUNNER), aggregate: readFile(AGGREGATE), prepare: readFile(PREPARE) }
  const harness = Object.values(sources).join('\n')
  for (const forbidden of [
    'performance.now(',
    'Date.now() -',
    'captureMs',
    'renderMs',
    'totalMs',
    'elapsedMs',
    'process.hrtime',
    'logRatio',
    'pct',
    'CI95',
  ]) {
    assert.equal(harness.includes(forbidden), false, 'the fidelity gate must not contain ' + forbidden)
  }
  // Each artifact that leaves the gate states its own scope, so no reader can infer speed from it.
  assert.match(sources.runner, /performanceClaim: false/)
  assert.match(sources.lib, /performanceClaim: false/)
  assert.match(sources.prepare, /performanceClaim: false/)
  assert.match(sources.lib, /supports no speed claim on any engine/)
})

function readFile(file) {
  return fs.readFileSync(file, 'utf8')
}

// --------------------------------------------------------------------------
// The runner, the aggregate and prepare: hosted-only and fail closed
// --------------------------------------------------------------------------

test('the runner, the aggregate and prepare all refuse to run outside public Actions', () => {
  for (const script of [RUNNER, AGGREGATE, PREPARE]) {
    const source = fs.readFileSync(script, 'utf8')
    assert.match(source, /assertHostedOnly\(process\.env\)/, path.basename(script) + ' must gate on hosted Actions')
    const result = run(script, ['--help-unused-flag-to-fail-fast'], {})
    assert.notEqual(result.status, 0, path.basename(script) + ' must exit non-zero off Actions')
    assert.match(
      result.stderr + result.stdout,
      /GitHub-Actions-only/,
      path.basename(script) + ' must name the hosted-only reason',
    )
  }
})

test('the runner refuses an engine outside the frozen matrix', () => {
  const result = run(RUNNER, ['--engine=safari'], hostedEnv())
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /--engine must be one of/)
})

test('the runner refuses to start without the frozen prepared provenance', () => {
  const result = run(RUNNER, ['--engine=chromium', '--prepared=lane6-scratch/r11/absent.json'], hostedEnv())
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /prepared\.json missing/)
})

test('the aggregate refuses an expected-engine list that is not the frozen three', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdom-r11-agg-'))
  fs.writeFileSync(path.join(dir, 'prepared.json'), JSON.stringify({ schema: 'snapdom-r11-fidelity-prepared-v1' }))
  const result = run(AGGREGATE, [
    '--prepared=' + path.join(dir, 'prepared.json'),
    '--input-dir=' + dir,
    '--expected-engines=chromium,firefox',
  ], hostedEnv())
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /--expected-engines must be exactly chromium,firefox,webkit/)
})

test('the aggregate exits non-zero and reports INCOMPLETE_EVIDENCE with no engine artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdom-r11-agg-empty-'))
  const input = path.join(dir, 'input')
  fs.mkdirSync(input, { recursive: true })
  fs.writeFileSync(path.join(dir, 'prepared.json'), JSON.stringify({
    schema: 'snapdom-r11-fidelity-prepared-v1',
    candidateGitSha: CANDIDATE_SHA,
    baselineGitSha: BASELINE_SHA,
    cellMatrixSha256: cellMatrixSha256(),
  }))
  const out = path.join(dir, 'summary.json')
  const result = run(AGGREGATE, [
    '--input-dir=' + input,
    '--prepared=' + path.join(dir, 'prepared.json'),
    '--out=' + out,
  ], hostedEnv())
  assert.notEqual(result.status, 0)
  const summary = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(summary.state, 'INCOMPLETE_EVIDENCE')
  assert.deepEqual(summary.missingEngines, ['chromium', 'firefox', 'webkit'])
  assert.equal(summary.performanceClaim, false)
  // Every cell is reported as unproven rather than omitted, so the matrix has no holes.
  for (const cellId of summary.cellIds) {
    for (const engine of ENGINES) {
      assert.equal(summary.matrix[cellId][engine], 'INCOMPLETE_EVIDENCE')
    }
  }
  assert.match(result.stdout + result.stderr, /state: INCOMPLETE_EVIDENCE/)
})

test('the aggregate reports a stray or unexpected engine file instead of ignoring it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdom-r11-agg-stray-'))
  const input = path.join(dir, 'input')
  fs.mkdirSync(path.join(input, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'prepared.json'), JSON.stringify({
    schema: 'snapdom-r11-fidelity-prepared-v1',
    candidateGitSha: CANDIDATE_SHA,
    baselineGitSha: BASELINE_SHA,
  }))
  fs.writeFileSync(path.join(input, 'nested', 'engine-safari.json'), '{}')
  const out = path.join(dir, 'summary.json')
  const result = run(AGGREGATE, [
    '--input-dir=' + input,
    '--prepared=' + path.join(dir, 'prepared.json'),
    '--out=' + out,
  ], hostedEnv())
  assert.notEqual(result.status, 0)
  const summary = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.ok(summary.strayFiles.some((f) => /engine-safari\.json/.test(f)))
})

test('prepare freezes every harness file it depends on, including itself', () => {
  const source = fs.readFileSync(PREPARE, 'utf8')
  for (const rel of [
    '.github/workflows/r11-fidelity.yml',
    'lane6-scratch/r11/fidelity-lib.mjs',
    'lane6-scratch/r11/fidelity-run.mjs',
    'lane6-scratch/r11/fidelity-aggregate.mjs',
    'lane6-scratch/r11/prepare.mjs',
    'lane6-scratch/r10/asset-bench-lib.mjs',
  ]) {
    assert.ok(source.includes("'" + rel + "'"), 'prepare must freeze ' + rel)
  }
  assert.match(source, /for \(const \[label, value\] of Object\.entries\(\{ measurementGitSha, candidateGitSha, baselineGitSha \}\)\) \{\n {2}if \(!\/\^\[0-9a-f\]\{40\}\$\/i\.test\(value\)\) throw new Error/)
  assert.match(source, /if \(candidateGitSha !== CANDIDATE_SHA\)/)
  assert.match(source, /if \(baselineGitSha !== BASELINE_SHA\)/)
  assert.match(source, /cellMatrixSha256: cellMatrixSha256\(\)/)
  assert.match(source, /rawInlineLimit = 256 \* 1024/)
  assert.match(source, /timingMeasured: false/)
})

test('the runner re-verifies every frozen identity before it opens a browser', () => {
  const source = fs.readFileSync(RUNNER, 'utf8')
  for (const check of [
    'baseline bundle digest mismatch',
    'candidate bundle digest mismatch',
    'harness file digest mismatch',
    'fixture digest mismatch',
    'prepared worker threshold is not the production threshold',
    'cell matrix drifted after prepare',
    'Playwright version mismatch',
    'raw inline limit drifted after prepare',
  ]) {
    assert.ok(source.includes(check), 'the runner must re-verify: ' + check)
  }
  assert.match(source, /assertHostedOnly\(process\.env\)/)
})

test('the emulated-absence cells are emulated before module execution, not after', () => {
  const source = fs.readFileSync(RUNNER, 'utf8')
  // addInitScript runs before any page script, which is before module evaluation. A page.evaluate
  // would run after the bundle had already asked whether Worker exists.
  assert.match(source, /context\.addInitScript\(\{ content: source \}\)/)
  assert.match(source, /delete window\.' \+ target/)
  assert.equal(/evaluate\(\(\) => delete window\.Worker/.test(source), false)
  assert.equal(/addInitScript\([\s\S]*?await import/.test(source), false, 'the import must follow the init script')
})

test('one page per side, so neither bundle inherits the other capture state', () => {
  const source = fs.readFileSync(RUNNER, 'utf8')
  assert.match(source, /async function runSidePage\(browser, side, cell, contextId\)/)
  assert.match(source, /await browser\.newContext\(\{ deviceScaleFactor: 1 \}\)/)
  assert.match(source, /const bundle = side === 'candidate' \? '\/candidate\.mjs' : '\/baseline\.mjs'/)
})

test('CSP is served as a response header rather than a meta tag', () => {
  const source = fs.readFileSync(RUNNER, 'utf8')
  assert.match(source, /'content-security-policy': csp/)
  assert.equal(/http-equiv="Content-Security-Policy"/.test(source), false)
  assert.match(source, /worker-src 'none'/)
})

test('the runner refuses an incomplete record rather than admitting a partial step', () => {
  const source = fs.readFileSync(RUNNER, 'utf8')
  assert.match(source, /incomplete evidence at/)
  assert.match(source, /page reported/)
  assert.match(source, /did not reach __ready|waitForFunction/)
})

test('the vendored r10 helper library is byte-identical to the measurement branch copy', () => {
  // The fixture generator, the geometry sweeps and the CSP-warmup allowance are reused from r10
  // rather than restated, so this gate and the confirmed timing experiment agree by construction.
  // The digest below is the measurement branch copy (perf/v3-r10-asset-frontier, 2744bd9).
  const vendored = fs.readFileSync(path.resolve(ROOT, 'lane6-scratch/r10/asset-bench-lib.mjs'))
  assert.equal(
    vendored.length,
    22088,
    'lane6-scratch/r10/asset-bench-lib.mjs must stay the unmodified r10 copy, byte for byte',
  )
  assert.equal(
    require_sha256(vendored),
    '8B8CBD864F6222C3E6423E1FFF1A688FBDC6C5D5280135D046EA75C41828573F',
  )
})

function require_sha256(buffer) {
  // Local import so this contract file stays a single dependency-free module.
  return sha256Hex(buffer)
}
function sha256Hex(buffer) {
  return cryptoMod.createHash('sha256').update(buffer).digest('hex').toUpperCase()
}
const cryptoMod = await import('node:crypto')
