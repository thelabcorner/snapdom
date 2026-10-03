/**
 * AS-BLOB, browser-free. Runs under `node --test` with no Playwright, no DOM and no
 * dependencies: src/core/cache.js has no DOM import, which is the whole reason the retention
 * gate and its byte budget can be certified on a machine that cannot run a browser.
 *
 * Wire-up: `npm run test:asset-proof`, which `npm test` and `npm run test:full` both call
 * BEFORE the vitest browser suite. A regression here therefore fails CI on the runner, not
 * only on a developer machine that happens to have browsers installed.
 *
 * What is under test, and what is not:
 *  - HERE: the retention gate (compress off / worker route closed / small payload all retain
 *    ZERO Blobs), that the byte budget is authoritative so a swept Blob cannot escape onto the
 *    clone through the caller's own reference, FIFO order, and the `cache: 'disabled'` reset.
 *  - NOT here: that the worker route is actually reached, i.e. `result.assets.workerBlob > 0`
 *    on a real capture. That needs a browser and belongs to the hosted matrix in
 *    lane6-scratch/r10/ASSET-BENCH-DESIGN.md.
 *  - NOT here: pixels. The Blob and the data URL are both derived from the same
 *    `resp.blob()` (src/modules/snapFetch.js), so the mechanism cannot change output; the
 *    visual suite is what would catch it if that ever stopped being true.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cache,
  rememberImageAsset,
  applyCachePolicy,
  dropRetainedImageBlobs,
  compressWorkerRouteSupported,
  EvictingMap,
  WORKER_MIN_PAYLOAD_CHARS,
} from '../src/core/cache.js'

const MB = 1024 * 1024
/** cache.js reads only `.size`; a real Blob is not needed and node has no DOM. */
const blob = (size) => ({ size })
const bytesIn = (map) => {
  let n = 0
  for (const e of map.values()) n += e.blobBytes || 0
  return n
}
/** A data URL string long enough to clear the worker threshold. */
const bigData = (tag) => 'data:image/png;base64,' + tag + 'A'.repeat(WORKER_MIN_PAYLOAD_CHARS)
/** ...and one deliberately under it, so the "small image" arm is real and not a comment. */
const smallData = (tag) => 'data:image/png;base64,' + tag + 'A'.repeat(1024)

test.beforeEach(() => {
  cache.image = new EvictingMap(100)
})

test('the worker threshold is the one compress uses, and a small image clears it', () => {
  assert.equal(WORKER_MIN_PAYLOAD_CHARS, 64 * 1024)
  assert.ok(smallData('S').length < WORKER_MIN_PAYLOAD_CHARS)
  assert.ok(bigData('L').length >= WORKER_MIN_PAYLOAD_CHARS)
})

test('a retained payload keeps both the data URL and the Blob under one key', () => {
  const b = blob(2048)
  const kept = rememberImageAsset('https://x.test/a.png', bigData('A'), b, true)
  const entry = cache.image.get('https://x.test/a.png')
  assert.equal(entry.data, bigData('A'))
  assert.equal(entry.blob, b)
  assert.equal(entry.blobBytes, 2048)
  assert.equal(kept, b)
})

test('a small payload retains NO Blob, even when told the worker could take it', () => {
  const kept = rememberImageAsset('https://x.test/small.png', smallData('S'), blob(512), true)
  assert.equal(kept, undefined)
  const entry = cache.image.get('https://x.test/small.png')
  assert.equal(entry.data, smallData('S'))
  assert.equal(entry.blob, undefined)
  assert.equal(bytesIn(cache.image), 0, 'a small image must retain zero blob bytes')
})

test('compress off retains NO Blob', () => {
  assert.equal(rememberImageAsset('https://x.test/nc.png', bigData('N'), blob(4096), false), undefined)
  assert.equal(bytesIn(cache.image), 0)
  assert.ok(cache.image.get('https://x.test/nc.png').data, 'the data URL is still memoized')
})

