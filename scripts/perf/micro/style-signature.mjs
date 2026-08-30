import { performance } from 'node:perf_hooks'

function makeSnapshot(count = 520, variants = 64) {
  const snapshots = []
  for (let v = 0; v < variants; v++) {
    const snap = {}
    for (let i = 0; i < count; i++) {
      const n = (i * 17 + v * 13) % count
      snap[`prop-${String(n).padStart(4, '0')}`] = `${(n * 31 + v) % 997}px`
    }
    snapshots.push(snap)
  }
  return snapshots
}

const snapshots = makeSnapshot()

const variants = {
  current(snap) {
    const entries = Object.entries(snap).sort((a, b) => a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0))
    return entries.map(([k, v]) => `${k}:${v}`).join(';')
  },

  entriesNoSort(snap) {
    const entries = Object.entries(snap)
    return entries.map(([k, v]) => `${k}:${v}`).join(';')
  },

  entriesLoop(snap) {
    const entries = Object.entries(snap)
    let out = ''
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (i) out += ';'
      out += e[0] + ':' + e[1]
    }
    return out
  },

  objectKeysLoop(snap) {
    const keys = Object.keys(snap)
    let out = ''
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (i) out += ';'
      out += k + ':' + snap[k]
    }
    return out
  },

  forIn(snap) {
    let out = ''
    let first = true
    for (const k in snap) {
      if (!first) out += ';'
      first = false
      out += k + ':' + snap[k]
    }
    return out
  },

  keysSortLoop(snap) {
    const keys = Object.keys(snap).sort()
    let out = ''
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (i) out += ';'
      out += k + ':' + snap[k]
    }
    return out
  },
}

function run(fn, rounds = 16000) {
  let sink = 0
  for (let i = 0; i < 1000; i++) sink ^= fn(snapshots[i % snapshots.length]).length
  const t0 = performance.now()
  for (let i = 0; i < rounds; i++) sink ^= fn(snapshots[i % snapshots.length]).length
  const ms = performance.now() - t0
  return { ms, nsPerOp: ms * 1e6 / rounds, sink }
}

const results = []
for (const [name, fn] of Object.entries(variants)) {
  const samples = []
  for (let r = 0; r < 7; r++) samples.push(run(fn))
  samples.sort((a, b) => a.nsPerOp - b.nsPerOp)
  results.push({ name, ...samples[3] })
}
results.sort((a, b) => a.nsPerOp - b.nsPerOp)
const base = results.find(r => r.name === 'current').nsPerOp

console.log('style-signature micro-race, 520 props, 64 snapshots, median of 7')
for (const r of results) {
  const gain = (base / r.nsPerOp - 1) * 100
  console.log(`${r.name.padEnd(16)} ${r.nsPerOp.toFixed(1).padStart(10)} ns/op  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% vs current`)
}
