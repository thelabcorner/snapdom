/**
 * R11 AS-BLOB cross-engine FIDELITY acceptance: pure contracts.
 *
 * Browser-free by construction. Nothing here imports a browser, a bundler or a project source
 * file, so every rule the hosted gate enforces can be exercised under `node --test` on a machine
 * with no browsers installed. The hosted runner (fidelity-run.mjs) produces evidence; this module
 * decides what that evidence means, and the contract suite proves the decision itself is sound
 * using synthetic evidence rather than a browser.
 *
 * Three rules this module exists to make impossible to get wrong:
 *
 *  1. FIDELITY, NOT SPEED. There is no timing field, no clock read and no elapsed-time comparison
 *     anywhere in this module or in its callers. The Chromium effect (-55.6% on the large-scale
 *     arm, CI [-58.23,-52.89]) is NOT evidence about Firefox or WebKit and is never consulted
 *     here. Each engine is asked one question only: does the candidate produce the same output
 *     bytes and the same rendered pixels as the frozen baseline?
 *  2. FAIL CLOSED. A missing engine, a missing cell, a missing parity verdict, a missing self-null
 *     context or a provenance mismatch is INCOMPLETE_EVIDENCE, never a pass. Absence of evidence
 *     is treated as evidence of absence: a gate that skips what it cannot see reports green for a
 *     mechanism that was never exercised.
 *  3. NO CANDIDATE-ONLY SURFACE ON THE BASELINE. `options.__assetRoutes` does not exist in
 *     c523ddb, so every route-counter assertion is candidate-only. Route and fallback BEHAVIOUR is
 *     asserted on both sides through browser-level Worker instrumentation, which is a property of
 *     the platform rather than of the bundle.
 *
 * Reused deliberately from lane6-scratch/r10 (the confirmed AS-BLOB timing harness):
 * makeDeterministicPng, dataUrlCharsForBytes, sha256, assetRouteTotal, candidateWarmRouteValid
 * and geometrySweep. The fixtures and geometry sweeps that produced the measured Chromium effect
 * are the same fixtures and the same sweeps this gate re-asks for parity on, so a parity verdict is
 * about the mechanism that was measured and not about a new experiment.
 */

import crypto from 'node:crypto'
import {
  assetRouteTotal,
  candidateWarmRouteValid,
  dataUrlCharsForBytes,
  geometrySweep,
  makeDeterministicPng,
} from '../r10/asset-bench-lib.mjs'

export {
  assetRouteTotal,
  candidateWarmRouteValid,
  dataUrlCharsForBytes,
  geometrySweep,
  makeDeterministicPng,
}

export const sha256 = (data) =>
  crypto.createHash('sha256').update(data).digest('hex').toUpperCase()

// ---------------------------------------------------------------------------
// Frozen identity
// ---------------------------------------------------------------------------

/** The frozen mechanism under acceptance. Production src stays byte-identical to it. */
export const CANDIDATE_SHA = '2d27ad49b39bd6414b2fda925e6678dd7b35eb5a'
/** The frozen baseline the candidate is compared against, side by side. */
export const BASELINE_SHA = 'd391556b80be7a6d97bc4834d2ce6e24137515b2'
/** The only engines that may satisfy this gate. */
export const ENGINES = Object.freeze(['chromium', 'firefox', 'webkit'])
/** The public repository this workflow is allowed to run on. No secrets, no self-hosted runner. */
export const PUBLIC_REPOSITORY = 'thelabcorner/snapdom'

export const PREPARED_SCHEMA = 'snapdom-r11-fidelity-prepared-v1'
export const RUNNER_SCHEMA = 'snapdom-r11-fidelity-engine-v1'
export const SUMMARY_SCHEMA = 'snapdom-r11-fidelity-summary-v1'

/**
 * Two independent contexts per cell per engine. Context B is the self-null control: a fresh
 * context, fresh module instances and fresh caches, run again through the identical sequence. An
 * engine that cannot reproduce its own output twice is not able to adjudicate anyone else's.
 */
export const SELF_NULL_CONTEXTS = Object.freeze(['A', 'B'])

export const HOSTED_ONLY_MESSAGE =
  'R11 fidelity gate is GitHub-Actions-only: browser execution is prohibited outside public Actions'

/** Refuse to run anywhere but hosted public Actions. Deliberately has no override. */
export function assertHostedOnly(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') throw new Error(HOSTED_ONLY_MESSAGE)
  if (env.SNAPDOM_ALLOW_LOCAL_FIDELITY === '1') {
    throw new Error('SNAPDOM_ALLOW_LOCAL_FIDELITY is not honoured: this gate has no local mode')
  }
  const repo = env.SNAPDOM_ALLOWED_REPOSITORY || PUBLIC_REPOSITORY
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== repo) {
    throw new Error('R11 fidelity gate runs only on the public repository ' + repo)
  }
}

// ---------------------------------------------------------------------------
// Pixel parity policy, taken from this repository's own visual conventions
// ---------------------------------------------------------------------------

/**
 * Parity tiers, and where each number comes from.
 *
 * `exact` is the requirement for every cell in this gate, and it is deliberately stronger than any
 * existing visual threshold. AS-BLOB changes WHICH payload compress's worker receives (a Blob
 * instead of a base64 string), and both payloads are derived from the same `resp.blob()` in
 * snapFetch, so the decoded bitmap, the downsample, the re-encode and therefore every pixel are
 * the same object arriving by a different route. A mechanism shaped like this has no way to
 * produce a pixel change, so anything short of exact would be admitting a fidelity regression
 * that this mechanism cannot have caused.
 *
 * `strict` is this repository's existing snapdiff convention. It is kept as a REPORTED diagnostic
 * and as the only escape this module would ever admit, so a near-miss is visible in the summary
 * instead of being either hidden behind exact parity or promoted into an admission:
 *   - failureRatio 0.005 and threshold 0.1 come from the defineDemoSuite call in
 *     __tests__/visual.demos.shared.js ("tolerate 0.5% drift from font-hinting jitter");
 *   - channelTolerance 40 comes from __tests__/visual.fidelity.livedom.test.js (its per-channel
 *     `tol = 40`), the repository's other cross-engine pixel tolerance.
 */
