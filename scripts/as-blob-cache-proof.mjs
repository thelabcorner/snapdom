/**
 * AS-BLOB: browser-free proof of the cache.image Blob retention mechanism.
 *
 * Runs the assertions from __tests__/core.cache.imageBlob.test.js in plain node, so the
 * mechanism's memory bound can be checked on a machine with no browser and no Playwright
 * provider. src/core/cache.js has no DOM dependency, which is what makes that possible.
 *
 * Run: node scripts/as-blob-cache-proof.mjs
 * Exits non-zero on the first failed assertion.
 */
import assert from 'node:assert/strict'
import { cache, rememberImageAsset, applyCachePolicy, EvictingMap } from '../src/core/cache.js'

let checks = 0
function check(name, fn) {
  fn()
  checks++
  console.log(`  ok  ${name}`)
}

const MB = 1024 * 1024
const blob = (size) => ({ size })
const bytesIn = (map) => {
  let n = 0
  for (const e of map.values()) n += e.blobBytes || 0
  return n
}

console.log('cache.image retains the fetched Blob beside the data URL')

check('both land under one key', () => {
  cache.image = new EvictingMap(100)
  rememberImageAsset('https://x.test/a.png', 'data:image/png;base64,AAAA', blob(2048))
  const e = cache.image.get('https://x.test/a.png')
  assert.equal(e.data, 'data:image/png;base64,AAAA')
  assert.equal(e.blobBytes, 2048)
  assert.ok(e.blob)
})

check('an entry with no Blob reports zero retained bytes', () => {
  cache.image = new EvictingMap(100)
  rememberImageAsset('https://x.test/b.png', 'data:image/png;base64,BBBB')
  const e = cache.image.get('https://x.test/b.png')
  assert.equal(e.blob, undefined)
  assert.equal(e.blobBytes, undefined)
  assert.equal(bytesIn(cache.image), 0)
})

check('the byte budget holds after 80 MiB of blobs', () => {
  cache.image = new EvictingMap(100)
  for (let i = 0; i < 10; i++) rememberImageAsset(`https://x.test/${i}.png`, `d${i}`, blob(8 * MB))
  assert.ok(bytesIn(cache.image) <= 64 * MB, `retained ${bytesIn(cache.image)} bytes`)
})

check('the budget costs blobs, never data URLs', () => {
  cache.image = new EvictingMap(100)
  for (let i = 0; i < 10; i++) rememberImageAsset(`https://x.test/${i}.png`, `d${i}`, blob(8 * MB))
  for (let i = 0; i < 10; i++) assert.equal(cache.image.get(`https://x.test/${i}.png`).data, `d${i}`)
})

check('eviction is oldest first', () => {
  cache.image = new EvictingMap(100)
  for (let i = 0; i < 10; i++) rememberImageAsset(`https://x.test/${i}.png`, `d${i}`, blob(8 * MB))
  assert.equal(cache.image.get('https://x.test/0.png').blob, undefined)
  assert.equal(cache.image.get('https://x.test/1.png').blob, undefined)
  assert.ok(cache.image.get('https://x.test/9.png').blob)
})

check('the sweep skips entries that already lost their Blob', () => {
  cache.image = new EvictingMap(100)
  rememberImageAsset('https://x.test/head.png', 'H') // blob-less, sits at the FIFO head
  for (let i = 0; i < 10; i++) rememberImageAsset(`https://x.test/${i}.png`, `d${i}`, blob(8 * MB))
  assert.ok(bytesIn(cache.image) <= 64 * MB, `retained ${bytesIn(cache.image)} bytes`)
  assert.ok(cache.image.get('https://x.test/9.png').blob, 'the newest entry kept its Blob')
})

check('re-storing a key keeps its FIFO position', () => {
  cache.image = new EvictingMap(100)
  for (let i = 0; i < 9; i++) rememberImageAsset(`https://x.test/${i}.png`, `d${i}`, blob(8 * MB))
  rememberImageAsset('https://x.test/0.png', 'd0', blob(8 * MB))
  rememberImageAsset('https://x.test/overflow.png', 'dOVER', blob(8 * MB))
  assert.equal(cache.image.get('https://x.test/0.png').blob, undefined,
    'the genuinely oldest entry was swept, so a repeat capture cannot pin a payload')
})

check("cache: 'disabled' drops payloads and Blobs together", () => {
  cache.image = new EvictingMap(100)
  rememberImageAsset('https://x.test/a.png', 'dA', blob(2048))
  assert.equal(cache.image.size, 1)
  applyCachePolicy('disabled')
  assert.equal(cache.image.size, 0)
  assert.equal(bytesIn(cache.image), 0)
})

check('the entry cap still evicts whole entries', () => {
  cache.image = new EvictingMap(3)
  for (let i = 0; i < 5; i++) rememberImageAsset(`https://x.test/${i}.png`, `d${i}`, blob(16))
  assert.equal(cache.image.size, 3)
  assert.equal(cache.image.has('https://x.test/0.png'), false)
  assert.equal(cache.image.has('https://x.test/4.png'), true)
})

console.log(`\n${checks} checks passed`)