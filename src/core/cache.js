/**
 * Cross-capture asset caches and shared style defaults.
 *
 * Everything scoped to one capture lives on the session (session.js). What lives here is
 * reused across captures on purpose: fetched assets, per-tag defaults, the clone-in-document
 * measurement, the compress output. Each Map is capped and evicts FIFO, so a long-lived SPA
 * cannot grow them without bound. `cache: 'disabled'` replaces every one of them before a
 * capture. Pinned by __tests__/core.cache.test.js.
 * @module cache
 */

/** Max entries before evicting oldest (FIFO). Keeps lib lightweight, avoids memory leaks. */
const MAX_IMAGE = 100
const MAX_SVG_IMAGE = 50
// A second bounded memo cannot be allowed to evict HTML image Blob sidecars.
// Count UTF-16 worst-case units rather than assuming V8's compact ASCII strings.
export const MAX_SVG_IMAGE_MEMO_CHARS = 4 * 1024 * 1024
// A HYPOTHESIS, not a certified policy: no measurement supports this number yet, and the only
// honest description of it is "a guess that bounds obvious abuse". The hosted assets benchmark
// (lane6-scratch/r10) records settled RSS against it so the value can be LOWERED or frozen from
// evidence; it must not be defended as correct. Blobs are not JS-heap objects, so page-visible
// heap counters under-report what retention actually costs — see that harness's §5.
export const MAX_IMAGE_BLOB_BYTES = 64 * 1024 * 1024
// compress's worker-offload threshold, in base64 characters of the data URL. It lives HERE,
// not in compress.js, because compress.js imports the cache: defining it there would mean
// either an import cycle or a second copy of the number, and two copies of a threshold is how
// a payload ends up retained as a Blob at 64 KB and then never reaches the worker that would
// have paid for the retention. cache.js is the dependency-free layer both sides already import.
export const WORKER_MIN_PAYLOAD_CHARS = 64 * 1024
const MAX_BACKGROUND = 100
const MAX_RESOURCE = 150
const MAX_BASE_STYLE = 50
// Keyed by tag name. Above the ~31 distinct tags a page commonly uses on purpose: at 30 the
// cache evicted 'div', the most common tag on any page, while the first capture was still
// filling it, and every capture then re-measured div defaults from a live sandbox.
// Headroom above 31 covers the tags a real document uses beyond that list.
const MAX_DEFAULT_STYLE = 64
const MAX_COMPRESS = 50

/**
 * Map that evicts oldest entries when exceeding maxSize. FIFO order.
 * @extends Map
 */
class EvictingMap extends Map {
  constructor(maxSize = 100, ...args) {
    super(...args)
    this._maxSize = maxSize
  }
  set(key, value) {
    if (this.size >= this._maxSize && !this.has(key)) {
      const first = this.keys().next().value
      if (first !== undefined) this.delete(first)
    }
    return super.set(key, value)
  }
}

/**
 * The global caches. Who writes each one:
 *  - image ........ <img> payloads by source URL (images.js, via rememberImageAsset): the data
 *                    URL and, only when the worker route could pay for it, the Blob carrying
 *                    the same bytes (see rememberImageAsset for the gate)
 *  - svgImage ..... SVG <image> success URLs only; isolated from HTML/proxy cache provenance
 *  - background ... background-image data URLs by URL (utils/image.js)
 *  - resource ..... blob: URL contents (clone.helpers resolveBlobUrl; fonts.js reads it)
 *  - defaultStyle . per-tag UA defaults from the sandbox (utils/css.js)
 *  - baseStyle .... the base reset CSS per tag set (capture.helpers)
 *  - compress ..... downsampled images (compress.js), see below
 *  - computedStyle  getStyle's memo, one CSSStyleDeclaration per element (utils/css.js)
 *  - measureHints . the clone-in-document measurement (engines/svg.js), see below
 */