export const PIXEL_CONVENTIONS = Object.freeze({
  threshold: 0.1,
  failureRatio: 0.005,
  channelTolerance: 40,
  defaultTier: 'exact',
})

/**
 * Raw-output parity for one step.
 *
 * Two modes, both authoritative, and the difference is only about how the bytes travel:
 *  - 'bytes': both raws are small enough to be carried inline, so equality is a real byte
 *    comparison. The digests are compared as well, and a disagreement between the two is itself a
 *    failure: it would mean the page computed a digest for bytes it was not reporting.
 *  - 'digest': at least one raw exceeded the inline limit, so parity rests on the frozen
 *    SHA-256 plus the UTF-8 byte length. That is the standard way to compare artifacts of any size,
 *    and it is exact in the sense that matters: equal digest AND equal length is the same payload.
 *
 * A step whose raw evidence is missing on either side fails. It does not fall back to pixels, and
 * it does not skip: the raw serializer is a separate output surface from the rasterizer, and a
 * mechanism can leave one untouched while breaking the other.
 */
export function rawParityVerdict(baseline, candidate) {
  if (!baseline || !candidate) return { ok: false, reason: 'missing raw output evidence on a side' }
  const bLen = Number(baseline.rawBytes)
  const cLen = Number(candidate.rawBytes)
  if (!Number.isFinite(bLen) || !Number.isFinite(cLen)) {
    return { ok: false, reason: 'raw output byte length was not reported' }
  }
  if (typeof baseline.rawSha256 !== 'string' || typeof candidate.rawSha256 !== 'string') {
    return { ok: false, reason: 'raw output digest was not reported' }
  }
  const digestsAgree = baseline.rawSha256 === candidate.rawSha256
  if (!digestsAgree) {
    return {
      ok: false,
      reason: 'raw output digests differ: ' + baseline.rawSha256 + ' vs ' + candidate.rawSha256,
      baselineSha256: baseline.rawSha256,
      candidateSha256: candidate.rawSha256,
      baselineBytes: bLen,
      candidateBytes: cLen,
    }
  }
  if (bLen !== cLen) {
    return {
      ok: false,
      reason: 'raw output byte length differs: ' + bLen + ' vs ' + cLen,
      baselineSha256: baseline.rawSha256,
      candidateSha256: candidate.rawSha256,
      baselineBytes: bLen,
      candidateBytes: cLen,
    }
  }
  const bRaw = typeof baseline.raw === 'string' ? baseline.raw : null
  const cRaw = typeof candidate.raw === 'string' ? candidate.raw : null
  if (bRaw !== null && cRaw !== null) {
    if (bRaw !== cRaw) return { ok: false, reason: 'raw output bytes differ', mode: 'bytes' }
    return { ok: true, mode: 'bytes', baselineBytes: bLen, baselineSha256: baseline.rawSha256 }
  }
  return { ok: true, mode: 'digest', baselineBytes: bLen, baselineSha256: baseline.rawSha256 }
}

/**
 * Pixel verdict for one step, from both sides' raw RGBA.
 *
 * Exact comparison is byte equality over the whole RGBA buffer at equal dimensions: no tolerance,
 * no sampling, no hashing. A digest would be cheaper and would be the wrong tool in a gate whose
 * entire job is to be certain.
 */
export function pixelVerdict(baselineCanvas, candidateCanvas, conventions = PIXEL_CONVENTIONS) {
  if (!baselineCanvas || !candidateCanvas) {
    return { ok: false, tier: 'exact', strict: false, reason: 'missing rendered canvas evidence' }
  }
  if (
    typeof baselineCanvas.pixelsB64 !== 'string' ||
    typeof candidateCanvas.pixelsB64 !== 'string'
  ) {
    return { ok: false, tier: 'exact', strict: false, reason: 'canvas pixels were not transferred' }
  }
  if (baselineCanvas.w !== candidateCanvas.w || baselineCanvas.h !== candidateCanvas.h) {
    return {
      ok: false,
      tier: 'exact',
      strict: false,
      reason:
        'rendered size differs: baseline ' + baselineCanvas.w + 'x' + baselineCanvas.h +
        ' vs candidate ' + candidateCanvas.w + 'x' + candidateCanvas.h,
    }
  }

  const a = Buffer.from(baselineCanvas.pixelsB64, 'base64')
  const b = Buffer.from(candidateCanvas.pixelsB64, 'base64')
  if (a.length === 0 || a.length !== b.length) {
    return {
      ok: false,
      tier: 'exact',
      strict: false,
      reason: 'rendered pixel buffers differ in length: ' + a.length + ' vs ' + b.length,
    }
  }

  const pixels = a.length / 4
  let differing = 0
  let maxChannelDelta = 0
  let firstDiff = null
  for (let i = 0; i < a.length; i += 4) {
    let pixelDiffers = false
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a[i + c] - b[i + c])
      if (delta) pixelDiffers = true
      if (delta > maxChannelDelta) maxChannelDelta = delta
    }
    if (pixelDiffers) {
      differing++
      if (!firstDiff) {
        firstDiff = {
          x: Math.floor(i / 4) % baselineCanvas.w,
          y: Math.floor(Math.floor(i / 4) / baselineCanvas.w),
          baseline: [a[i], a[i + 1], a[i + 2], a[i + 3]],
          candidate: [b[i], b[i + 1], b[i + 2], b[i + 3]],
        }
      }
    }
  }

  const ratio = differing / pixels
  const strict =
    ratio <= conventions.failureRatio && maxChannelDelta <= conventions.channelTolerance
  const exact = differing === 0
  return {
    ok: exact || strict,
    exact,
    strict,
    tier: exact ? 'exact' : strict ? 'strict' : 'fail',
    differing,
    differingRatio: ratio,
    pixels,
    maxChannelDelta,
    firstDiff,
  }
}

