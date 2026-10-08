/** R12 worker bitmap lifetime and identity proof — pure Node VM, NO browser or timing. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../src/modules/compress.js', import.meta.url), 'utf8')
const WORKER = SOURCE.match(/const WORKER_SRC = `([\s\S]*?)`/)
assert.ok(WORKER, 'the real production worker script must remain extractable')

function simulatedWorker({ bitmapWidth = 1200, bitmapHeight = 800 } = {}) {
  const events = new Map()
  const observed = { decodes: [], closes: [], draws: [], returns: [] }
  const self = {
    postMessage(message) {
      observed.returns.push(message)
      const done = events.get(message.id)
      if (!done) throw Error('unexpected message id ' + message.id)
      events.delete(message.id)
      done(message)
    },
  }
  const context = {
    self,
    createImageBitmap: async (blob) => {
      if (blob.fail) throw new Error('decode rejected')
      observed.decodes.push(blob.name)
      const bmp = {
        width: blob.width ?? bitmapWidth,
        height: blob.height ?? bitmapHeight,
        source: blob.name,
        closed: false,
        close() { if (bmp.closed) throw Error('double close'); bmp.closed = true; observed.closes.push(bmp.source) },
      }
      return bmp
    },
    OffscreenCanvas: class {
      constructor(width, height) { this.width = width; this.height = height }
      getContext() {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: (bmp) => {
            if (bmp.closed) throw Error('draw after close')
            observed.draws.push({ source: bmp.source, width: this.width, height: this.height })
            this.source = bmp.source
          },
        }
      }
      async convertToBlob() {
        return { url: 'data:image/png;base64,' + this.source + ':' + this.width + 'x' + this.height }
      }
    },
    FileReaderSync: class {
      readAsDataURL(blob) { return blob.url }
    },
    fetch: async (dataURL) => ({ blob: async () => ({ name: dataURL }) }),
  }
  vm.runInNewContext(WORKER[1], context, { timeout: 1000 })
  let id = 0
  function send(blob, bitmapKey, targetW = 300, targetH = 200) {
    const message = {
      id: ++id, dataURL: blob ? '' : 'data:image/png;base64,uncached',
      blob, bitmapKey, srcLength: 1024, targetW, targetH,
      resFactor: 1, quality: 0.92, mime: 'image/png',
    }
    return new Promise((resolve) => {
      events.set(message.id, resolve)
      self.onmessage({ data: message })
    })
  }
  return { observed, send }
}

test('same immutable Blob identity decodes once across changed output geometry', async () => {
  const worker = simulatedWorker()
  const original = { name: 'source-A' }
  const a = await worker.send(original, 1, 300, 200)
  const b = await worker.send(original, 1, 450, 300)
  const c = await worker.send(original, 1, 150, 100)
  assert.equal(worker.observed.decodes.length, 1)
  assert.equal(a.bitmapCacheHit, false)
  assert.equal(b.bitmapCacheHit, true)
  assert.equal(c.bitmapCacheHit, true)
  assert.equal(worker.observed.closes.length, 0, 'retained bitmap remains drawable')
  assert.equal(worker.observed.draws.length, 3)
  assert.notEqual(a.url, b.url)
  assert.notEqual(b.url, c.url)
  assert.deepEqual(worker.observed.draws.map((x) => [x.width, x.height]), [[300, 200], [450, 300], [150, 100]])
})

test('distinct source identities never substitute another bitmap', async () => {
  const worker = simulatedWorker()
  const a = await worker.send({ name: 'distinct-A' }, 12)
  const b = await worker.send({ name: 'distinct-B' }, 13)
  assert.equal(worker.observed.decodes.length, 2)
  assert.equal(a.bitmapCacheHit, false)
  assert.equal(b.bitmapCacheHit, false)
  assert.match(a.url, /distinct-A/)
  assert.match(b.url, /distinct-B/)
})

test('the 12 MiB worker cap evicts oldest decoded backing and closes it', async () => {
  const worker = simulatedWorker()
  for (let i = 1; i <= 4; i++) await worker.send({ name: 'img-' + i }, i)
  assert.deepEqual(worker.observed.closes, ['img-1'])
  await worker.send({ name: 'img-1' }, 1)
  assert.equal(worker.observed.decodes.length, 5, 'evicted image must decode again')
  assert.deepEqual(worker.observed.closes, ['img-1', 'img-2'])
})

test('a bitmap larger than the cap is never retained', async () => {
  const worker = simulatedWorker({ bitmapWidth: 4000, bitmapHeight: 3000 })
  await worker.send({ name: 'huge' }, 9)
  await worker.send({ name: 'huge' }, 9)
  assert.deepEqual(worker.observed.decodes, ['huge', 'huge'])
  assert.deepEqual(worker.observed.closes, ['huge', 'huge'])
})

test('a blob without identity retains the existing decode-per-request behavior', async () => {
  const worker = simulatedWorker()
  await worker.send({ name: 'unkeyed' }, 0)
  await worker.send({ name: 'unkeyed' }, 0)
  assert.deepEqual(worker.observed.decodes, ['unkeyed', 'unkeyed'])
  assert.deepEqual(worker.observed.closes, ['unkeyed', 'unkeyed'])
})

test('decode rejection reports an error and does not poison the worker queue', async () => {
  const worker = simulatedWorker()
  const error = await worker.send({ name: 'bad', fail: true }, 1)
  assert.match(error.error, /decode rejected/)
  const good = await worker.send({ name: 'good' }, 2)
  assert.match(good.url, /good/)
})

test('source tokens are keyed by Blob object identity, not URL or string equality', () => {
  const match = SOURCE.match(/const _bitmapTokens = new WeakMap\(\)[\s\S]*?function bitmapTokenFor\(blob\) \{[\s\S]*?\n\}/)
  assert.ok(match, 'tests must exercise the production identity mechanism')
  const context = {}
  vm.runInNewContext(match[0] + '\nthis.token = bitmapTokenFor', context)
  const first = { name: 'same-url' }, second = { name: 'same-url' }
  assert.equal(context.token(first), context.token(first))
  assert.notEqual(context.token(first), context.token(second))
  assert.equal(context.token(null), 0)
})

test('worker cache and affinity are bounded and independent of any public API', () => {
  assert.match(SOURCE, /BITMAP_CAP_BYTES = 12 \* 1024 \* 1024/)
  assert.match(SOURCE, /bitmapToken > 0 \? \(bitmapToken - 1\) % POOL_SIZE/)
  assert.match(SOURCE, /if \(bmp && !retained\) bmp\.close\(\)/)
  assert.match(SOURCE, /oldest\.bitmap\.close\(\)/)
  assert.match(SOURCE, /WORKER_JOB_TIMEOUT = 5000/)
})
