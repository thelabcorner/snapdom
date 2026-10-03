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
// Retained Blob bytes across cache.image. A Blob is not a JS-heap copy of its payload, but 100
// multi-megabyte rasters still pin hundreds of MB in the browser's blob store, so past this the
// oldest blob is dropped and its data URL kept — which is what every entry had before the Blob
// was retained alongside it. Counted, not estimated: Blob.size is exact and free.
const MAX_IMAGE_BLOB_BYTES = 64 * 1024 * 1024
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
 *                    URL and, when the fetch had one, the Blob carrying the same bytes
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
 * Memoize one inlined raster: the data URL written onto the clone, plus the Blob holding the
 * same bytes when the fetch still had one.
 *
 * compress's worker path takes a Blob so the base64 string never crosses postMessage and is
 * never decoded again (140 ms for 26 MB of gallery photos, snapFetch.js). Only the fetch that
 * first saw a payload has a Blob to give, so every later capture read this memo, got a bare
 * string, and re-created the clone with no `__snapdomBlob` — the worker then structured-cloned
 * the whole payload in and re-decoded it. The Blob and the data URL are both derived from the
 * same `resp.blob()` (snapFetch.js), so handing the worker one instead of the other cannot
 * change a pixel; it only changes who pays the copy.
 *
 * Blobs are held under a byte budget, oldest first. Dropping one leaves its data URL in place,
 * which is exactly the behaviour every entry had before it retained a Blob, so the budget can
 * only cost the saving, never correctness.
 *
 * Re-storing an existing key keeps its FIFO position (Map semantics), so a repeat capture does
 * not make its own payload look newer than it is.
 * Pinned by __tests__/core.cache.imageBlob.test.js.
 *
 * @param {string} key - resolved source URL
 * @param {string} data - the data URL the clone will carry
 * @param {Blob} [blob] - the same bytes, when the fetch still had one
 */
export function rememberImageAsset(key, data, blob) {
  const entry = blob ? { data, blob, blobBytes: blob.size } : { data }
  cache.image.set(key, entry)
  if (!blob) return
  let bytes = 0
  for (const e of cache.image.values()) bytes += e.blobBytes || 0
  if (bytes <= MAX_IMAGE_BLOB_BYTES) return
  for (const e of cache.image.values()) {
    if (bytes <= MAX_IMAGE_BLOB_BYTES) break
    if (!e.blobBytes) continue
    bytes -= e.blobBytes
    e.blob = undefined
    e.blobBytes = 0
  }
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
  cache.background    = new EvictingMap(MAX_BACKGROUND)
  cache.resource      = new EvictingMap(MAX_RESOURCE)
  cache.compress      = new EvictingMap(MAX_COMPRESS)
}