// ---------------------------------------------------------------------------
// Route contracts
// ---------------------------------------------------------------------------

export const ROUTES = Object.freeze(['memo', 'inflight', 'header', 'workerBlob', 'workerString', 'main'])

const routes = (values) => Object.fromEntries(ROUTES.map((k) => [k, values[k] ?? 0]))

/** Terminal route shapes, including the two-image eviction page. */
export const ROUTE_SHAPES = Object.freeze({
  zeros: routes({}),
  memoOnce: routes({ memo: 1 }),
  workerBlobOnce: routes({ workerBlob: 1 }),
  workerBlobTwice: routes({ workerBlob: 2 }),
  workerBlobStringOnce: routes({ workerBlob: 1, workerString: 1 }),
  headerOnce: routes({ header: 1 }),
  mainOnce: routes({ main: 1 }),
})

/**
 * Worker telemetry contracts. These apply to BOTH sides: `window.Worker` is a platform surface,
 * present in c523ddb and d391556 alike, and asserting it on both sides is what stops a silent
 * baseline fallback from being misread as candidate parity.
 *
 * `blobPost` additionally pins the posted Blob to the exact fixture byte length, which is what
 * proves the candidate handed the worker the bytes the fetch produced rather than a re-encode.
 * `stringPost` pins the posted base64 length above WORKER_MIN_PAYLOAD_CHARS, which is what proves
 * the baseline really is doing the work AS-BLOB removes.
 */
export const TELEMETRY_SHAPES = Object.freeze({
  blobPost: {
    posts: 1, messages: 1, errors: 0, errorPosts: 0,
    blobPayloadPosts: 1, stringPayloadPosts: 0, badBlobDataUrlPosts: 0,
    requiresFixtureBytes: true,
  },
  twoBlobPosts: {
    posts: 2, messages: 2, errors: 0, errorPosts: 0,
    blobPayloadPosts: 2, stringPayloadPosts: 0, badBlobDataUrlPosts: 0,
    requiresFixtureBytes: true,
  },
  stringPost: {
    posts: 1, messages: 1, errors: 0, errorPosts: 0,
    blobPayloadPosts: 0, stringPayloadPosts: 1, badBlobDataUrlPosts: 0,
    requiresPayloadChars: true,
  },
  twoStringPosts: {
    posts: 2, messages: 2, errors: 0, errorPosts: 0,
    blobPayloadPosts: 0, stringPayloadPosts: 2, badBlobDataUrlPosts: 0,
    requiresPayloadChars: true,
  },
  blobAndStringPost: {
    posts: 2, messages: 2, errors: 0, errorPosts: 0,
    blobPayloadPosts: 1, stringPayloadPosts: 1, badBlobDataUrlPosts: 0,
    requiresBlobOneOfFixtureBytes: true,
    requiresPayloadChars: true,
  },
  noWorker: {
    attempts: 0, constructed: 0, posts: 0, messages: 0, errors: 0, errorPosts: 0,
    blobPayloadPosts: 0, stringPayloadPosts: 0,
  },
  /**
   * CSP denied the worker. Two legal shapes: the constructor threw (synchronous denial) or the
   * object was constructed and the denial arrived asynchronously through the error event. The r10
   * harness already had to admit both, so this reuses its definition rather than restating it.
   */
  cspDenied: {
    cspDenied: true,
    minAttempts: 1,
    requireNoMessages: true,
    requireNoErrorPosts: true,
  },
})

export function telemetryVerdict(
  shape,
  telemetry,
  { fixtureBytes = null, fixtureByteSizes = null, workerMinPayloadChars = null } = {},
) {
  if (!telemetry) return { ok: false, reason: 'missing browser-level Worker telemetry' }
  const n = (key) => Number(telemetry[key]) || 0

  if (shape.cspDenied) {
    const attempts = n('attempts')
    const syncDenied = attempts >= shape.minAttempts && n('constructed') === 0 && n('posts') === 0
    const asyncDenied = attempts >= shape.minAttempts && n('constructed') >= 1 && n('errors') >= 1
    const noMessages = shape.requireNoMessages ? n('messages') === 0 : true
    const noErrorPosts = shape.requireNoErrorPosts ? n('errorPosts') === 0 : true
    if (!(syncDenied || asyncDenied) || !noMessages || !noErrorPosts) {
      return { ok: false, reason: 'CSP did not end in a denied worker route', telemetry }
    }
    return { ok: true, denial: syncDenied ? 'sync' : 'async', telemetry }
  }

  for (const key of Object.keys(shape)) {
    if (key.startsWith('requires')) continue
    if (n(key) !== shape[key]) {
      return {
        ok: false,
        reason: 'worker telemetry ' + key + '=' + n(key) + ' expected ' + shape[key],
        telemetry,
      }
    }
  }
  // Workers are pooled. Warm posts often construct zero Workers; construction is not per-image.
  // An attempt without construction is a failed worker route, not a successful Blob/string post.
  if (n('posts') > 0 && (
    n('attempts') !== n('constructed') ||
    n('attempts') > n('posts') ||
    n('errors') > 0
  )) return { ok: false, reason: 'unexpected worker construction or error on successful posts', telemetry }
  if (shape.requiresFixtureBytes) {
    if (!Number.isInteger(fixtureBytes) || fixtureBytes <= 0) {
      return { ok: false, reason: 'blob-post telemetry needs the exact fixture byte length', telemetry }
    }
    if (n('blobPayloadBytes') !== fixtureBytes) {
      return {
        ok: false,
        reason: 'posted Blob was ' + n('blobPayloadBytes') + ' bytes, fixture is ' + fixtureBytes,
        telemetry,
      }
    }
  }
  if (shape.requiresBlobOneOfFixtureBytes) {
    if (!Array.isArray(fixtureByteSizes) || fixtureByteSizes.length !== 2 ||
        !fixtureByteSizes.every((size) => Number.isInteger(size) && size > 0) ||
        !fixtureByteSizes.includes(n('blobPayloadBytes'))) {
      return { ok: false, reason: 'posted Blob is not exactly one of the two eviction fixtures', telemetry }
    }
  }
  if (shape.requiresPayloadChars) {
    if (!Number.isInteger(workerMinPayloadChars) || workerMinPayloadChars <= 0) {
      return { ok: false, reason: 'string-post telemetry needs the worker payload threshold', telemetry }
    }
    if (n('stringPayloadChars') <= workerMinPayloadChars) {
      return {
        ok: false,
        reason:
          'posted string payload was ' + n('stringPayloadChars') +
          ' chars, threshold is ' + workerMinPayloadChars,
        telemetry,
      }
    }
  }
  return { ok: true, telemetry }
}

