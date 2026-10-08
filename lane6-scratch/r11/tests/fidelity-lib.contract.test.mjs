import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASELINE_SHA,
  CANDIDATE_SHA,
  CELLS,
  CELL_IDS,
  ENGINES,
  FIXTURES,
  HOSTED_ONLY_MESSAGE,
  HOSTED_ONLY_MESSAGE as GUARD_MESSAGE,
  PIXEL_CONVENTIONS,
  PREPARED_SCHEMA,
  PUBLIC_REPOSITORY,
  ROUTE_SHAPES,
  RUNNER_SCHEMA,
  TELEMETRY_SHAPES,
  SELF_NULL_CONTEXTS,
  acceptanceMatrix,
  acceptanceVerdict,
  assertHostedOnly,
  assetRouteTotal,
  buildSteps,
  candidateRouteVerdict,
  cellById,
  cellMatrixSha256,
  cellPageSpec,
  cellVerdict,
  dataUrlCharsForBytes,
  engineVerdict,
  fixtureBytes,
  geometrySweep,
  makeDeterministicPng,
  pixelVerdict,
  sha256,
  stepExpectation,
  telemetryVerdict,
} from '../fidelity-lib.mjs'
import { WORKER_MIN_PAYLOAD_CHARS } from '../../../src/core/cache.js'

const W = WORKER_MIN_PAYLOAD_CHARS
const CAP = 64 * 1024 * 1024

// --------------------------------------------------------------------------
// Hosted only, and fail closed
// --------------------------------------------------------------------------

test('the gate refuses to run outside GitHub Actions', () => {
  assert.throws(() => assertHostedOnly({}), new RegExp(HOSTED_ONLY_MESSAGE.slice(0, 40)))
  assert.throws(() => assertHostedOnly({ GITHUB_ACTIONS: 'false' }), /GitHub-Actions-only/)
})

test('the hosted-only guard has no local override', () => {
  assert.throws(
    () => assertHostedOnly({ GITHUB_ACTIONS: 'true', SNAPDOM_ALLOW_LOCAL_FIDELITY: '1' }),
    /not honoured/,
  )
})

test('the gate is pinned to one public repository', () => {
  assert.equal(PUBLIC_REPOSITORY, 'thelabcorner/snapdom')
  assert.doesNotThrow(() => assertHostedOnly({ GITHUB_ACTIONS: 'true' }))
  assert.doesNotThrow(() =>
    assertHostedOnly({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: PUBLIC_REPOSITORY }),
  )
  assert.throws(
    () => assertHostedOnly({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'someone/fork' }),
    /runs only on the public repository/,
  )
})

test('the guard message is stable', () => {
  assert.equal(GUARD_MESSAGE, HOSTED_ONLY_MESSAGE)
  assert.match(HOSTED_ONLY_MESSAGE, /browser execution is prohibited outside public Actions/)
})

// --------------------------------------------------------------------------
// Frozen identity
// --------------------------------------------------------------------------

test('the frozen mechanism and baseline are the exact commits', () => {
  assert.equal(CANDIDATE_SHA, 'd391556b80be7a6d97bc4834d2ce6e24137515b2')
  assert.equal(BASELINE_SHA, 'c523ddb6e141846d55af1c8f315f65babbc32a7e')
  assert.deepEqual(ENGINES, ['chromium', 'firefox', 'webkit'])
  assert.deepEqual(SELF_NULL_CONTEXTS, ['A', 'B'])
})

test('the production worker threshold is the one the mechanism uses', () => {
  assert.equal(W, 64 * 1024)
})

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

test('large and small are byte-for-byte the r10 fixtures', () => {
  assert.deepEqual(fixtureBytes('large'), makeDeterministicPng(1200, 800, { seed: 0x51a7, entropy: true }))
  assert.deepEqual(fixtureBytes('small'), makeDeterministicPng(96, 96, { seed: 0x51a7, entropy: false }))
  assert.equal(sha256(fixtureBytes('large')), sha256(fixtureBytes('large')))
})

test('fixture threshold membership is asserted, never assumed', () => {
  const large = fixtureBytes('large').length
  const small = fixtureBytes('small').length
  assert.ok(dataUrlCharsForBytes(large) > W * 10, 'large must clear the threshold by 10x')
  assert.ok(dataUrlCharsForBytes(small) < W, 'small must stay below the threshold')
  for (const name of ['evictA', 'evictB']) {
    assert.ok(dataUrlCharsForBytes(fixtureBytes(name).length) > W * 100)
  }
})

test('the eviction fixtures really overshoot the retention cap, and land under it after one drop', () => {
  // The whole point of the 3500x2500 pair: retained blob bytes must exceed MAX_IMAGE_BLOB_BYTES so
  // the sweep is genuine, and must land under it after dropping exactly one image so exactly one
  // sidecar is swept. A smaller fixture would only re-prove what as-blob.node.test.mjs already
  // proves with no browser.
  const a = fixtureBytes('evictA').length
  const b = fixtureBytes('evictB').length
  assert.ok(a + b > CAP, 'pair must overshoot the cap: ' + (a + b) + ' vs ' + CAP)
  assert.ok(a + b - Math.max(a, b) <= CAP, 'dropping one image must land under the cap')
  assert.ok(Math.min(a, b) > CAP / 4, 'one image must be large enough for the split to be observable')
})