test('an ineligible caller (worker route closed) retains NO Blob', () => {
  // The caller computes `!!options.compress && compressWorkerRouteOpen()` and passes the
  // result; false must mean "no Blob", not "Blob anyway".
  assert.equal(rememberImageAsset('https://x.test/csp.png', bigData('C'), blob(4096), false), undefined)
  assert.equal(bytesIn(cache.image), 0)
})

test('no Blob at all still memoizes the data URL', () => {
  const kept = rememberImageAsset('https://x.test/nb.png', bigData('B'), undefined, true)
  assert.equal(kept, undefined)
  assert.equal(cache.image.get('https://x.test/nb.png').data, bigData('B'))
})

test('the byte budget is authoritative: a swept Blob comes back undefined', () => {
  // One Blob alone over the whole budget. It is both the oldest and the newest entry, so the
  // sweep has to drop it — and the RETURN must say so.
  const huge = blob(65 * MB)
  const kept = rememberImageAsset('https://x.test/huge.png', bigData('H'), huge, true)
  assert.equal(kept, undefined, 'the caller must not be handed a Blob the budget dropped')
  assert.equal(bytesIn(cache.image), 0)
  assert.ok(cache.image.get('https://x.test/huge.png').data, 'the data URL survives regardless')
})

test('a just-added over-budget Blob cannot escape onto the clone', () => {
  // The exact shape the red team named: fill the budget with eligible Blobs, then add one that
  // pushes past it. The added Blob is the NEWEST, so a correct sweep drops older entries first;
  // if the budget cannot be met that way, the added Blob itself must be the one reported gone.
  for (let i = 0; i < 8; i++) rememberImageAsset(`https://x.test/${i}.png`, bigData(String(i)), blob(8 * MB), true)
  const added = blob(64 * MB)
  const kept = rememberImageAsset('https://x.test/added.png', bigData('Z'), added, true)

  assert.ok(bytesIn(cache.image) <= 64 * MB, `retained ${bytesIn(cache.image)} bytes`)
  if (kept !== undefined) {
    assert.equal(kept, added)
    assert.ok(cache.image.get('https://x.test/added.png').blob === added)
  } else {
    assert.equal(cache.image.get('https://x.test/added.png').blob, undefined,
      'reported gone AND stored gone — the two can never disagree')
  }
})

test('the sweep is oldest first and keeps every data URL', () => {
  for (let i = 0; i < 10; i++) rememberImageAsset(`https://x.test/${i}.png`, bigData(String(i)), blob(8 * MB), true)
  assert.ok(bytesIn(cache.image) <= 64 * MB)
  for (let i = 0; i < 10; i++) {
    assert.equal(cache.image.get(`https://x.test/${i}.png`).data, bigData(String(i)))
  }
  assert.equal(cache.image.get('https://x.test/0.png').blob, undefined)
  assert.equal(cache.image.get('https://x.test/1.png').blob, undefined)
  assert.ok(cache.image.get('https://x.test/9.png').blob)
})

test('the sweep skips entries that already lost their Blob', () => {
  // Without this the sweep would stop at the first blob-less entry at the head of the FIFO and
  // the budget would freeze forever after a single eviction.
  rememberImageAsset('https://x.test/small-head.png', smallData('H'))
  for (let i = 0; i < 10; i++) rememberImageAsset(`https://x.test/${i}.png`, bigData(String(i)), blob(8 * MB), true)
  assert.ok(bytesIn(cache.image) <= 64 * MB, `retained ${bytesIn(cache.image)} bytes`)
  assert.ok(cache.image.get('https://x.test/9.png').blob, 'the newest entry kept its Blob')
})

test('re-storing a key keeps its FIFO position, so a repeat capture cannot pin a payload', () => {
  for (let i = 0; i < 9; i++) rememberImageAsset(`https://x.test/${i}.png`, bigData(String(i)), blob(8 * MB), true)
  rememberImageAsset('https://x.test/0.png', bigData('0'), blob(8 * MB), true)
  rememberImageAsset('https://x.test/overflow.png', bigData('O'), blob(8 * MB), true)
  assert.equal(cache.image.get('https://x.test/0.png').blob, undefined,
    'the genuinely oldest entry was swept')
})