/**
 * Candidate route counters for one step.
 *
 * Two admission forms, both deliberate. An exact terminal shape where the geometry forces a unique
 * route; and, for CSP only, the dual-accounting allowance where one capture can legitimately record
 * an attempted post AND the main-thread fallback. That allowance is `candidateWarmRouteValid`'s,
 * imported from r10 rather than restated, so it has exactly one definition in the repository.
 */
export function candidateRouteVerdict(expectation, observed, routeReaderSeen = true) {
  // Production deliberately has no counter object with compress:false. Only admit null
  // after the caller's instrumentation confirms afterRender executed.
  if (expectation.shape === 'noCountersWhenDisabled') {
    return routeReaderSeen === true && observed === null
      ? { ok: true, shape: 'noCountersWhenDisabled', routes: null, total: 0 }
      : { ok: false, reason: 'compress:false requires verified afterRender and no counters' }
  }
  if (!observed) {
    return { ok: false, reason: 'candidate afterRender published no __assetRoutes' }
  }
  if (expectation.cspDenied) {
    return candidateWarmRouteValid('worker-negative', observed, 0)
      ? { ok: true, shape: 'cspDenied', routes: observed, total: assetRouteTotal(observed) }
      : { ok: false, reason: 'CSP denial accounting invalid', routes: observed }
  }
  const shape = ROUTE_SHAPES[expectation.shape]
  if (!shape) return { ok: false, reason: 'unknown route shape ' + expectation.shape }
  for (const key of ROUTES) {
    if ((Number(observed[key]) || 0) !== shape[key]) {
      return {
        ok: false,
        reason: 'route ' + key + '=' + (Number(observed[key]) || 0) + ' expected ' + shape[key],
        routes: observed,
      }
    }
  }
  return { ok: true, shape: expectation.shape, routes: observed, total: assetRouteTotal(observed) }
}

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

/**
 * Fixture specifications, generated by `fixtureBytes()` and frozen by SHA-256 in prepare.mjs.
 *
 * `large` and `small` are byte-for-byte the r10 fixtures, so this gate re-asks for parity on the
 * exact payloads behind the measured Chromium effect.
 *
 * `evictA` and `evictB` exist for one surface only: MAX_IMAGE_BLOB_BYTES is 64 MiB, so a genuine
 * byte-budget sweep needs more than 64 MiB of retained Blobs. Two 4100x2800 incompressible-ish RGBA
 * PNGs come to ~39.3 MB each, so adding the second overshoots the budget by ~11 MB and the sweep
 * must drop the OLDEST (evictA) while keeping the newest (evictB), landing ~25 MB under the cap.
 * That is the smallest honest fixture that reaches the real cap; anything smaller would only
 * re-prove the arithmetic that scripts/as-blob.node.test.mjs already proves under `node --test`
 * with no browser. The overshoot and the post-drop headroom are both asserted by the contract
 * suite, because a fixture that quietly stopped reaching the cap would turn this cell into a
 * green no-op.
 */
export const FIXTURES = Object.freeze({
  large: { name: 'large', width: 1200, height: 800, seed: 0x51a7, entropy: true, box: [300, 200] },
  small: { name: 'small', width: 96, height: 96, seed: 0x51a7, entropy: false, box: [32, 32] },
  evictA: { name: 'evictA', width: 4100, height: 2800, seed: 0x0e71, entropy: true, box: [220, 160] },
  evictB: { name: 'evictB', width: 4100, height: 2800, seed: 0x0e72, entropy: true, box: [220, 160] },
  fallback: { name: 'fallback', width: 64, height: 64, seed: 0x0fa1, entropy: false, box: [120, 90] },
})

export function fixtureBytes(name) {
  const spec = FIXTURES[name]
  if (!spec) throw new Error('unknown fixture ' + name)
  return fixtureBuffer(name, spec)
}

// The eviction fixtures are ~35 MB of incompressible pixels each, so generating them on demand
// inside a verdict loop is not affordable. The generator is deterministic and pure, so one buffer
// per fixture per process is both correct and necessary.
const fixtureBufferCache = new Map()
function fixtureBuffer(name, spec) {
  const cached = fixtureBufferCache.get(name)
  if (cached) return cached
  const bytes = makeDeterministicPng(spec.width, spec.height, { seed: spec.seed, entropy: spec.entropy })
  fixtureBufferCache.set(name, bytes)
  return bytes
}

/** Frozen byte length per fixture, computed once. */
export function fixtureByteLengths() {
  return Object.fromEntries(Object.keys(FIXTURES).map((name) => [name, fixtureBytes(name).length]))
}

// ---------------------------------------------------------------------------
// Cell matrix: one entry per semantic surface AS-BLOB touches
// ---------------------------------------------------------------------------

/** The 'missing' pseudo-fixture is a URL the server answers 404 for. */
export const MISSING_FIXTURE = Object.freeze({
  name: 'missing',
  src: '/fixtures/missing.png',
  naturalWidth: 120,
  naturalHeight: 90,
  box: [120, 90],
})

