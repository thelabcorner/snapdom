import { performance } from 'node:perf_hooks'

const PROP_COUNT = 520
const props = []
const defaults = {}
for (let i = 0; i < PROP_COUNT; i++) {
  const prop = `prop-${String(i).padStart(4, '0')}`
  props.push(prop)
  defaults[prop] = `${i % 7}px`
}

function makeSnapshot(variant) {
  const snap = {}
  for (let i = 0; i < PROP_COUNT; i++) {
    const prop = props[i]
    snap[prop] = i % 17 === variant % 17 ? `${i + variant + 1}px` : defaults[prop]
  }
  return snap
}

const repeated = Array.from({ length: 256 }, () => makeSnapshot(3))
const unique = Array.from({ length: 256 }, (_, i) => makeSnapshot(i))

function signature(snap) {
  const keys = Object.keys(snap)
  let out = ''
  for (let i = 0; i < keys.length; i++) {
    if (i) out += ';'
    const prop = keys[i]
    out += prop + ':' + snap[prop]
  }
  return out
}

function styleKeyCurrent(snap) {
  const entries = []
  for (const prop in snap) {
    const value = snap[prop]
    if (value && value !== defaults[prop]) entries.push(`${prop}:${value}`)
  }
  entries.sort()
  return entries.join(';')
}

function styleKeyCanonical(snap) {
  const entries = []
  for (let i = 0; i < props.length; i++) {
    const prop = props[i]
    const value = snap[prop]
    if (value && value !== defaults[prop]) entries.push(`${prop}:${value}`)
  }
  return entries.join(';')
}

function cached(corpus, keyFn) {
  const map = new Map()
  let sink = 0
  for (const snap of corpus) {
    const sig = signature(snap)
    let key = map.get(sig)
    if (key === undefined) {
      key = keyFn(snap)
      map.set(sig, key)
    }
    sink ^= key.length
  }
  return sink
}

function direct(corpus, keyFn) {
  let sink = 0
  for (const snap of corpus) sink ^= keyFn(snap).length
  return sink
}

function bench(name, fn, corpus, rounds = 20) {
  for (let i = 0; i < 5; i++) fn(corpus)
  const samples = []
  let sink = 0
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now()
    for (let i = 0; i < rounds; i++) sink ^= fn(corpus)
    samples.push((performance.now() - t0) * 1e6 / (rounds * corpus.length))
  }
  samples.sort((a, b) => a - b)
  return { name, nsPerNode: samples[3], sink }
}

for (const [label, corpus] of [['repeated', repeated], ['unique', unique]]) {
  const variants = [
    ['cached-current', c => cached(c, styleKeyCurrent)],
    ['direct-current', c => direct(c, styleKeyCurrent)],
    ['cached-canonical', c => cached(c, styleKeyCanonical)],
    ['direct-canonical', c => direct(c, styleKeyCanonical)],
  ]
  const results = variants.map(([name, fn]) => bench(name, fn, corpus))
  const base = results.find(r => r.name === 'cached-current').nsPerNode
  console.log(`snapshot-key cache race: ${label}, ${PROP_COUNT} props, ${corpus.length} nodes`)
  for (const r of results.sort((a, b) => a.nsPerNode - b.nsPerNode)) {
    const gain = (base / r.nsPerNode - 1) * 100
    console.log(`${r.name.padEnd(18)} ${r.nsPerNode.toFixed(1).padStart(10)} ns/node  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% vs cached-current`)
  }
}
