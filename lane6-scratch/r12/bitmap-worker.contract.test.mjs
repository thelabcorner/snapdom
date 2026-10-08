import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../../src/modules/compress.js', import.meta.url), 'utf8')
const tick = String.fromCharCode(96)
const marker = 'const WORKER_SRC = ' + tick
const workerScript = source.split(marker)[1]?.split(tick)[0]
if (!workerScript) throw new Error('cannot inspect inline production Worker source')

function sandbox({ width = 1200, height = 800 } = {}) {
  let decodeCount = 0
  let closeCount = 0
  let drawCount = 0
  const replies = []
  const self = { postMessage: (response) => replies.push(response) }
  const globals = {
    self,
    createImageBitmap: async (blob) => {
      decodeCount++
      await Promise.resolve()
      return {
        width: blob.width ?? width, height: blob.height ?? height,
        close: () => { closeCount++ },
      }
    },
    OffscreenCanvas: class {
      getContext() {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: '',
          drawImage: () => { drawCount++ },
        }
      }
      async convertToBlob() { return { encoded: true } }
    },
    FileReaderSync: class {
      readAsDataURL() { return 'data:image/png;base64,' + 'A'.repeat(100) }
    },
    fetch: async () => ({ blob: async () => ({ width, height }) }),
  }
  vm.runInNewContext(workerScript, globals, { timeout: 1000 })
  const send = (id, bitmapKey = 0, blob = { width, height }, targetW = 300) =>
    self.onmessage({ data: {
      id, bitmapKey, blob, dataURL: '',
      srcLength: 200, targetW, targetH: 200,
      resFactor: 1, quality: 0.92, mime: 'image/png',
    } })
  return {
    send, replies,
    get counts() { return { decodeCount, closeCount, drawCount } },
  }
}

test('changed geometries borrow the exact retained bitmap without decoding again', async () => {
  const t = sandbox()
  const same = { width: 1200, height: 800 }
  await t.send(1, 1, same, 300)
  await t.send(2, 1, same, 340)
  await t.send(3, 1, same, 390)
  assert.equal(t.counts.decodeCount, 1)
  assert.equal(t.counts.drawCount, 3)
  assert.deepEqual(t.replies.map((x) => x.bitmapHit), [false, true, true])
  assert.ok(t.replies.every((x) => !x.error && x.url.startsWith('data:image/')))
})

test('different source tokens never alias identical-dimension images', async () => {
  const t = sandbox()
  await t.send(1, 1)
  await t.send(2, 2)
  await t.send(3, 1)
  assert.equal(t.counts.decodeCount, 3, 'one-entry budget evicts the oldest identity')
  assert.ok(t.counts.closeCount >= 2, 'evicted resources are explicitly closed')
})

test('simultaneous same-token requests single-flight exactly one bitmap decode', async () => {
  const t = sandbox()
  await Promise.all([t.send(1, 7), t.send(2, 7)])
  assert.equal(t.counts.decodeCount, 1, 'duplicate concurrent decoding must be eliminated')
  assert.equal(t.counts.drawCount, 2)
  assert.equal(t.counts.closeCount, 0, 'retained bitmap remains live')
  assert.deepEqual(t.replies.map((x) => x.bitmapHit).sort(), [false, true])
  await t.send(3, 7)
  assert.equal(t.counts.decodeCount, 1)
  assert.equal(t.replies.find((x) => x.id === 3)?.bitmapHit, true)
})

test('oversized simultaneous same-token decodes share one transient bitmap, closed once', async () => {
  const t = sandbox({ width: 2600, height: 2600 })
  await Promise.all([t.send(1, 21), t.send(2, 21), t.send(3, 21)])
  assert.equal(t.counts.decodeCount, 1)
  assert.equal(t.counts.drawCount, 3)
  assert.equal(t.counts.closeCount, 1, 'transient resource closed only after final borrower')
  assert.equal(t.replies.filter((x) => !x.error).length, 3)
  await t.send(4, 21)
  assert.equal(t.counts.decodeCount, 2, 'oversized bitmap must not stay cached')
  assert.equal(t.counts.closeCount, 2)
})

test('oversized sources and no-token messages never retain decoded memory', async () => {
  const t = sandbox({ width: 2600, height: 2600 })
  await t.send(1, 5)
  await t.send(2, 5)
  await t.send(3, 0)
  await t.send(4, 0)
  assert.equal(t.counts.decodeCount, 4)
  assert.equal(t.counts.closeCount, 4)
  assert.ok(t.replies.every((x) => !x.error))
})

test('source-bearing posts are keyed by exact WeakMap Blob identity with worker affinity', () => {
  assert.match(source, /const _bitmapTokens = new WeakMap\(\)/)
  assert.match(source, /const bitmapKey = bitmapTokenFor\(blob\)/)
  assert.match(source, /bitmapKey > 0 \? bitmapKey % POOL_SIZE : _next\+\+ % POOL_SIZE/)
  assert.match(source, /blob, bitmapKey, srcLength/)
  assert.match(source, /BITMAP_BUDGET = 4 \* 1024 \* 1024/)
})