/**
 * Fields:
 *  - `repeat.kind`  'none' | 'same' | 'scale' | 'width'. Geometry applied after the cold capture,
 *                   through r10's geometrySweep, so the repeat arms are the same sweeps that
 *                   carried the timing claim rather than a new set invented for parity.
 *  - `csp`          'none' | 'worker-none', served as a RESPONSE HEADER rather than a meta tag so
 *                   it governs the module script and the worker construction alike.
 *  - `emulate`      'no-worker' | 'no-offscreen', applied by an init script, i.e. BEFORE any page
 *                   script and therefore before module execution. That is the only point at which
 *                   `compressWorkerRouteSupported()` can still observe the absence.
 *  - `rawForbids`   substrings that must not survive into the candidate's raw output.
 *  - `expect.steps` per-step candidate route shape plus a Worker telemetry shape, keyed by label.
 *  - `expect.rest`  the same, for every step after the named ones.
 *  - `telemetryBySide` explicitly pins both R13 sides to the AS-BLOB transport. The
 *                   baseline d391556 retains fetched Blob sidecars; the candidate 2d27ad4
 *                   changes decoded-bitmap reuse inside the worker, not the posted payload.
 *                   The two-image eviction arm still has one retained Blob and one string.
 */
export const CELLS = Object.freeze([
  {
    id: 'large-first-capture',
    surface: 'large raster, first capture, cold image memo, worker route reached',
    images: ['large'],
    cache: 'soft',
    compress: true,
    repeat: { kind: 'none' },
    expect: { steps: { cold: { shape: 'workerBlobOnce', telemetry: 'blobPost' } } },
  },
  {
    id: 'large-repeat-same',
    surface: 'cache-soft repeat at the SAME geometry: compression memo short-circuit',
    images: ['large'],
    cache: 'soft',
    compress: true,
    repeat: { kind: 'same', count: 3 },
    expect: {
      steps: { cold: { shape: 'workerBlobOnce', telemetry: 'blobPost' } },
      rest: { shape: 'memoOnce', telemetry: 'noWorker' },
    },
  },
  {
    id: 'large-repeat-scale',
    surface: 'repeat capture with changing scale: the claimed worker route',
    images: ['large'],
    cache: 'soft',
    compress: true,
    repeat: { kind: 'scale', count: 4 },
    expect: {
      steps: { cold: { shape: 'workerBlobOnce', telemetry: 'blobPost' } },
      rest: {
        shape: 'workerBlobOnce',
        telemetry: 'blobPost',
        telemetryBySide: { baseline: 'blobPost', candidate: 'blobPost' },
      },
    },
  },
  {
    id: 'large-repeat-width',
    surface: 'repeat capture with changing target width: the second claimed route',
    images: ['large'],
    cache: 'soft',
    compress: true,
    repeat: { kind: 'width', count: 4 },
    expect: {
      steps: { cold: { shape: 'workerBlobOnce', telemetry: 'blobPost' } },
      rest: {
        shape: 'workerBlobOnce',
        telemetry: 'blobPost',
        telemetryBySide: { baseline: 'blobPost', candidate: 'blobPost' },
      },
    },
  },
  {
    id: 'small-first-capture',
    surface: 'small raster below WORKER_MIN_PAYLOAD_CHARS: main-thread decode by design',
    images: ['small'],
    cache: 'soft',
    compress: true,
    repeat: { kind: 'none' },
    expect: { steps: { cold: { shape: 'mainOnce', telemetry: 'noWorker' } } },
  },
  {
    id: 'small-repeat-scale',
    surface: 'below-threshold raster on a repeat capture with changed geometry',
    images: ['small'],
    cache: 'soft',
    compress: true,
    repeat: { kind: 'scale', count: 3 },
    expect: {
      steps: { cold: { shape: 'mainOnce', telemetry: 'noWorker' } },
      rest: { shape: 'mainOnce', telemetry: 'noWorker' },
    },
  },
  {
    id: 'compress-off-large',
    surface: 'compress:false — the retention gate input is false, so no Blob is retained at all',
    images: ['large'],
    cache: 'soft',
    compress: false,
    repeat: { kind: 'scale', count: 3 },
    expect: {
      steps: { cold: { shape: 'noCountersWhenDisabled', telemetry: 'noWorker' } },
      rest: { shape: 'noCountersWhenDisabled', telemetry: 'noWorker' },
    },
  },
  {
    id: 'worker-missing',
    surface: 'Worker absent before module execution: the capability gate closes the route',
    images: ['large'],
    cache: 'soft',
    compress: true,
    emulate: 'no-worker',
    repeat: { kind: 'scale', count: 3 },
    expect: {
      steps: { cold: { shape: 'mainOnce', telemetry: 'noWorker' } },
      rest: { shape: 'mainOnce', telemetry: 'noWorker' },
    },
  },
  {
    id: 'offscreen-missing',
    surface: 'OffscreenCanvas absent before module execution: the capability gate closes the route',
    images: ['large'],
    cache: 'soft',
    compress: true,
    emulate: 'no-offscreen',
    repeat: { kind: 'scale', count: 3 },
    expect: {
      steps: { cold: { shape: 'mainOnce', telemetry: 'noWorker' } },
      rest: { shape: 'mainOnce', telemetry: 'noWorker' },
    },
  },
  {
    id: 'csp-worker-none',
    surface: "CSP worker-src 'none': construction fails, the route closes, sidecars are purged",
    images: ['large'],
    cache: 'soft',
    compress: true,
    csp: 'worker-none',
    repeat: { kind: 'scale', count: 3 },
    expect: {
      steps: { cold: { cspDenied: true, telemetry: 'cspDenied' } },
      rest: { shape: 'mainOnce', telemetry: 'noWorker' },
    },
  },
  {
    id: 'cache-disabled',
    surface: "cache:'disabled' — every persistent map is replaced between captures",
    images: ['large'],
    cache: 'disabled',
    compress: true,
    repeat: { kind: 'scale', count: 3 },
    expect: {
      steps: { cold: { shape: 'workerBlobOnce', telemetry: 'blobPost' } },
      rest: {
        shape: 'workerBlobOnce',
        telemetry: 'blobPost',
        telemetryBySide: { baseline: 'blobPost', candidate: 'blobPost' },
      },
    },
  },
  {
    id: 'budget-eviction',
    surface: 'byte-budget sweep: the oldest Blob sidecar is dropped while its data URL persists',
    images: ['evictA', 'evictB'],
    cache: 'soft',
    compress: true,
    repeat: { kind: 'scale', count: 2 },
    expect: {
      // Both image fetches deliver a Blob to the current clone on cold capture; the budget
      // drops a persistent sidecar, which matters on the subsequent changed-geometry sweep.
      steps: { cold: { shape: 'workerBlobTwice', telemetry: 'twoBlobPosts' } },
      rest: {
        shape: 'workerBlobStringOnce',
        telemetry: 'blobAndStringPost',
        telemetryBySide: { baseline: 'blobAndStringPost', candidate: 'blobAndStringPost' },
      },
    },
  },
  {
    id: 'image-fetch-error',
    surface: 'image fetch fails: a sized placeholder replaces the element on both sides',
    images: ['missing'],
    // The fetch fails, so nothing is inlined: the element is replaced by a sized placeholder. The
    // count is stated rather than derived, because "every image became a data: URL" is the claim for
    // the cells where the payloads exist and is exactly wrong for this one.
    expectedInlineDataUrls: 0,
    cache: 'soft',
    compress: true,
    repeat: { kind: 'scale', count: 2 },
    rawForbids: ['/missing.png'],
    expect: {
      steps: { cold: { shape: 'zeros', telemetry: 'noWorker' } },
      rest: { shape: 'zeros', telemetry: 'noWorker' },
    },
  },
  {
    id: 'image-fetch-fallback',
    surface: 'image fetch fails and fallbackURL succeeds: the fallback payload is inlined',
    images: ['missing'],
    fallbackURL: '/fixtures/fallback.png',
    cache: 'soft',
    compress: true,
    repeat: { kind: 'scale', count: 2 },
    rawForbids: ['/missing.png'],
    expect: {
      steps: { cold: { shape: 'headerOnce', telemetry: 'noWorker' } },
      rest: { shape: 'headerOnce', telemetry: 'noWorker' },
    },
  },
])