test('every fixture is deterministic across repeated generation', () => {
  for (const name of ['small', 'fallback', 'large']) {
    assert.equal(sha256(fixtureBytes(name)), sha256(fixtureBytes(name)))
  }
})

// --------------------------------------------------------------------------
// Geometry: the measured sweeps, not new ones
// --------------------------------------------------------------------------

test('repeat arms reuse the r10 geometry sweeps behind the timing claim', () => {
  const scale = geometrySweep('scale', 4)
  assert.equal(scale.length, 4)
  assert.deepEqual(scale.map((x) => Number(x.scale.toFixed(2))), [1.15, 1.23, 1.31, 1.39])
  assert.ok(scale.every((x) => x.dpr === 1))
  const width = geometrySweep('width', 4)
  assert.deepEqual(width.map((x) => Number(x.width.toFixed(2))), [330, 348, 366, 384])
  assert.ok(width.every((x) => x.scale === 1 && x.dpr === 1))

  assert.deepEqual(buildSteps(cellById('large-first-capture')), [
    { label: 'cold', geometry: { scale: 1, dpr: 1 } },
  ])
  assert.deepEqual(
    buildSteps(cellById('large-repeat-scale')).slice(1).map((s) => s.label),
    ['scale-0', 'scale-1', 'scale-2', 'scale-3'],
  )
  const same = buildSteps(cellById('large-repeat-same'))
  assert.equal(same.length, 4)
  assert.equal(new Set(same.slice(1).map((s) => JSON.stringify(s.geometry))).size, 1)
  const widths = buildSteps(cellById('large-repeat-width'))
  assert.ok(widths.slice(1).every((s) => s.geometry.width > 300 && s.geometry.scale === 1))
})

test('a same-geometry repeat arm must actually repeat', () => {
  assert.throws(() => buildSteps({ repeat: { kind: 'same', count: 1 } }), /at least 2 steps/)
})

// --------------------------------------------------------------------------
// Pixel parity
// --------------------------------------------------------------------------

const rgba = (...pixels) => Buffer.from(pixels.flat()).toString('base64')
const canvas = (w, h, pixelsB64) => ({ w, h, pixelsB64 })

test('identical rendered buffers pass on the exact tier with no tolerance applied', () => {
  const buf = rgba([1, 2, 3, 255], [4, 5, 6, 128])
  const verdict = pixelVerdict(canvas(2, 1, buf), canvas(2, 1, buf))
  assert.equal(verdict.ok, true)
  assert.equal(verdict.exact, true)
  assert.equal(verdict.tier, 'exact')
  assert.equal(verdict.differing, 0)
  assert.equal(verdict.maxChannelDelta, 0)
  assert.equal(verdict.pixels, 2)
})

test('one differing pixel fails the exact tier and locates itself', () => {
  const a = rgba([10, 10, 10, 255], [20, 20, 20, 255])
  const b = rgba([10, 10, 10, 255], [21, 20, 20, 255])
  const verdict = pixelVerdict(canvas(2, 1, a), canvas(2, 1, b))
  assert.equal(verdict.exact, false)
  assert.equal(verdict.differing, 1)
  assert.equal(verdict.differingRatio, 0.5)
  assert.equal(verdict.maxChannelDelta, 1)
  assert.equal(verdict.firstDiff.x, 1)
  assert.equal(verdict.firstDiff.y, 0)
  assert.deepEqual(verdict.firstDiff.baseline, [20, 20, 20, 255])
  assert.deepEqual(verdict.firstDiff.candidate, [21, 20, 20, 255])
})

test('alpha is compared like any other channel', () => {
  const a = rgba([0, 0, 0, 255])
  const b = rgba([0, 0, 0, 254])
  const verdict = pixelVerdict(canvas(1, 1, a), canvas(1, 1, b))
  assert.equal(verdict.exact, false)
  assert.equal(verdict.differing, 1)
})

test('a sub-tolerance drift is reported as strict, which the default tier does not admit', () => {
  const a = rgba(...Array.from({ length: 1000 }, () => [0, 0, 0, 255]))
  const b = rgba(...Array.from({ length: 999 }, () => [0, 0, 0, 255]).concat([[4, 4, 4, 255]]))
  const verdict = pixelVerdict(canvas(1000, 1, a), canvas(1000, 1, b))
  assert.equal(verdict.exact, false)
  assert.equal(verdict.strict, true)
  assert.equal(verdict.tier, 'strict')
  assert.ok(verdict.differingRatio <= PIXEL_CONVENTIONS.failureRatio)
  assert.ok(verdict.maxChannelDelta <= PIXEL_CONVENTIONS.channelTolerance)
})

test('the strict tier is this repository existing convention, not a number invented here', () => {
  assert.equal(PIXEL_CONVENTIONS.failureRatio, 0.005)
  assert.equal(PIXEL_CONVENTIONS.threshold, 0.1)
  assert.equal(PIXEL_CONVENTIONS.channelTolerance, 40)
  assert.equal(PIXEL_CONVENTIONS.defaultTier, 'exact')
})

