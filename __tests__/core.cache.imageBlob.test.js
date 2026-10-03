import { describe, it, expect, beforeEach } from 'vitest'
import { cache, rememberImageAsset, applyCachePolicy, EvictingMap } from '../src/core/cache.js'

// Browser-free by construction: every assertion here touches src/core/cache.js alone, which has
// no DOM dependency, so the mechanism's memory bound is pinned without a render engine and
// without the Playwright provider the rest of the suite needs.
//
// What is under test: the Blob is retained NEXT TO the data URL under one key, so a repeat
// capture can hand compress's worker the bytes instead of a string (see the module header). The
// pixel-identical argument is snapFetch's — data and blob come from the same resp.blob() — so
// what can regress here is the memory bound and the pairing, not the output.

/** Minimal Blob stand-in: cache.js only reads `.size`. */
function fakeBlob(size) {
  return { size, __blob: true }
}

const bytesIn = (map) => {
  let n = 0
  for (const e of map.values()) n += e.blobBytes || 0
  return n
}

describe('cache.image retains the fetched Blob beside the data URL', () => {
  beforeEach(() => {
    cache.image = new EvictingMap(100)
  })

  it('stores both under one key, so a hit can restore the Blob', () => {
    const blob = fakeBlob(2048)
    rememberImageAsset('https://x.test/a.png', 'data:image/png;base64,AAAA', blob)

    const entry = cache.image.get('https://x.test/a.png')
    expect(entry.data).toBe('data:image/png;base64,AAAA')
    expect(entry.blob).toBe(blob)
    expect(entry.blobBytes).toBe(2048)
  })

  it('an entry with no Blob is still usable, and reports zero retained bytes', () => {
    // What every entry looked like before this change: data URL only.
    rememberImageAsset('https://x.test/b.png', 'data:image/png;base64,BBBB')
    const entry = cache.image.get('https://x.test/b.png')
    expect(entry.data).toBe('data:image/png;base64,BBBB')
    expect(entry.blob).toBeUndefined()
    expect(entry.blobBytes).toBeUndefined()
    expect(bytesIn(cache.image)).toBe(0)
  })

  it('drops the OLDEST blob past the byte budget and keeps its data URL', () => {
    // 64 MiB budget (MAX_IMAGE_BLOB_BYTES). Ten 8 MiB blobs is 80 MiB, so the first two go.
    const MB = 1024 * 1024
    for (let i = 0; i < 10; i++) {
      rememberImageAsset(`https://x.test/${i}.png`, `data:image/png;base64,${i}`, fakeBlob(8 * MB))
    }

    expect(bytesIn(cache.image)).toBeLessThanOrEqual(64 * MB)
    // The data URLs are all still there — the budget costs the saving, never the memo.
    for (let i = 0; i < 10; i++) {
      expect(cache.image.get(`https://x.test/${i}.png`).data).toBe(`data:image/png;base64,${i}`)
    }
    // Oldest first: entries 0 and 1 kept their URL and lost their Blob.
    expect(cache.image.get('https://x.test/0.png').blob).toBeUndefined()
    expect(cache.image.get('https://x.test/1.png').blob).toBeUndefined()
    // Newest kept theirs.
    expect(cache.image.get('https://x.test/9.png').blob).toBeTruthy()
  })

  it('skips entries that already lost their Blob instead of stopping at the first one', () => {
    // The sweep must not break on a blob-less entry sitting at the head of the FIFO, or a single
    // early eviction would freeze the budget forever.
    const MB = 1024 * 1024
    rememberImageAsset('https://x.test/head.png', 'data:image/png;base64,H')
    for (let i = 0; i < 10; i++) {
      rememberImageAsset(`https://x.test/${i}.png`, `data:image/png;base64,${i}`, fakeBlob(8 * MB))
    }
    expect(bytesIn(cache.image)).toBeLessThanOrEqual(64 * MB)
    expect(cache.image.get('https://x.test/9.png').blob).toBeTruthy()
  })

  it('re-storing a key keeps its FIFO position, so a repeat capture cannot pin a payload', () => {
    const MB = 1024 * 1024
    for (let i = 0; i < 9; i++) {
      rememberImageAsset(`https://x.test/${i}.png`, `data:image/png;base64,${i}`, fakeBlob(8 * MB))
    }
    const oldest = 'https://x.test/0.png'
    // Capture 2 of the oldest payload: the key exists, so Map.set leaves its slot alone.
    rememberImageAsset(oldest, 'data:image/png;base64,0', fakeBlob(8 * MB))
    rememberImageAsset('https://x.test/overflow.png', 'data:image/png;base64,OVER', fakeBlob(8 * MB))

    // 10 x 8 MiB is over budget, so the sweep started at 0 — the genuinely oldest entry.
    expect(cache.image.get(oldest).blob).toBeUndefined()
  })

  it('cache: disabled drops the payloads and their Blobs together', () => {
    rememberImageAsset('https://x.test/a.png', 'data:image/png;base64,AAAA', fakeBlob(2048))
    expect(cache.image.size).toBe(1)

    applyCachePolicy('disabled')
    expect(cache.image.size).toBe(0)
    expect(bytesIn(cache.image)).toBe(0)
  })

  it('the entry cap still applies, and entries over it are whole entries', () => {
    cache.image = new EvictingMap(3)
    for (let i = 0; i < 5; i++) {
      rememberImageAsset(`https://x.test/${i}.png`, `data:image/png;base64,${i}`, fakeBlob(16))
    }
    expect(cache.image.size).toBe(3)
    expect(cache.image.has('https://x.test/0.png')).toBe(false)
    expect(cache.image.has('https://x.test/4.png')).toBe(true)
  })
})