export const CELL_IDS = Object.freeze(CELLS.map((c) => c.id))

export function cellById(id) {
  const cell = CELLS.find((c) => c.id === id)
  if (!cell) throw new Error('unknown cell ' + id)
  return cell
}

/** Cold capture at scale 1, then the cell's geometry sweep. */
export function buildSteps(cell) {
  const repeat = cell.repeat ?? { kind: 'none' }
  const steps = [{ label: 'cold', geometry: { scale: 1, dpr: 1 } }]
  if (repeat.kind === 'none') return steps
  const count = Number.isInteger(repeat.count) ? repeat.count : 1
  if (repeat.kind === 'same' && count < 2) {
    throw new Error('a same-geometry repeat arm needs at least 2 steps')
  }
  for (const geometry of geometrySweep(repeat.kind, count)) {
    steps.push({ label: repeat.kind + '-' + (steps.length - 1), geometry })
  }
  return steps
}

/** Serialisable description of a cell's DOM and sequence, as the hosted page needs it. */
export function cellPageSpec(cell) {
  const images = cell.images.map((name) => {
    if (name === 'missing') return { ...MISSING_FIXTURE }
    const spec = FIXTURES[name]
    return {
      name,
      src: '/fixtures/' + name + '.png',
      naturalWidth: spec.width,
      naturalHeight: spec.height,
      box: spec.box,
    }
  })
  return {
    id: cell.id,
    images,
    fallbackURL: cell.fallbackURL ?? null,
    cache: cell.cache,
    compress: cell.compress,
    csp: cell.csp ?? 'none',
    steps: buildSteps(cell),
  }
}

/** The expectation for one step, or null when the cell named none — which is itself a failure. */
export function stepExpectation(cell, label) {
  const named = cell.expect?.steps?.[label]
  if (named) return named
  return cell.expect?.rest ?? null
}

/** Stable digest of the matrix itself, so a changed cell set cannot pass under frozen provenance. */
export function cellMatrixSha256() {
  return sha256(JSON.stringify(CELLS))
}

// ---------------------------------------------------------------------------
// Verdict assembly
// ---------------------------------------------------------------------------

/** Sum of frozen fixture byte lengths, from a prepared manifest when one is supplied. */
const bytesOf = (names, byteLengths) =>
  names.reduce((sum, name) => sum + (byteLengths[name] ?? 0), 0)

/**
 * Decide one cell for one engine from the evidence of both self-null contexts.
 *
 * `evidence.cells[cellId]` is `{ A: { baseline, candidate }, B: { baseline, candidate } }`, where
 * each side holds one record per step. Anything absent is INCOMPLETE_EVIDENCE, not a pass.
 */