test("cache: 'disabled' drops payloads and Blobs together", () => {
  rememberImageAsset('https://x.test/a.png', bigData('A'), blob(2048), true)
  assert.equal(cache.image.size, 1)
  applyCachePolicy('disabled')
  assert.equal(cache.image.size, 0)
  assert.equal(bytesIn(cache.image), 0)
})

test('the entry cap still evicts whole entries', () => {
  cache.image = new EvictingMap(3)
  for (let i = 0; i < 5; i++) rememberImageAsset(`https://x.test/${i}.png`, bigData(String(i)), blob(16), true)
  assert.equal(cache.image.size, 3)
  assert.equal(cache.image.has('https://x.test/0.png'), false)
  assert.equal(cache.image.has('https://x.test/4.png'), true)
})

test('a mixed page retains Blobs for the large rasters and none for the small ones', () => {
  // The shape a real page has: a hero or gallery photo over the threshold, icons under it.
  const large = [0, 1, 2].map((i) => rememberImageAsset(`https://x.test/big${i}.png`, bigData(String(i)), blob(4 * MB), true))
  const small = [0, 1, 2].map((i) => rememberImageAsset(`https://x.test/ico${i}.png`, smallData(String(i)), blob(2048), true))
  assert.ok(large.every(Boolean), 'all three large payloads retained their Blob')
  assert.ok(small.every((k) => k === undefined), 'no small payload retained a Blob')
  assert.equal(bytesIn(cache.image), 12 * MB, 'only the large payloads are counted')
})

// ---- The worker-route capability seam ----
// compressWorkerRouteOpen() lives in compress.js, which node cannot import (utils/css.js uses
// extensionless specifiers). Its dependency-free half is therefore a cache.js export, and THAT
// is what these pin: the gate must answer from capability, with no construction, so a page with
// no Worker or no OffscreenCanvas retains nothing from its first capture. compressWorkerRouteOpen
// is exactly `compressWorkerRouteSupported() && _workers !== false` — the CSP half, which needs
// a real construction, is the part no browser-free test can reach and is left to the hosted arm.

test('the worker route is unsupported in node, where neither Worker nor OffscreenCanvas exists', () => {
  assert.equal(typeof Worker, 'undefined')
  assert.equal(typeof OffscreenCanvas, 'undefined')
  assert.equal(compressWorkerRouteSupported(), false)
})

test('the capability check reports supported only when BOTH globals exist', () => {
  const hadWorker = 'Worker' in globalThis
  const hadOsc = 'OffscreenCanvas' in globalThis
  try {
    globalThis.Worker = function Worker() {}
    assert.equal(compressWorkerRouteSupported(), false, 'OffscreenCanvas alone is not enough')
    globalThis.OffscreenCanvas = function OffscreenCanvas() {}
    assert.equal(compressWorkerRouteSupported(), true)
    delete globalThis.OffscreenCanvas
    assert.equal(compressWorkerRouteSupported(), false, 'Worker alone is not enough')
  } finally {
    if (!hadWorker) delete globalThis.Worker
    if (!hadOsc) delete globalThis.OffscreenCanvas
  }
})

test('an unsupported route means no Blob is retained, from the first capture onward', () => {
  // The end-to-end shape of the gate, in the order images.js evaluates it: the capability check
  // is `workerEligible`, and false must mean no Blob at any payload size.
  assert.equal(compressWorkerRouteSupported(), false)
  const kept = rememberImageAsset('https://x.test/first.png', bigData('F'), blob(8 * MB), compressWorkerRouteSupported())
  assert.equal(kept, undefined)
  assert.equal(bytesIn(cache.image), 0)
})

// ---- The purge seam ----
// disableWorkers() calls this the moment the worker route closes for good, because a CSP that
// forbids blob workers fails at CONSTRUCTION — which can be the first capture, right after the
// Blobs were retained. Without the purge they sit in the blob store for the page's lifetime.