test('pixel parity fails closed on missing evidence, size change and length change', () => {
  assert.equal(pixelVerdict(null, canvas(1, 1, rgba([0, 0, 0, 255]))).ok, false)
  assert.equal(pixelVerdict(canvas(1, 1, rgba([0, 0, 0, 255])), null).ok, false)
  assert.equal(pixelVerdict(canvas(1, 1, {}), canvas(1, 1, {})).ok, false)
  const buf = rgba([0, 0, 0, 255])
  assert.match(pixelVerdict(canvas(2, 1, buf), canvas(1, 1, buf)).reason, /rendered size differs/)
  assert.match(
    pixelVerdict(canvas(1, 1, buf), canvas(1, 1, rgba([0, 0, 0, 255], [0, 0, 0, 255]))).reason,
    /differ in length/,
  )
  assert.match(
    pixelVerdict(canvas(1, 1, ''), canvas(1, 1, '')).reason,
    /differ in length/,
  )
})

// --------------------------------------------------------------------------
// Route contracts
// --------------------------------------------------------------------------

test('terminal route shapes accept only the exact tally', () => {
  assert.equal(candidateRouteVerdict({ shape: 'workerBlobOnce' }, ROUTE_SHAPES.workerBlobOnce).ok, true)
  assert.equal(candidateRouteVerdict({ shape: 'workerBlobOnce' }, ROUTE_SHAPES.mainOnce).ok, false)
  assert.equal(candidateRouteVerdict({ shape: 'memoOnce' }, ROUTE_SHAPES.memoOnce).ok, true)
  assert.equal(candidateRouteVerdict({ shape: 'zeros' }, ROUTE_SHAPES.zeros).ok, true)
  assert.equal(candidateRouteVerdict({ shape: 'zeros' }, ROUTE_SHAPES.memoOnce).ok, false)
  assert.equal(candidateRouteVerdict({ shape: 'headerOnce' }, ROUTE_SHAPES.headerOnce).ok, true)
  assert.equal(candidateRouteVerdict({ shape: 'unknown-shape' }, ROUTE_SHAPES.zeros).ok, false)
  assert.equal(candidateRouteVerdict({ shape: 'memoOnce' }, null).ok, false)
})

test('compression disabled: absent counters require confirmed afterRender', () => {
  const exp = { shape: 'noCountersWhenDisabled' }
  assert.equal(candidateRouteVerdict(exp, null, true).ok, true)
  assert.equal(candidateRouteVerdict(exp, null, false).ok, false)
  assert.equal(candidateRouteVerdict(exp, undefined, true).ok, false)
  assert.equal(candidateRouteVerdict(exp, ROUTE_SHAPES.zeros, true).ok, false)
  assert.equal(candidateRouteVerdict({ shape: 'zeros' }, null, true).ok, false)
})

test('a candidate that publishes no counters at all is a failure, not a skip', () => {
  const verdict = candidateRouteVerdict({ shape: 'workerBlobOnce' }, undefined)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /published no __assetRoutes/)
})

test('CSP dual accounting is admitted only through the r10 denial contract', () => {
  const asyncDenied = { memo: 0, inflight: 0, header: 0, workerBlob: 1, workerString: 0, main: 1 }
  assert.equal(candidateRouteVerdict({ cspDenied: true }, asyncDenied).ok, true)
  assert.equal(candidateRouteVerdict({ cspDenied: true }, ROUTE_SHAPES.workerBlobOnce).ok, false)
  assert.equal(candidateRouteVerdict({ shape: 'mainOnce' }, asyncDenied).ok, false)
})

test('worker telemetry pins payload kind and exact posted bytes', () => {
  const shape = {
    attempts: 1, constructed: 1, posts: 1, messages: 1, errors: 0, errorPosts: 0,
    blobPayloadPosts: 1, stringPayloadPosts: 0, badBlobDataUrlPosts: 0,
    requiresFixtureBytes: true,
  }
  const blob = {
    attempts: 1, constructed: 1, posts: 1, messages: 1, errors: 0, errorPosts: 0,
    blobPayloadPosts: 1, blobPayloadBytes: 4096, stringPayloadPosts: 0, badBlobDataUrlPosts: 0,
  }
  assert.equal(telemetryVerdict(shape, blob, { fixtureBytes: 4096 }).ok, true)
  assert.equal(telemetryVerdict(shape, blob, { fixtureBytes: 4097 }).ok, false)
  assert.equal(telemetryVerdict(shape, blob, {}).ok, false, 'no fixture length means no admission')
  const withString = { ...blob, stringPayloadPosts: 1 }
  assert.equal(telemetryVerdict(shape, withString, { fixtureBytes: 4096 }).ok, false)
  const withBadDataUrl = { ...blob, badBlobDataUrlPosts: 1 }
  assert.equal(telemetryVerdict(shape, withBadDataUrl, { fixtureBytes: 4096 }).ok, false)
})