export const cache = {
  image: new EvictingMap(MAX_IMAGE),
  svgImage: new EvictingMap(MAX_SVG_IMAGE),
  background: new EvictingMap(MAX_BACKGROUND),
  resource: new EvictingMap(MAX_RESOURCE),
  defaultStyle: new EvictingMap(MAX_DEFAULT_STYLE),
  baseStyle: new EvictingMap(MAX_BASE_STYLE),
  /** {source, result} records keyed by a sampled lookup hint + target size. compress.js
   *  verifies exact source equality and also bounds the retained source/result bytes. */
  compress: new EvictingMap(MAX_COMPRESS),
  computedStyle: new WeakMap(),
  /** Persistent cache for clone-in-document layout measurements (PERF-3).
   *  Key: Element. Value: { cssLen, w0, csh, csw } — cssLen is the total injected CSS
   *  length, used together with w0 as a cheap invalidation key when styles change. */
  measureHints: new WeakMap(),
  /** Fires the reconcile suggestion at most once per page load (see capture.js). */
  warnedReconcile: false,
}

export { EvictingMap }

/** Store only safely bounded SVG data URLs without competing with HTML image Blob entries.
 * Underlying fetch successes are identity-sensitive: only call for absolute, no-proxy URLs.
 * Cache-disabled captures must not call this helper at all.
 * @returns {boolean} whether the entry survived the memory budget
 */
export function rememberSvgImageAsset(url, data) {
  if (typeof data !== 'string' || !data.startsWith('data:') ||
      data.length > MAX_SVG_IMAGE_MEMO_CHARS) return false
  const svgMemo = cache.svgImage
  // Evict oldest first, including at the entry limit. Keep simple O(50) accounting:
  // a tiny bounded walk avoids maintaining a mutable byte counter during resets/deletes.
  svgMemo.set(url, data)
  let chars = 0
  for (const value of svgMemo.values()) chars += value.length
  while (chars > MAX_SVG_IMAGE_MEMO_CHARS) {
    const oldest = svgMemo.keys().next().value
    if (oldest === undefined) break
    chars -= svgMemo.get(oldest).length
    svgMemo.delete(oldest)
  }
  return svgMemo.has(url)
}

/**
 * Normalizes cache values: `false`/'disabled' opt out of every cache (debug/test escape
 * hatch); everything else — including the legacy 'soft'/'auto'/'full' strings — maps to
 * the one structural behavior. The old per-policy session sharing is superseded: sessions
 * are per-capture by construction (createCaptureSession), repeat-capture speed comes from
 * auto-burst + differential recapture WITH real invalidation, and 'full' would re-share
 * session maps across captures — the exact mutable-state class the session refactor
 * eliminated.
 * @param {unknown} v
 * @returns {"soft"|"disabled"}
 */
export function normalizeCachePolicy(v) {
  if (v === false) return 'disabled'
  if (typeof v === 'string' && v.toLowerCase().trim() === 'disabled') return 'disabled'
  return 'soft'
}

/**
 * Memoize one inlined raster and RETURN the Blob that survived retention, or undefined.
 *
 * compress's worker path takes a Blob so the base64 string never crosses postMessage and is
 * never decoded again (140 ms for 26 MB of gallery photos, snapFetch.js). Only the fetch that
 * first saw a payload has a Blob to give, so every later capture read this memo, got a bare
 * string, and re-created the clone with no `__snapdomBlob` — the worker then structured-cloned
 * the whole payload in and re-decoded it. The Blob and the data URL are both derived from the
 * same `resp.blob()` (snapFetch.js), so handing the worker one instead of the other cannot
 * change a pixel; it only changes who pays the copy.
 *
 * Retention is gated on the Blob being ABLE TO PAY, because retaining one that never will is
 * pure memory cost. Three ways a payload never reaches compress's worker: compress is off, the
 * worker route is closed for the page (no Worker/OffscreenCanvas, or a CSP), or the payload is
 * under WORKER_MIN_PAYLOAD_CHARS and takes the main thread by design. The last is checked here so
 * the threshold has exactly one definition in the codebase; the first two are inputs the caller
 * owns and passes as `workerEligible`. A small image therefore retains NO Blob at all.
 *
 * The budget is AUTHORITATIVE: the byte sweep runs before the return, and the value handed back
 * is re-read from the stored entry. A Blob the sweep dropped comes back undefined, so it cannot
 * reach the clone by a side channel — an over-budget Blob added last used to be swept and then
 * attached anyway, because the caller held its own reference from the fetch.
 *
 * Dropping a Blob leaves its data URL in place, which is exactly what every entry had before
 * any Blob was retained, so the budget can only cost the saving, never correctness. Re-storing
 * an existing key keeps its FIFO position (Map semantics), so a repeat capture cannot make its
 * own payload look newer than it is.
 * Pinned by scripts/as-blob.node.test.mjs, which runs under `node --test`
 * (`npm run test:asset-proof`) and needs no browser: this module has no DOM import, and the
 * vitest suite cannot reach it without the Playwright provider.
 *
* @param {string} key - resolved source URL
 * @param {string} data - the data URL the clone will carry
 * @param {Blob} [blob] - the same bytes, when the fetch still had them
 * @param {boolean} [workerEligible=false] - compress is on AND the worker route is open
 * @returns {Blob|undefined} the retained Blob, or undefined when none was kept
 */
