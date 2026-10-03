/**
 * AS-SPLIT: browser-free static proof that the assembled @font-face CSS memo and the font
 * payload memo evict each other inside the single FIFO in `cache.resource`.
 *
 * Replays the exact write order src/modules/fonts.js uses (payloads first, then the
 * assembled CSS under a key that varies with the captured codepoints) against the real
 * EvictingMap. No browser, no deps, no timing: the claim is about eviction ORDER, which is
 * observable without a clock.
 *
 * Run: node scripts/as-split-eviction-proof.mjs
 * Pinned by __tests__/core.cache.fontCssKeyspace.test.js, which asserts the same counts
 * against the real cache rather than a copy of it.
 */
import { cache, EvictingMap } from '../src/core/cache.js'

const MAX = cache.resource._maxSize

/** Captures to run. The FIFO only bites once the two key spaces together exceed the cap. */
const CAPTURES = 400
/** A further window, to read the post-cliff steady state. */
const WINDOW = 200
/** Print only the captures that actually refetched, plus the first two. */
const QUIET = true

/** A page with F font faces and B blob: URLs. */
const F = 6
const B = 2
/** The cap the candidate gives the assembled-CSS memo. */
const CAPTURE_CSS_MAX = 8
const payloads = Array.from({ length: F }, (_, i) => `https://cdn.example.com/f${i}.woff2`)
const blobs = Array.from({ length: B }, (_, i) => `blob:https://site/${i}`)

/**
 * One capture as fonts.js writes it: every payload not already in the map is fetched and
 * stored (fonts.js:478, :1119, :1155), then the assembled CSS is memoized (fonts.js:1171)
 * under a key carrying the used-codepoint digest, so captures over different text get
 * distinct keys.
 * @param {{resource: Map, fontCss: Map}} store
 * @param {number} n capture index, standing in for the codepoint digest
 * @returns {{payloadFetches: number}}
 */
function capture(store, n) {
  let payloadFetches = 0
  for (const p of payloads) {
    if (!store.resource.has(p)) { store.resource.set(p, 'data:font/woff2;base64,PAYLOAD'); payloadFetches++ }
  }
  for (const b of blobs) {
    if (!store.resource.has(b)) { store.resource.set(b, 'data:image/png;base64,PNG') }
  }
  const key = `fonts-embed-css::req=Roboto__400__normal__100::cp=${n}::env=0`
  store.fontCss.set(key, '@font-face{font-family:"Roboto";src:url(data:font/woff2;base64,PAYLOAD)}')
  return { payloadFetches }
}

const shared = { resource: cache.resource, fontCss: cache.resource }
const split = { resource: new EvictingMap(MAX), fontCss: new EvictingMap(CAPTURE_CSS_MAX) }

/** @param {{resource: Map, fontCss: Map}} store @param {number} captures */
function run(store, captures) {
  let payloadFetches = 0
  const trace = []
  for (let n = 1; n <= captures; n++) {
    const r = capture(store, n)
    payloadFetches += r.payloadFetches
    trace.push({
      capture: n,
      live: payloads.filter(p => store.resource.has(p)).length,
      refetched: r.payloadFetches,
    })
  }
  return { payloadFetches, trace, live: payloads.filter(p => store.resource.has(p)).length }
}

console.log(`cache.resource cap = ${MAX}   captures = ${CAPTURES}`)
console.log(`workload: ${F} font faces, ${B} blob URLs, ${CAPTURES} captures of different text\n`)

const a = run(shared, CAPTURES)
const b = run(split, CAPTURES)

for (const [label, res] of [['shared FIFO (today)', a], ['split (candidate)', b]]) {
  console.log(label)
  console.log('  capture  payloadsLive  payloadsRefetched')
  for (const t of res.trace) {
    if (!QUIET || t.refetched > 0 || t.capture <= 2) {
      console.log(`  ${String(t.capture).padStart(7)}  ${String(t.live).padStart(12)}  ${String(t.refetched).padStart(17)}`)
    }
  }
  console.log(`  total payload network fetches: ${res.payloadFetches}`)
  console.log(`  captures that refetched >=1 payload: ${res.trace.filter(t => t.refetched > 0).length}/${CAPTURES}\n`)
}

console.log(`payloads still memoized after ${CAPTURES} captures: shared=${a.live}/${F}  split=${b.live}/${F}`)
console.log(`payload fetches removed by the split: ${a.payloadFetches - b.payloadFetches}`)

// Steady state over a further window, well past the cliff.
const steady = run(shared, WINDOW)
const steadySplit = run(split, WINDOW)
console.log(`\nsteady state over the next ${WINDOW} captures: shared=${steady.payloadFetches} payload fetches, split=${steadySplit.payloadFetches}`)