test('a baseline that posted the string must be proven to be above the worker threshold', () => {
  const shape = { posts: 1, messages: 1, stringPayloadPosts: 1, requiresPayloadChars: true }
  const post = { posts: 1, messages: 1, stringPayloadPosts: 1, stringPayloadChars: W + 1 }
  assert.equal(telemetryVerdict(shape, post, { workerMinPayloadChars: W }).ok, true)
  assert.equal(telemetryVerdict(shape, { ...post, stringPayloadChars: 10 }, { workerMinPayloadChars: W }).ok, false)
  assert.equal(telemetryVerdict(shape, post, {}).ok, false, 'no threshold means no admission')
})

test('pooled workers can post a warm Blob without constructing another Worker', () => {
  const posted = {
    attempts: 0, constructed: 0, posts: 1, messages: 1, errors: 0, errorPosts: 0,
    blobPayloadPosts: 1, blobPayloadBytes: 4096, stringPayloadPosts: 0,
    badBlobDataUrlPosts: 0,
  }
  assert.equal(telemetryVerdict(TELEMETRY_SHAPES.blobPost, posted, { fixtureBytes: 4096 }).ok, true)
  assert.equal(telemetryVerdict(TELEMETRY_SHAPES.blobPost, {
    ...posted, attempts: 1, constructed: 0,
  }, { fixtureBytes: 4096 }).ok, false, 'failed construction is not a successful reuse')
  assert.equal(telemetryVerdict(TELEMETRY_SHAPES.blobPost, {
    ...posted, attempts: 1, constructed: 1,
  }, { fixtureBytes: 4096 }).ok, true, 'a new pool slot is also allowed')
})

test('two-image eviction telemetry demands both posts with exact Blob identity', () => {
  const a = fixtureBytes('evictA').length
  const b = fixtureBytes('evictB').length
  const cold = {
    attempts: 2, constructed: 2, posts: 2, messages: 2, errors: 0, errorPosts: 0,
    blobPayloadPosts: 2, blobPayloadBytes: a + b, stringPayloadPosts: 0,
    badBlobDataUrlPosts: 0,
  }
  assert.equal(telemetryVerdict(TELEMETRY_SHAPES.twoBlobPosts, cold, {
    fixtureBytes: a + b,
  }).ok, true)
  const repeat = {
    attempts: 0, constructed: 0, posts: 2, messages: 2, errors: 0, errorPosts: 0,
    blobPayloadPosts: 1, blobPayloadBytes: a, stringPayloadPosts: 1,
    stringPayloadChars: W + 1, badBlobDataUrlPosts: 0,
  }
  const context = { fixtureByteSizes: [a, b], workerMinPayloadChars: W }
  assert.equal(telemetryVerdict(TELEMETRY_SHAPES.blobAndStringPost, repeat, context).ok, true)
  assert.equal(telemetryVerdict(TELEMETRY_SHAPES.blobAndStringPost, {
    ...repeat, blobPayloadBytes: a - 1,
  }, context).ok, false, 'a corrupted Blob is rejected')
  assert.equal(telemetryVerdict(TELEMETRY_SHAPES.blobAndStringPost, {
    ...repeat, posts: 1,
  }, context).ok, false, 'silently skipping an image is rejected')
})

test('an untouched worker route is all zeros, not merely a missing field', () => {
  const shape = { attempts: 0, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0 }
  assert.equal(telemetryVerdict(shape, {}).ok, true)
  assert.equal(telemetryVerdict(shape, { attempts: 1, posts: 1, messages: 1 }).ok, false)
  assert.equal(telemetryVerdict(shape, null).ok, false)
})

test('CSP telemetry admits the synchronous and the asynchronous denial and nothing between', () => {
  const shape = { cspDenied: true, minAttempts: 1, requireNoMessages: true, requireNoErrorPosts: true }
  assert.equal(telemetryVerdict(shape, { attempts: 1, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0 }).ok, true)
  assert.equal(telemetryVerdict(shape, { attempts: 1, constructed: 1, posts: 0, messages: 0, errors: 1, errorPosts: 0 }).ok, true)
  assert.equal(telemetryVerdict(shape, { attempts: 1, constructed: 1, posts: 0, messages: 1, errors: 1, errorPosts: 0 }).ok, false)
  assert.equal(telemetryVerdict(shape, { attempts: 1, constructed: 1, posts: 0, messages: 0, errors: 1, errorPosts: 1 }).ok, false)
  assert.equal(telemetryVerdict(shape, { attempts: 0, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0 }).ok, false)
  assert.equal(telemetryVerdict(shape, { attempts: 2, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0 }).ok, true)
})

test('route totals count one terminal route per image, never per post attempt', () => {
  assert.equal(assetRouteTotal({ memo: 1 }), 1)
  assert.equal(assetRouteTotal({ workerBlob: 1, main: 1 }), 2)
  assert.equal(assetRouteTotal(undefined), 0)
  assert.equal(assetRouteTotal({}), 0)
})

// --------------------------------------------------------------------------
// Cell matrix
// --------------------------------------------------------------------------

test('the matrix names every AS-BLOB semantic surface exactly once', () => {
  assert.deepEqual(CELL_IDS, [
    'large-first-capture',
    'large-repeat-same',
    'large-repeat-scale',
    'large-repeat-width',
    'small-first-capture',
    'small-repeat-scale',
    'compress-off-large',
    'worker-missing',
    'offscreen-missing',
    'csp-worker-none',
    'cache-disabled',
    'budget-eviction',
    'image-fetch-error',
    'image-fetch-fallback',
  ])
  assert.equal(new Set(CELL_IDS).size, CELL_IDS.length)
  for (const cell of CELLS) assert.ok(cell.surface && cell.surface.length > 20)
})