export function cellVerdict(engine, cellId, evidence, options = {}) {
  const {
    workerMinPayloadChars = null,
    byteLengthManifest = null,
    pixelTier = PIXEL_CONVENTIONS.defaultTier,
  } = options
  const problems = []
  const cell = cellById(cellId)
  const spec = cellPageSpec(cell)
  const contexts = evidence?.cells?.[cellId]

  if (!contexts) {
    return {
      engine,
      cell: cellId,
      surface: cell.surface,
      state: 'INCOMPLETE_EVIDENCE',
      problems: ['engine ' + engine + ' reported no evidence for cell ' + cellId],
      selfNull: { ok: false, mismatches: ['no contexts'] },
      contexts: {},
    }
  }

  const byteLengths = byteLengthManifest ?? fixtureByteLengths()
  const fixtureBytesForCell = bytesOf(
    cell.images.filter((name) => name !== 'missing'),
    byteLengths,
  )
  const expectedInline = cell.expectedInlineDataUrls ?? spec.images.length

  const perContext = {}
  for (const contextId of SELF_NULL_CONTEXTS) {
    const context = contexts[contextId]
    if (!context) {
      problems.push('self-null context ' + contextId + ' missing')
      continue
    }
    const records = []
    for (const step of spec.steps) {
      const baseline = context.baseline?.steps?.find((s) => s.label === step.label)
      const candidate = context.candidate?.steps?.find((s) => s.label === step.label)
      if (!baseline || !candidate) {
        problems.push('step ' + step.label + ' missing on a side')
        continue
      }

      // Raw output bytes. Deterministic by construction for these fixtures (no clock, no counter
      // and no random token reaches the serializer), so exact equality is the requirement.
      const raw = rawParityVerdict(baseline, candidate)
      if (!raw.ok) problems.push('raw output differs at ' + step.label + ': ' + raw.reason)
      for (const needle of cell.rawForbids ?? []) {
        // The raw SVG transport is percent-encoded. Without the encoded check,
        // a forbidden missing-image URL can survive as %2Fmissing.png unnoticed.
        if (typeof candidate.raw === 'string' &&
            (candidate.raw.includes(needle) || candidate.raw.includes(encodeURIComponent(needle)))) {
          problems.push('candidate raw output still carries ' + needle + ' at ' + step.label)
        }
      }

      // "The data URL persists" has to mean something observable. Every payload that EXISTS must
      // survive as a data: URL on BOTH sides: the budget-eviction cell depends on it, since a swept
      // sidecar must still leave its payload reachable. Counted as DISTINCT URLs, so an engine that
      // emits the same payload twice does not inflate the count and hide a missing one.
      if (candidate.inlineDataUrls !== expectedInline) {
        problems.push(
          'candidate inlined ' + candidate.inlineDataUrls + ' distinct data: images at ' + step.label +
          ', expected ' + expectedInline,
        )
      }
      if (baseline.inlineDataUrls !== expectedInline) {
        problems.push(
          'baseline inlined ' + baseline.inlineDataUrls + ' distinct data: images at ' + step.label +
          ', expected ' + expectedInline,
        )
      }

      const pixels = pixelVerdict(baseline.canvas, candidate.canvas)
      if (!pixels.ok) {
        problems.push('rendered pixels differ at ' + step.label + ': ' + (pixels.reason ?? pixels.tier))
      } else if (pixels.tier === 'strict' && pixelTier !== 'strict') {
        problems.push(
          'rendered pixels at ' + step.label + ' matched only the strict snapdiff convention (' +
          pixels.differing + '/' + pixels.pixels + ' pixels, max channel delta ' +
          pixels.maxChannelDelta + ')',
        )
      }

      // Route and fallback behaviour. Counters are candidate-only; Worker telemetry is asserted on
      // BOTH sides because it is a platform surface, not a bundle surface.
      const expectation = stepExpectation(cell, step.label)
      if (!expectation) {
        problems.push('step ' + step.label + ' has no expectation')
      } else {
        const routeVerdict = candidateRouteVerdict(expectation, candidate.routes, candidate.routeReaderSeen)
        if (!routeVerdict.ok) {
          problems.push('candidate route at ' + step.label + ': ' + routeVerdict.reason)
        }

        for (const side of ['baseline', 'candidate']) {
          const sideShape = expectation.telemetryBySide?.[side] ?? expectation.telemetry
          const resolved = TELEMETRY_SHAPES[sideShape]
          if (!resolved) {
            problems.push('step ' + step.label + ' names unknown telemetry shape ' + sideShape)
            continue
          }
          const verdict = telemetryVerdict(
            resolved,
            side === 'baseline' ? baseline.telemetry : candidate.telemetry,
            {
              fixtureBytes: fixtureBytesForCell || null,
              fixtureByteSizes: cell.images.filter((name) => name !== 'missing')
                .map((name) => byteLengths[name]),
              workerMinPayloadChars,
            },
          )
          if (!verdict.ok) problems.push(side + ' telemetry at ' + step.label + ': ' + verdict.reason)
        }
      }

      records.push({
        label: step.label,
        geometry: step.geometry,
        raw,
        rawEqual: raw.ok,
        rawBytes: { baseline: baseline.rawBytes, candidate: candidate.rawBytes },
        rawSha256: { baseline: baseline.rawSha256, candidate: candidate.rawSha256 },
        inlineDataUrls: { baseline: baseline.inlineDataUrls, candidate: candidate.inlineDataUrls },
        pixels,
        candidateRoutes: candidate.routes ?? null,
      })
    }
    perContext[contextId] = records
  }

  // Self-null: two fresh contexts through the identical sequence must agree on both sides. Without
  // it a flaky engine could manufacture a difference that is really nondeterminism, or hide a real
  // one behind a coincidence.
  const selfNull = { ok: true, mismatches: [] }
  const left = perContext.A ?? []
  const right = perContext.B ?? []
  if (left.length && right.length && left.length === right.length) {
    for (let i = 0; i < left.length; i++) {
      if (left[i].label !== right[i].label) {
        selfNull.ok = false
        selfNull.mismatches.push('step order differs between self-null contexts')
        break
      }
      for (const side of ['baseline', 'candidate']) {
        if (left[i].rawSha256?.[side] !== right[i].rawSha256?.[side]) {
          selfNull.ok = false
          selfNull.mismatches.push(side + ' raw output is not reproducible at ' + left[i].label)
        }
      }
    }
  } else {
    selfNull.ok = false
    selfNull.mismatches.push('self-null contexts did not both produce step evidence')
  }
  if (!selfNull.ok) problems.push(...selfNull.mismatches)

  return {
    engine,
    cell: cellId,
    surface: cell.surface,
    state: problems.length ? 'FIDELITY_FAILURE' : 'FIDELITY_PASS',
    problems,
    selfNull,
    pixelTier,
    expectedInlineDataUrls: expectedInline,
    fixtureByteLength: fixtureBytesForCell,
    fixtureByteLengthsUsed: byteLengths,
    contexts: perContext,
  }
}

