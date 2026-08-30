import { performance } from 'node:perf_hooks'

function makeChain(depth) {
  const nodes = Array.from({ length: depth }, (_, id) => ({ id, ownHit: false, children: [] }))
  for (let i = 0; i < depth - 1; i++) nodes[i].children.push(nodes[i + 1])
  nodes[depth - 1].ownHit = true
  return nodes[0]
}

function makeForest(branches, depth) {
  const root = { id: 0, ownHit: true, children: [] }
  let id = 1
  for (let b = 0; b < branches; b++) {
    let head = { id: id++, ownHit: false, children: [] }
    root.children.push(head)
    for (let d = 1; d < depth; d++) {
      const child = { id: id++, ownHit: false, children: [] }
      head.children.push(child)
      head = child
    }
    if ((b & 3) === 0) head.ownHit = true
  }
  return root
}

function current(root) {
  let probes = 0
  function hasEscape(node) {
    const stack = [...node.children]
    while (stack.length) {
      const child = stack.pop()
      probes++
      if (child.ownHit) return true
      for (let i = 0; i < child.children.length; i++) stack.push(child.children[i])
    }
    return false
  }
  function walk(node) {
    probes++
    if (!node.ownHit && !hasEscape(node)) return
    for (const child of node.children) walk(child)
  }
  walk(root)
  return probes
}

function memoized(root) {
  let probes = 0
  const subtree = new Map()
  function hasEscape(node) {
    const cached = subtree.get(node)
    if (cached !== undefined) return cached
    let hit = false
    for (const child of node.children) {
      probes++
      if (child.ownHit || hasEscape(child)) { hit = true; break }
    }
    subtree.set(node, hit)
    return hit
  }
  function walk(node) {
    probes++
    if (!node.ownHit && !hasEscape(node)) return
    for (const child of node.children) walk(child)
  }
  walk(root)
  return probes
}

function bench(label, build, rounds = 300) {
  const root = build()
  const expectedA = current(root)
  const expectedB = memoized(root)
  const variants = { current, memoized }
  const out = []
  for (const [name, fn] of Object.entries(variants)) {
    for (let i = 0; i < 20; i++) fn(root)
    const samples = []
    let sink = 0
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now()
      for (let i = 0; i < rounds; i++) sink ^= fn(root)
      samples.push((performance.now() - t0) * 1e6 / rounds)
    }
    samples.sort((a, b) => a - b)
    out.push({ name, nsPerOp: samples[3], sink })
  }
  const base = out.find(x => x.name === 'current').nsPerOp
  console.log(`clip-cull ${label}: probe counts current=${expectedA}, memoized=${expectedB}`)
  for (const r of out.sort((a, b) => a.nsPerOp - b.nsPerOp)) {
    const gain = (base / r.nsPerOp - 1) * 100
    console.log(`${r.name.padEnd(12)} ${r.nsPerOp.toFixed(1).padStart(12)} ns/op  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% vs current`)
  }
}

bench('deep-chain-900', () => makeChain(900), 80)
bench('forest-48x80', () => makeForest(48, 80), 80)