test('the emulated-absence surfaces are the two that must run before module execution', () => {
  assert.equal(cellById('worker-missing').emulate, 'no-worker')
  assert.equal(cellById('offscreen-missing').emulate, 'no-offscreen')
  assert.equal(cellById('large-first-capture').emulate, undefined)
})

test('CSP is a header-level policy, not a meta tag', () => {
  assert.equal(cellPageSpec(cellById('csp-worker-none')).csp, 'worker-none')
  assert.equal(cellPageSpec(cellById('large-first-capture')).csp, 'none')
})

test('every step of every cell has a route expectation and a telemetry expectation', () => {
  for (const cell of CELLS) {
    const steps = buildSteps(cell)
    assert.ok(steps.length >= 1, cell.id)
    for (const step of steps) {
      const expectation = stepExpectation(cell, step.label)
      assert.ok(expectation, cell.id + '/' + step.label + ' has no expectation')
      assert.ok(expectation.shape || expectation.cspDenied, cell.id + '/' + step.label + ' route')
      assert.ok(expectation.telemetry, cell.id + '/' + step.label + ' telemetry')
    }
  }
  assert.equal(stepExpectation(cellById('large-first-capture'), 'no-such-step'), null)
})

test('repeat arms name the baseline/candidate payload difference explicitly', () => {
  // c523ddb has no Blob sidecar on a repeat capture, so it MUST post the string there. One shared
  // shape would have failed the frozen baseline for a correct reason.
  const claim = stepExpectation(cellById('large-repeat-scale'), 'scale-1')
  assert.equal(claim.telemetryBySide.baseline, 'stringPost')
  assert.equal(claim.telemetryBySide.candidate, 'blobPost')
  assert.equal(stepExpectation(cellById('large-repeat-width'), 'width-2').telemetryBySide.baseline, 'stringPost')
  // cache:'disabled' resets the image memo every capture, so BOTH sides refetch and both post a Blob.
  const disabled = stepExpectation(cellById('cache-disabled'), 'scale-1')
  assert.equal(disabled.telemetryBySide.baseline, 'blobPost')
  assert.equal(disabled.telemetryBySide.candidate, 'blobPost')
  // the same-geometry null touches no worker at all, on either side
  const nullArm = stepExpectation(cellById('large-repeat-same'), 'same-1')
  assert.equal(nullArm.shape, 'memoOnce')
  assert.equal(nullArm.telemetry, 'noWorker')
  assert.equal(nullArm.telemetryBySide, undefined)
})

test('page specs describe the DOM and sequence the hosted page must build', () => {
  const eviction = cellPageSpec(cellById('budget-eviction'))
  assert.deepEqual(eviction.images.map((i) => i.name), ['evictA', 'evictB'])
  assert.equal(eviction.steps.length, 3)
  assert.equal(eviction.compress, true)
  const missing = cellPageSpec(cellById('image-fetch-error'))
  assert.equal(missing.images[0].src, '/fixtures/missing.png')
  assert.equal(cellPageSpec(cellById('image-fetch-fallback')).fallbackURL, '/fixtures/fallback.png')
  assert.deepEqual(cellPageSpec(cellById('compress-off-large')).rawForbids, undefined)
  assert.equal(stepExpectation(cellById('compress-off-large'), 'cold').shape, 'noCountersWhenDisabled')
  assert.equal(stepExpectation(cellById('image-fetch-fallback'), 'cold').shape, 'headerOnce')
  assert.deepEqual(cellPageSpec(cellById('image-fetch-error')).rawForbids, undefined)
  assert.deepEqual(cellById('image-fetch-error').rawForbids, ['/missing.png'])
})

test('the cell matrix digest is stable and changes when the matrix changes', () => {
  assert.equal(cellMatrixSha256(), cellMatrixSha256())
  assert.match(cellMatrixSha256(), /^[0-9A-F]{64}$/)
  const mutated = [...CELLS]
  mutated[0] = { ...mutated[0], surface: 'changed' }
  assert.notEqual(sha256(JSON.stringify(mutated)), cellMatrixSha256())
})

test('an unknown cell id is refused rather than silently skipped', () => {
  assert.throws(() => cellById('no-such-cell'), /unknown cell/)
})

// --------------------------------------------------------------------------
// Verdict assembly, on synthetic evidence
// --------------------------------------------------------------------------

const goodCanvas = () => canvas(2, 1, rgba([1, 2, 3, 255], [4, 5, 6, 255]))