/** Decide a whole engine: every cell must pass AND report evidence. */
export function engineVerdict(engine, evidence, options = {}) {
  if (!ENGINES.includes(engine)) {
    return {
      engine,
      state: 'INCOMPLETE_EVIDENCE',
      problems: ['unknown engine ' + engine],
      cellIds: [...CELL_IDS],
      cells: {},
    }
  }
  const cells = {}
  const problems = []
  for (const cellId of CELL_IDS) {
    const verdict = cellVerdict(engine, cellId, evidence, options)
    cells[cellId] = verdict
    if (verdict.state !== 'FIDELITY_PASS') {
      // Every problem is surfaced, not just the first: a gate that reports one cause and hides the
      // rest invites a fix that moves the failure rather than removes it.
      for (const problem of verdict.problems) problems.push(cellId + ': ' + problem)
      if (!verdict.problems.length) problems.push(cellId + ': ' + verdict.state)
    }
  }
  for (const id of Object.keys(evidence?.cells ?? {})) {
    if (!CELL_IDS.includes(id)) problems.push('engine reported unknown cell ' + id)
  }
  return {
    engine,
    state: problems.length ? 'FIDELITY_FAILURE' : 'FIDELITY_PASS',
    problems,
    cellIds: [...CELL_IDS],
    cells,
  }
}

/**
 * Decide the whole gate. Requires all three engines, every cell in each, self-null evidence in each,
 * and provenance that matches the frozen prepare output exactly.
 */
export function acceptanceVerdict({ prepared, engineDocuments }) {
  const problems = []
  const engines = {}

  if (!prepared || prepared.schema !== PREPARED_SCHEMA) {
    problems.push('prepared provenance is missing or has the wrong schema')
  }

  const present = Object.keys(engineDocuments ?? {})
  // The frozen manifest is authoritative for fixture byte lengths: it is what prepare.mjs hashed,
  // so a verdict can never measure a fixture the prepare step did not freeze.
  const byteLengthManifest = prepared?.fixtures
    ? Object.fromEntries(Object.entries(prepared.fixtures).map(([k, v]) => [k, v.bytes]))
    : null
  for (const engine of ENGINES) {
    if (!present.includes(engine)) problems.push('engine ' + engine + ' reported no evidence at all')
  }
  for (const engine of present) {
    if (!ENGINES.includes(engine)) problems.push('unexpected engine evidence ' + engine)
  }

  for (const engine of ENGINES) {
    const doc = engineDocuments?.[engine]
    if (!doc) {
      engines[engine] = {
        engine,
        state: 'INCOMPLETE_EVIDENCE',
        problems: ['missing engine evidence'],
        cellIds: [...CELL_IDS],
        cells: {},
      }
      continue
    }
    if (doc.schema !== RUNNER_SCHEMA) {
      problems.push(engine + ': runner schema mismatch')
      engines[engine] = {
        engine,
        state: 'INCOMPLETE_EVIDENCE',
        problems: ['runner schema mismatch'],
        cellIds: [...CELL_IDS],
        cells: {},
      }
      continue
    }
    if (prepared) {
      const p = doc.provenance ?? {}
      const identity = [
        ['candidateGitSha', prepared.candidateGitSha],
        ['baselineGitSha', prepared.baselineGitSha],
        ['measurementGitSha', prepared.measurementGitSha],
        ['candidateBundleSha256', prepared.candidate?.sha256 ?? null],
        ['baselineBundleSha256', prepared.baseline?.sha256 ?? null],
        ['playwrightVersion', prepared.playwrightVersion],
        ['cellMatrixSha256', prepared.cellMatrixSha256],
      ]
      for (const [key, expected] of identity) {
        if (p[key] !== expected) problems.push(engine + ': provenance ' + key + ' mismatch')
      }
    }
    const verdict = engineVerdict(engine, doc, {
      workerMinPayloadChars: prepared?.mechanism?.workerMinPayloadChars ?? null,
      byteLengthManifest,
    })
    engines[engine] = verdict
    if (verdict.state !== 'FIDELITY_PASS') problems.push(engine + ': ' + verdict.problems[0])
  }

  const state = problems.length === 0
    ? 'FIDELITY_ACCEPTED'
    : (present.length < ENGINES.length ? 'INCOMPLETE_EVIDENCE' : 'FIDELITY_FAILURE')

  return {
    schema: SUMMARY_SCHEMA,
    state,
    engines,
    engineIds: [...ENGINES],
    cellIds: [...CELL_IDS],
    provenance: prepared
      ? {
          measurementGitSha: prepared.measurementGitSha,
          candidateGitSha: prepared.candidateGitSha,
          baselineGitSha: prepared.baselineGitSha,
          candidateBundleSha256: prepared.candidate?.sha256 ?? null,
          baselineBundleSha256: prepared.baseline?.sha256 ?? null,
          cellMatrixSha256: prepared.cellMatrixSha256 ?? null,
        }
      : null,
    problems,
    // Stated in the artifact itself, so no downstream reader can mistake this document for a
    // performance claim.
    performanceClaim: false,
    scope:
      'Cross-engine FIDELITY acceptance for the AS-BLOB mechanism: raw output bytes and rendered ' +
      'pixels of c523ddb vs d391556 on chromium, firefox and webkit. Contains no timing ' +
      'measurement and supports no speed claim on any engine.',
  }
}

/** The matrix a reader needs: one row per cell, one column per engine. */
export function acceptanceMatrix(summary) {
  const cellIds = summary.cellIds ?? CELL_IDS
  const engineIds = summary.engineIds ?? ENGINES
  const rows = {}
  for (const cellId of cellIds) {
    rows[cellId] = {}
    for (const engine of engineIds) {
      rows[cellId][engine] = summary.engines?.[engine]?.cells?.[cellId]?.state ?? 'INCOMPLETE_EVIDENCE'
    }
  }
  return rows
}
