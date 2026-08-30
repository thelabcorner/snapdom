import { performance } from 'node:perf_hooks'

function makeTree(depth = 6, fanout = 5) {
  let id = 0
  const root = { id: id++, children: [], scrollX: 0, scrollY: 0, positioned: false }
  const queue = [{ node: root, depth: 0 }]
  const nodes = [root]
  while (queue.length) {
    const { node, depth: d } = queue.shift()
    if (d >= depth) continue
    for (let i = 0; i < fanout; i++) {
      const n = {
        id: id++, children: [],
        scrollX: id % 17 === 0 ? 3 : 0,
        scrollY: id % 13 === 0 ? 7 : 0,
        positioned: id % 11 === 0,
      }
      node.children.push(n)
      nodes.push(n)
      queue.push({ node: n, depth: d + 1 })
    }
  }
  return { root, nodes }
}

function current(root) {
  let probes = 0
  let adjustments = 0
  function scanDesc(node, sx, sy) {
    const stack = [...node.children]
    while (stack.length) {
      const child = stack.pop()
      probes++
      if (child.positioned) adjustments += sx + sy
      for (const c of child.children) stack.push(c)
    }
  }
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    probes++
    if (node.scrollX || node.scrollY) scanDesc(node, node.scrollX, node.scrollY)
    for (const c of node.children) stack.push(c)
  }
  return probes ^ adjustments
}

function cumulative(root) {
  let probes = 0
  let adjustments = 0
  const stack = [{ node: root, sx: 0, sy: 0 }]
  while (stack.length) {
    const { node, sx, sy } = stack.pop()
    probes++
    if (node.positioned) adjustments += sx + sy
    const nextX = sx + node.scrollX
    const nextY = sy + node.scrollY
    for (const c of node.children) stack.push({ node: c, sx: nextX, sy: nextY })
  }
  return probes ^ adjustments
}

const { root, nodes } = makeTree()
console.log(`prepare-scroll corpus: ${nodes.length} nodes`)

function bench(name, fn, rounds = 250) {
  for (let i = 0; i < 20; i++) fn(root)
  const samples = []
  let sink = 0
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now()
    for (let i = 0; i < rounds; i++) sink ^= fn(root)
    samples.push((performance.now() - t0) * 1e6 / rounds)
  }
  samples.sort((a, b) => a - b)
  return { name, nsPerOp: samples[3], sink }
}

const results = [bench('current-subtree-scans', current), bench('cumulative-one-pass', cumulative)]
const base = results[0].nsPerOp
for (const r of results.sort((a, b) => a.nsPerOp - b.nsPerOp)) {
  const gain = (base / r.nsPerOp - 1) * 100
  console.log(`${r.name.padEnd(23)} ${r.nsPerOp.toFixed(1).padStart(12)} ns/op  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% vs current`)
}