/** Evidence for one side that satisfies the cell's own expectations. */
function satisfiedSide(cellId, which) {
  const cell = cellById(cellId)
  const steps = cellPageSpec(cell).steps.map((step) => {
    const expectation = stepExpectation(cell, step.label)
    // The cold capture is not special-cased: every cell names its own cold route, and the whole
    // point of the synthetic evidence is that it is built from the matrix rather than beside it.
    const sideShape = expectation.telemetryBySide?.[which] ?? expectation.telemetry

    const bytes = cell.images.reduce(
      (sum, name) => sum + (name === 'missing' ? 0 : fixtureBytes(name).length),
      0,
    )
    const telemetry = {
      attempts: 0, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0,
      blobPayloadPosts: 0, blobPayloadBytes: 0, stringPayloadPosts: 0,
      stringPayloadChars: 0, badBlobDataUrlPosts: 0,
    }
    if (sideShape === 'blobPost') {
      Object.assign(telemetry, {
        attempts: 1, constructed: 1, posts: 1, messages: 1, blobPayloadPosts: 1, blobPayloadBytes: bytes,
      })
    } else if (sideShape === 'stringPost') {
      Object.assign(telemetry, {
        attempts: 1, constructed: 1, posts: 1, messages: 1,
        stringPayloadPosts: 1, stringPayloadChars: W + 1,
      })
    } else if (sideShape === 'twoBlobPosts') {
      Object.assign(telemetry, {
        attempts: 2, constructed: 2, posts: 2, messages: 2,
        blobPayloadPosts: 2, blobPayloadBytes: bytes,
      })
    } else if (sideShape === 'twoStringPosts') {
      Object.assign(telemetry, {
        posts: 2, messages: 2,
        stringPayloadPosts: 2, stringPayloadChars: 2 * (W + 1),
      })
    } else if (sideShape === 'blobAndStringPost') {
      Object.assign(telemetry, {
        posts: 2, messages: 2,
        blobPayloadPosts: 1, blobPayloadBytes: fixtureBytes(cell.images[0]).length,
        stringPayloadPosts: 1, stringPayloadChars: W + 1,
      })
    } else if (sideShape === 'cspDenied') {
      Object.assign(telemetry, { attempts: 1, constructed: 1, errors: 1 })
    }

    let routes = expectation.shape === 'noCountersWhenDisabled' ? null : (ROUTE_SHAPES[expectation.shape] ?? ROUTE_SHAPES.zeros)
    if (expectation.cspDenied) {
      routes = { memo: 0, inflight: 0, header: 0, workerBlob: 1, workerString: 0, main: 1 }
    }

    return {
      label: step.label,
      geometry: step.geometry,
      // Raw output bytes are a property of the CAPTURE, not of the side that produced it: a passing
      // cell has baseline and candidate byte-identical raw, and both reproducible across contexts.
      raw: 'SVG:' + cellId + ':' + step.label,
      rawBytes: 64,
      rawSha256: sha256(cellId + step.label),
      // A failed fetch with no fallback yields a sized placeholder, not an inline raster.
      // Follow the frozen cell contract rather than fabricating a payload for `missing`.
      inlineDataUrls: cell.expectedInlineDataUrls ?? cell.images.length,
      canvas: goodCanvas(),
      routeReaderSeen: true,
      routes: which === 'candidate' ? routes : null,
      telemetry,
    }
  })
  return { steps }
}

function passingEngineDoc(engine) {
  const cells = {}
  for (const cellId of CELL_IDS) {
    cells[cellId] = {
      A: { baseline: satisfiedSide(cellId, 'baseline'), candidate: satisfiedSide(cellId, 'candidate') },
      B: { baseline: satisfiedSide(cellId, 'baseline'), candidate: satisfiedSide(cellId, 'candidate') },
    }
  }
  return { schema: RUNNER_SCHEMA, engine, provenance: provenanceEcho(), cells }
}

let PREPARED = null
function provenanceEcho() {
  assert.ok(PREPARED, 'prepared must be initialised first')
  return {
    candidateGitSha: PREPARED.candidateGitSha,
    baselineGitSha: PREPARED.baselineGitSha,
    measurementGitSha: PREPARED.measurementGitSha,
    candidateBundleSha256: PREPARED.candidate.sha256,
    baselineBundleSha256: PREPARED.baseline.sha256,
    playwrightVersion: PREPARED.playwrightVersion,
    cellMatrixSha256: PREPARED.cellMatrixSha256,
  }
}

test.before(() => {
  PREPARED = {
    schema: PREPARED_SCHEMA,
    measurementGitSha: 'f'.repeat(40),
    candidateGitSha: CANDIDATE_SHA,
    baselineGitSha: BASELINE_SHA,
    candidate: { sha256: 'C'.repeat(64) },
    baseline: { sha256: 'D'.repeat(64) },
    playwrightVersion: '1.55.1',
    cellMatrixSha256: cellMatrixSha256(),
    mechanism: { workerMinPayloadChars: W, maxImageBlobBytes: CAP },
    fixtures: Object.fromEntries(
      Object.keys(FIXTURES).map((n) => [n, { bytes: fixtureBytes(n).length }]),
    ),
  }
})

test('a complete, consistent, self-null evidence set is accepted', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.state, 'FIDELITY_ACCEPTED', JSON.stringify(summary.problems.slice(0, 5)))
  assert.equal(summary.performanceClaim, false)
  assert.match(summary.scope, /no speed claim on any engine/)
  const matrix = acceptanceMatrix(summary)
  for (const cellId of CELL_IDS) {
    for (const engine of ENGINES) assert.equal(matrix[cellId][engine], 'FIDELITY_PASS')
  }
})