test('dropRetainedImageBlobs purges every sidecar and reports what it released', () => {
  for (let i = 0; i < 3; i++) rememberImageAsset(`https://x.test/${i}.png`, bigData(String(i)), blob(4 * MB), true)
  rememberImageAsset('https://x.test/ico.png', smallData('I'))
  assert.equal(bytesIn(cache.image), 12 * MB)

  const freed = dropRetainedImageBlobs()
  assert.equal(freed.entries, 3)
  assert.equal(freed.bytes, 12 * MB, 'the purge reports the bytes it released, for the RSS arm')
  assert.equal(bytesIn(cache.image), 0)
  for (let i = 0; i < 3; i++) {
    assert.equal(cache.image.get(`https://x.test/${i}.png`).blob, undefined)
    assert.equal(cache.image.get(`https://x.test/${i}.png`).blobBytes, 0,
      'the sidecar is cleared, not merely unreferenced — 0 is the byte sweep\'s own convention')
  }
})

test('the purge keeps every data URL, so the memo still does its job', () => {
  rememberImageAsset('https://x.test/a.png', bigData('A'), blob(4 * MB), true)
  dropRetainedImageBlobs()
  assert.equal(cache.image.size, 1)
  assert.equal(cache.image.get('https://x.test/a.png').data, bigData('A'))
})

test('the purge is idempotent and safe on an empty cache', () => {
  assert.deepEqual(dropRetainedImageBlobs(), { entries: 0, bytes: 0 })
  rememberImageAsset('https://x.test/a.png', bigData('A'), blob(4 * MB), true)
  assert.deepEqual(dropRetainedImageBlobs(), { entries: 1, bytes: 4 * MB })
  assert.deepEqual(dropRetainedImageBlobs(), { entries: 0, bytes: 0 }, 'a second purge has nothing left to do')
})

test("the purge does not resurrect retention under 'disabled'", () => {
  rememberImageAsset('https://x.test/a.png', bigData('A'), blob(4 * MB), true)
  applyCachePolicy('disabled')
  assert.deepEqual(dropRetainedImageBlobs(), { entries: 0, bytes: 0 })
  assert.equal(bytesIn(cache.image), 0)
})

// ---- Blob.size must be countable ----
// The budget is arithmetic over blobBytes. A single NaN or Infinity makes every later
// `bytes <= MAX` comparison false, so the sweep would never break and would strip EVERY retained
// Blob. One poisoned size must therefore be refused at the door, not counted.

test('a Blob whose size is not a finite nonnegative number is NOT retained', () => {
  for (const [label, size] of [['NaN', NaN], ['Infinity', Infinity], ['negative', -1], ['non-number', '1024']]) {
    cache.image = new EvictingMap(100)
    const kept = rememberImageAsset('https://x.test/bad.png', bigData('X'), { size }, true)
    assert.equal(kept, undefined, `${label} size must not retain`)
    assert.equal(bytesIn(cache.image), 0, `${label} size must not be counted`)
    assert.ok(cache.image.get('https://x.test/bad.png').data, 'the data URL still memoizes')
  }
})

test('a zero-byte Blob is countable, retained, and never swept', () => {
  const kept = rememberImageAsset('https://x.test/zero.png', bigData('Z'), blob(0), true)
  assert.equal(bytesIn(cache.image), 0, 'zero bytes is a legitimate measurement, not a missing one')
  assert.equal(kept, cache.image.get('https://x.test/zero.png').blob)
  // The sweep skips it, because `!e.blobBytes` is true for 0. That is deliberate and harmless:
  // the sidecar references no bytes, so there is nothing for the budget to reclaim.
  assert.equal(dropRetainedImageBlobs().entries, 0)
  assert.ok(cache.image.get('https://x.test/zero.png').blob)
})

test('one uncountable Blob cannot strip the retention of every other entry', () => {
  // The failure this guards: NaN poisons the running total, the sweep never breaks, and it ends
  // up clearing the whole cache. The poisoned Blob never gets in, so the total stays finite.
  for (let i = 0; i < 3; i++) rememberImageAsset(`https://x.test/ok${i}.png`, bigData(String(i)), blob(4 * MB), true)
  rememberImageAsset('https://x.test/bad.png', bigData('X'), { size: NaN }, true)
  assert.equal(bytesIn(cache.image), 12 * MB)
  for (let i = 0; i < 3; i++) assert.ok(cache.image.get(`https://x.test/ok${i}.png`).blob)
})