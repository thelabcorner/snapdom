import test from 'node:test'
import assert from 'node:assert/strict'
import { runBoundedSettled } from '../src/utils/boundedSettled.js'

test('zero assets enqueue no work', async () => {
  let called = false
  await runBoundedSettled(0, () => { called = true })
  assert.equal(called, false)
})

test('a straggler never blocks admission of a waiting seventh item', async () => {
  let releaseSlow
  const slow = new Promise(resolve => { releaseSlow = resolve })
  const started = []
  const done = []
  const pending = runBoundedSettled(7, async i => {
    started.push(i)
    if (i === 0) await slow
    done.push(i)
  })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6])
  assert.equal(done.includes(0), false)
  releaseSlow()
  await pending
  assert.equal(done.length, 7)
})

test('hard ceiling holds through errors, delayed jobs and immediate completions', async () => {
  let active = 0
  let peak = 0
  const visited = []
  await runBoundedSettled(51, async i => {
    active++
    peak = Math.max(active, peak)
    visited.push(i)
    try {
      await Promise.resolve()
      if (i % 5 === 0) throw new Error('independent image failure')
      await Promise.resolve()
    } finally { active-- }
  })
  assert.equal(peak, 6)
  assert.deepEqual(visited.slice().sort((a, b) => a - b), Array.from({ length: 51 }, (_, i) => i))
  assert.equal(active, 0)
})

test('sync throw does not prevent the next item or reject the group', async () => {
  const seen = []
  await runBoundedSettled(13, i => {
    seen.push(i)
    if ((i % 3) === 0) throw Error('failed')
    return Promise.resolve()
  }, 2)
  assert.equal(seen.length, 13)
})

test('rejects invalid queue sizes rather than silently changing the concurrency contract', async () => {
  await assert.rejects(runBoundedSettled(-1, () => {}), RangeError)
  await assert.rejects(runBoundedSettled(2, () => {}, 0), RangeError)
})
