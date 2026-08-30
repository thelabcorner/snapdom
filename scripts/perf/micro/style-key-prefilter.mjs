import { performance } from 'node:perf_hooks'

const PROP_COUNT = 520
const snapshots = []
const defaults = {}
const ignored = new Map()

for (let i = 0; i < PROP_COUNT; i++) {
  const prop = `prop-${String(i).padStart(4, '0')}`
  defaults[prop] = `${i % 7}px`
  ignored.set(prop, false)
}

for (let v = 0; v < 64; v++) {
  const snap = {}
  for (let i = 0; i < PROP_COUNT; i++) {
    const prop = `prop-${String(i).padStart(4, '0')}`
    snap[prop] = i % 11 === v % 11 ? `${i + v + 1}px` : defaults[prop]
  }
  snapshots.push(snap)
}

function current(snap) {
  const entries = []
  for (const prop in snap) {
    if (ignored.get(prop)) continue
    const value = snap[prop]
    if (value && value !== defaults[prop]) entries.push(`${prop}:${value}`)
  }
  entries.sort()
  return entries.join(';')
}

function prefiltered(snap) {
  const entries = []
  for (const prop in snap) {
    const value = snap[prop]
    if (value && value !== defaults[prop]) entries.push(`${prop}:${value}`)
  }
  entries.sort()
  return entries.join(';')
}

const canonicalProps = Object.keys(defaults).sort()
function canonicalIndexed(snap) {
  const entries = []
  for (let i = 0; i < canonicalProps.length; i++) {
    const prop = canonicalProps[i]
    const value = snap[prop]
    if (value && value !== defaults[prop]) entries.push(`${prop}:${value}`)
  }
  return entries.join(';')
}

function run(fn, rounds = 20000) {
  let sink = 0
  for (let i = 0; i < 1000; i++) sink ^= fn(snapshots[i & 63]).length
  const t0 = performance.now()
  for (let i = 0; i < rounds; i++) sink ^= fn(snapshots[i & 63]).length
  return { nsPerOp: (performance.now() - t0) * 1e6 / rounds, sink }
}

const variants = { current, prefiltered, canonicalIndexed }
const results = []
for (const [name, fn] of Object.entries(variants)) {
  const samples = []
  for (let r = 0; r < 7; r++) samples.push(run(fn))
  samples.sort((a, b) => a.nsPerOp - b.nsPerOp)
  results.push({ name, ...samples[3] })
}
results.sort((a, b) => a.nsPerOp - b.nsPerOp)
const base = results.find(r => r.name === 'current').nsPerOp

console.log('style-key filter/order micro-race, 520 props, 64 snapshots, median of 7')
for (const r of results) {
  const gain = (base / r.nsPerOp - 1) * 100
  console.log(`${r.name.padEnd(18)} ${r.nsPerOp.toFixed(1).padStart(10)} ns/op  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% vs current`)
}