export function rememberImageAsset(key, data, blob, workerEligible = false) {
  // `blob.size` must be countable, because the whole budget is arithmetic over it. A size that
  // is NaN or Infinity poisons the running total: every later `bytes <= MAX` comparison is
  // false, so the sweep would never break and would strip EVERY retained Blob. Fail closed on
  // the saving instead — an uncountable Blob is unbounded memory, so it is not retained.
  const size = blob?.size
  const countable = typeof size === 'number' && Number.isFinite(size) && size >= 0
  const retain = !!blob && countable && !!workerEligible && data.length >= WORKER_MIN_PAYLOAD_CHARS
  cache.image.set(key, retain ? { data, blob, blobBytes: size } : { data })
  if (!retain) return undefined
  let bytes = 0
  for (const e of cache.image.values()) bytes += e.blobBytes || 0
  if (bytes > MAX_IMAGE_BLOB_BYTES) {
    for (const e of cache.image.values()) {
      if (bytes <= MAX_IMAGE_BLOB_BYTES) break
      if (!e.blobBytes) continue
      bytes -= e.blobBytes
      e.blob = undefined
      e.blobBytes = 0
    }
  }
  // Re-read: this is the entry as the budget left it, not as the caller handed it over.
  return cache.image.get(key)?.blob
}

/**
 * Whether the compress worker route can exist on this platform, with no side effects.
 *
 * Deliberately the half of `compressWorkerRouteOpen` that cache.js can ask. compress.js imports
 * this module, so the answer cannot live there; and this half is the one the retention gate
 * needs on the FIRST capture, before any worker has been spawned. No Worker or no
 * OffscreenCanvas closes the route for good, and a capability check answers that without
 * allocating anything.
 *
 * A CSP that forbids workers is NOT visible here — it only shows up when a construction is
 * attempted. `true` therefore means "worth trying", never "will work".
 * @returns {boolean}
 */
export function compressWorkerRouteSupported() {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

/**
 * Purge every retained Blob sidecar from cache.image, leaving the data URLs in place.
 *
 * compress calls this the moment the worker route is closed for good. A CSP failure can surface
 * on the FIRST capture — immediately after those Blobs were retained — and nothing else would
 * ever reach them again, so they would sit in the browser's blob store for the page's lifetime.
 * Waiting for the next byte-budget sweep is not good enough: that may be never.
 *
* The data URLs are untouched, so the memo keeps doing the one job it was built for.
 * @returns {{entries: number, bytes: number}} how many entries lost their Blob, and how many
 *   retained bytes that released — the number the hosted RSS arm is checked against
 */
export function dropRetainedImageBlobs() {
  let entries = 0
  let bytes = 0
  for (const e of cache.image.values()) {
    if (!e.blobBytes) continue
    bytes += e.blobBytes
    e.blob = undefined
    e.blobBytes = 0
    entries++
  }
  return { entries, bytes }
}

/**
 * Empties every persistent cache when the policy is 'disabled'. A no-op otherwise.
 * Called once per capture from createCaptureSession, in the same synchronous tick.
 * @param {"soft"|"disabled"} [policy='soft']
 */
export function applyCachePolicy(policy = 'soft') {
  if (policy !== 'disabled') return

  // 'disabled': also drop every persistent cache so nothing is reused across captures.
  cache.computedStyle = new WeakMap()
  cache.measureHints  = new WeakMap()
  cache.baseStyle     = new EvictingMap(MAX_BASE_STYLE)
  cache.defaultStyle  = new EvictingMap(MAX_DEFAULT_STYLE)
  cache.image         = new EvictingMap(MAX_IMAGE)
  cache.svgImage      = new EvictingMap(MAX_SVG_IMAGE)
  cache.background    = new EvictingMap(MAX_BACKGROUND)
  cache.resource      = new EvictingMap(MAX_RESOURCE)
  cache.compress      = new EvictingMap(MAX_COMPRESS)
}
