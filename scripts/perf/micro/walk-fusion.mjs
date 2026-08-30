import { performance } from 'node:perf_hooks'

const N = 12000
const nodes = Array.from({ length: N }, (_, i) => ({
  tag: i % 37 === 0 ? 'img' : i % 43 === 0 ? 'style' : i % 7 === 0 ? 'span' : 'div',
  hasBackground: i % 11 === 0,
  blob: i % 101 === 0,
  comment: i % 127 === 0,
  invalidXml: i % 173 === 0,
  compressible: i % 5 === 0,
}))

function separateWalks() {
  let sink = 0
  for (const n of nodes) if (n.tag === 'img') sink++
  for (const n of nodes) if (n.tag === 'style') sink++
  for (const n of nodes) if (n.hasBackground) sink++
  for (const n of nodes) if (n.blob) sink++
  for (const n of nodes) if (n.comment) sink++
  for (const n of nodes) if (n.invalidXml) sink++
  for (const n of nodes) if (n.compressible) sink++
  for (const n of nodes) sink += n.tag.length & 1
  return sink
}

function fusedInterestLists() {
  let sink = 0
  const imgs = [], styles = [], bg = [], blobs = [], comments = [], invalid = [], compress = []
  for (const n of nodes) {
    if (n.tag === 'img') imgs.push(n)
    if (n.tag === 'style') styles.push(n)
    if (n.hasBackground) bg.push(n)
    if (n.blob) blobs.push(n)
    if (n.comment) comments.push(n)
    if (n.invalidXml) invalid.push(n)
    if (n.compressible) compress.push(n)
    sink += n.tag.length & 1
  }
  sink += imgs.length + styles.length + bg.length + blobs.length + comments.length + invalid.length + compress.length
  return sink
}

function bench(name, fn, rounds = 1200) {
  for (let i = 0; i < 50; i++) fn()
  const samples = []
  let sink = 0
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now()
    for (let i = 0; i < rounds; i++) sink ^= fn()
    samples.push((performance.now() - t0) * 1e6 / rounds)
  }
  samples.sort((a, b) => a - b)
  return { name, nsPerOp: samples[3], sink }
}

const results = [bench('8-separate-walks', separateWalks), bench('1-fused-walk', fusedInterestLists)]
const base = results[0].nsPerOp
console.log(`walk-fusion corpus: ${N} nodes`)
for (const r of results.sort((a, b) => a.nsPerOp - b.nsPerOp)) {
  const gain = (base / r.nsPerOp - 1) * 100
  console.log(`${r.name.padEnd(18)} ${r.nsPerOp.toFixed(1).padStart(12)} ns/op  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% vs current`)
}