test('a missing engine is INCOMPLETE_EVIDENCE, never a pass', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  delete docs.webkit
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.state, 'INCOMPLETE_EVIDENCE')
  assert.ok(summary.problems.some((p) => /webkit reported no evidence/.test(p)))
  assert.equal(acceptanceMatrix(summary)['large-first-capture'].webkit, 'INCOMPLETE_EVIDENCE')
})

test('a missing cell in one engine fails that engine and the gate, and leaves the others readable', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  delete docs.firefox.cells['csp-worker-none']
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.state, 'FIDELITY_FAILURE')
  assert.equal(summary.engines.firefox.state, 'FIDELITY_FAILURE')
  assert.equal(summary.engines.chromium.state, 'FIDELITY_PASS')
  assert.equal(acceptanceMatrix(summary)['csp-worker-none'].firefox, 'INCOMPLETE_EVIDENCE')
})

test('a missing self-null context fails the cell', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  delete docs.chromium.cells['large-repeat-scale'].B
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.engines.chromium.cells['large-repeat-scale'].state, 'FIDELITY_FAILURE')
  assert.ok(summary.engines.chromium.problems.some((p) => /context B missing/.test(p)))
})

test('an engine that cannot reproduce its own output fails its self-null', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const steps = docs.webkit.cells['large-repeat-width'].B.candidate.steps
  steps[1] = { ...steps[1], rawSha256: sha256('drifted') }
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.engines.webkit.state, 'FIDELITY_FAILURE')
  assert.ok(
    summary.engines.webkit.problems.some((p) => /not reproducible/.test(p)),
    JSON.stringify(summary.engines.webkit.problems),
  )
})

test('raw output divergence is a fidelity failure even when pixels match', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.chromium.cells['large-first-capture']
  cell.A.candidate.steps[0] = { ...cell.A.candidate.steps[0], raw: 'SVG:DIFFERENT' }
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.engines.chromium.cells['large-first-capture'].state, 'FIDELITY_FAILURE')
  assert.ok(/raw output differs/.test(summary.engines.chromium.problems[0]))
})

test('a candidate that stops inlining payloads fails the data-URL-persistence claim', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.firefox.cells['budget-eviction']
  cell.A.candidate.steps[1] = { ...cell.A.candidate.steps[1], inlineDataUrls: 1 }
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.engines.firefox.cells['budget-eviction'].state, 'FIDELITY_FAILURE')
  assert.ok(summary.engines.firefox.problems.some((p) => /inlined 1 distinct data: images/.test(p)))
})

test('the eviction cell requires the Blob/string split, not merely a successful post', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.chromium.cells['budget-eviction']
  cell.A.candidate.steps[1] = {
    ...cell.A.candidate.steps[1],
    routes: { memo: 0, inflight: 0, header: 0, workerBlob: 2, workerString: 0, main: 0 },
  }
  const verdict = cellVerdict('chromium', 'budget-eviction', { cells: { 'budget-eviction': cell } })
  assert.equal(verdict.state, 'FIDELITY_FAILURE')
  assert.ok(verdict.problems.some((p) => /route workerBlob=2 expected 1/.test(p)))
})

test('a strict-only pixel match is reported and refused at the default exact tier', () => {
  // One pixel out of 1000, off by 4 per channel: inside the repository's own strict snapdiff
  // convention, outside exact parity. The gate must report it rather than admit it.
  const wide = rgba(...Array.from({ length: 1000 }, () => [10, 20, 30, 255]))
  const drifted = rgba(
    ...Array.from({ length: 999 }, () => [10, 20, 30, 255]).concat([[14, 24, 34, 255]]),
  )
  const nearMiss = canvas(1000, 1, drifted)
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.webkit.cells['large-first-capture']
  for (const contextId of SELF_NULL_CONTEXTS) {
    cell[contextId].candidate.steps[0] = {
      ...cell[contextId].candidate.steps[0],
      canvas: nearMiss,
    }
    cell[contextId].baseline.steps[0] = {
      ...cell[contextId].baseline.steps[0],
      canvas: canvas(1000, 1, wide),
    }
  }
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.engines.webkit.cells['large-first-capture'].state, 'FIDELITY_FAILURE')
  assert.ok(
    summary.engines.webkit.problems.some((p) => /strict snapdiff convention/.test(p)),
    JSON.stringify(summary.engines.webkit.problems),
  )
  // …and the strict metrics are still reported, so the near-miss is legible rather than hidden.
  const record = summary.engines.webkit.cells['large-first-capture'].contexts.A[0].pixels
  assert.equal(record.exact, false)
  assert.equal(record.strict, true)
  assert.equal(record.differing, 1)
  assert.equal(record.maxChannelDelta, 4)
})

test('an unknown telemetry shape on either side is refused', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.chromium.cells['large-first-capture']
  cell.A.candidate.steps[0] = {
    ...cell.A.candidate.steps[0],
    telemetry: { ...cell.A.candidate.steps[0].telemetry, posts: 99 },
  }
  const verdict = cellVerdict('chromium', 'large-first-capture', { cells: { 'large-first-capture': cell } })
  assert.equal(verdict.state, 'FIDELITY_FAILURE')
  assert.ok(verdict.problems.some((p) => /worker telemetry posts=99 expected 1/.test(p)))
})

test('provenance drift in one engine fails the gate', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  docs.webkit.provenance.candidateBundleSha256 = '0'.repeat(64)
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.state, 'FIDELITY_FAILURE')
  assert.ok(summary.problems.some((p) => /provenance candidateBundleSha256 mismatch/.test(p)))
})

test('a wrong frozen candidate or baseline SHA fails the gate', () => {
  for (const field of ['candidateGitSha', 'baselineGitSha', 'measurementGitSha']) {
    const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
    docs.webkit.provenance[field] = '1'.repeat(40)
    const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
    assert.ok(summary.problems.some((p) => p.includes('provenance ' + field + ' mismatch')), field)
  }
})

test('a changed cell matrix cannot pass under frozen provenance', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const stale = { ...PREPARED, cellMatrixSha256: '9'.repeat(64) }
  const summary = acceptanceVerdict({ prepared: stale, engineDocuments: docs })
  assert.ok(summary.problems.some((p) => /provenance cellMatrixSha256 mismatch/.test(p)))
})

test('an unexpected engine and an unknown cell are both refused', () => {
  const withExtra = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  withExtra.edg = passingEngineDoc('edg')
  assert.ok(
    acceptanceVerdict({ prepared: PREPARED, engineDocuments: withExtra }).problems
      .some((p) => /unexpected engine/.test(p)),
  )
  const withCell = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  withCell.chromium.cells['not-a-cell'] = withCell.chromium.cells['large-first-capture']
  assert.ok(
    acceptanceVerdict({ prepared: PREPARED, engineDocuments: withCell }).engines.chromium.problems
      .some((p) => /unknown cell/.test(p)),
  )
})

test('a runner document with the wrong schema is refused', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  docs.chromium.schema = 'something-else'
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.ok(summary.problems.some((p) => /runner schema mismatch/.test(p)))
})

test('missing prepared provenance is refused rather than defaulted', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const summary = acceptanceVerdict({ prepared: null, engineDocuments: docs })
  assert.notEqual(summary.state, 'FIDELITY_ACCEPTED')
  assert.ok(summary.problems.some((p) => /prepared provenance is missing/.test(p)))
  const wrong = acceptanceVerdict({ prepared: { schema: 'nope' }, engineDocuments: docs })
  assert.ok(wrong.problems.some((p) => /wrong schema/.test(p)))
})

test('an engine verdict for an engine outside the matrix is INCOMPLETE_EVIDENCE', () => {
  const verdict = engineVerdict('safari', { cells: {} })
  assert.equal(verdict.state, 'INCOMPLETE_EVIDENCE')
  assert.match(verdict.problems[0], /unknown engine/)
})

test('a step missing on one side is a failure, not a skipped step', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.chromium.cells['large-repeat-scale']
  cell.A.baseline.steps = cell.A.baseline.steps.slice(0, 1)
  const verdict = cellVerdict('chromium', 'large-repeat-scale', { cells: { 'large-repeat-scale': cell } })
  assert.equal(verdict.state, 'FIDELITY_FAILURE')
  assert.ok(verdict.problems.some((p) => /missing on a side/.test(p)))
})

test('a raw output that still carries the failed image URL is refused on the fetch-error cells', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.webkit.cells['image-fetch-error']
  cell.A.candidate.steps[0] = {
    ...cell.A.candidate.steps[0],
    raw: 'SVG src="/missing.png"',
  }
  const verdict = cellVerdict('webkit', 'image-fetch-error', { cells: { 'image-fetch-error': cell } })
  assert.equal(verdict.state, 'FIDELITY_FAILURE')
  assert.ok(verdict.problems.some((p) => /still carries \/missing\.png/.test(p)))
})

test('a baseline that never touches the worker on a claim arm is refused', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const cell = docs.chromium.cells['large-repeat-scale']
  const zeroed = {
    attempts: 0, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0,
    blobPayloadPosts: 0, blobPayloadBytes: 0, stringPayloadPosts: 0,
    stringPayloadChars: 0, badBlobDataUrlPosts: 0,
  }
  cell.A.baseline.steps[1] = { ...cell.A.baseline.steps[1], telemetry: zeroed }
  const verdict = cellVerdict('chromium', 'large-repeat-scale', { cells: { 'large-repeat-scale': cell } })
  assert.equal(verdict.state, 'FIDELITY_FAILURE')
  assert.ok(verdict.problems.some((p) => /baseline telemetry at scale-1/.test(p)))
})

test('the gate records the exact cell and engine inventory it was decided against', () => {
  const docs = Object.fromEntries(ENGINES.map((e) => [e, passingEngineDoc(e)]))
  const summary = acceptanceVerdict({ prepared: PREPARED, engineDocuments: docs })
  assert.equal(summary.schema, 'snapdom-r11-fidelity-summary-v1')
  assert.deepEqual(summary.engineIds, ['chromium', 'firefox', 'webkit'])
  assert.equal(summary.cellIds.length, CELL_IDS.length)
  assert.equal(summary.provenance.candidateGitSha, CANDIDATE_SHA)
  assert.equal(summary.provenance.baselineGitSha, BASELINE_SHA)
  assert.equal(summary.performanceClaim, false)
})
