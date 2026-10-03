#!/usr/bin/env node
// R10-ANIM1 GEOMETRY check: does the reachability predicate classify every fixture the way the
// SPEC says? Node only — no browser, no bundle, no timing.
//
// WHY THIS FILE EXISTS
// --------------------
// d919614 shipped a predicate built on `ancestors` = the closure of each animation target's
// ANCESTORS, and hosted run 37145239641 falsified it on all three engines. Chromium:
//
//   anim-ancestor        10023 -> 3645   saved 6378   MUST be 0
//   anim-ancestor-customprop 10027 -> 3649          MUST be 0
//   anim-ancestor-noninherited 10023 -> 3645        MUST be 0
//   anim-self            10023 -> 3820   saved 6203   MUST be 0
//   anim-subtree         10023 -> 3916   saved 6107   MUST be 0
//   anim-shadow          saved 0                     (correct: unresolvable)
//   anim-none            saved 0                     (correct: no animations)
//
// Cross-engine deterministic, so not noise. Raw parity was byte-exact on every fixture, which is the
// lesson recorded here: parity is NECESSARY, not SUFFICIENT. A veto that releases the wrong cases can
// still emit identical bytes when the omitted properties happen to compute to '' anyway.
//
// ROOT CAUSE: the direction of reachability was inverted. An animation on target T moves T and T's
// DESCENDANTS (inherited values flow downward). It never moves T's ANCESTORS. d919614 asked "am I
// upstream of an animation?", so it released precisely the ancestor and self geometries that had to
// stay blocked — and the near-identical savings across all four geometries are the signature of one
// defect, not four.
//
// The first attempt at this check (check-r10-anim-scope-algorithm.mjs) could not have caught it: it
// compared the optimized ancestor closure against a brute-force ANCESTOR closure. Implementation
// against itself, not against the spec. This file compares the shipped predicate against an
// INDEPENDENT naive oracle, keeps d919614's predicate as a NEGATIVE CONTROL asserted to misclassify,
// and states every expected verdict by hand so a wrong answer cannot be self-consistent.
//
// GEOMETRY IS DECLARED AS EXPLICIT PARENT EDGES, never by string concatenation. The first draft
// concatenated two document specs with '>', which produced a tree with two <html> nodes — so
// doc.documentElement resolved to the second one and the "sibling" target was really a descendant.
// That produced five harness failures that had nothing to do with the lane.
//
// Run: node lane6-scratch/r10/check-r10-anim-scope-geometry.mjs

import fs from 'node:fs'

const SOURCES = {
  scan: 'src/modules/styleScan.js',
  styles: 'src/modules/styles.js',
}

// ---------------------------------------------------------------------------
// The one document every case shares. Read it as a picture:
//
//   #document
//   └── html
//       └── body
//           └── host
//               ├── root          <- the capture root in the hosted fixtures
//               │   ├── row0
//               │   │   ├── leaf0
//               │   │   │   └── deep
//               │   │   └── leaf1
//               │   └── rowA
//               ├── row1         <- SIBLING of root  (the opportunity target)
//               └── row2         <- SIBLING of root
//
// "up" from row1 reaches html; "down" from row1 reaches nothing. That asymmetry is the whole lane.
// leaf1 is a SIBLING of leaf0, not its child; `deep` is the genuine child. Keeping both is what
// stops a parent/child case from being quietly satisfied by a sibling relationship.
// ---------------------------------------------------------------------------
const EDGES = [
  ['html', null],
  ['body', 'html'],
  ['host', 'body'],
  ['root', 'host'],
  ['row0', 'root'],
  ['leaf0', 'row0'],
  ['deep', 'leaf0'],
  ['leaf1', 'row0'],
  ['rowA', 'root'],
  ['row1', 'host'],
  ['row2', 'host'],
]

function makeNode(name, parent, doc) {
  return {
    name,
    nodeType: 1,
    parentElement: parent || null,
    localName: name,
    root: doc,
    getRootNode() { return this.root },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === this) return true
      return false
    },
  }
}

function buildDoc(edges) {
  const doc = { name: '#document', documentElement: null }
  const byName = {}
  for (const [child, parent] of edges) {
    const node = makeNode(child, parent ? byName[parent] : null, doc)
    byName[child] = node
    if (child === 'html') doc.documentElement = node
  }
  return { doc, byName }
}
const anim = (target) => ({ effect: { target } })

// ---------------------------------------------------------------------------
// INDEPENDENT ORACLE — naive on purpose, shares no code with the implementation.
// Enumerates every node and asks the spec question directly.
// ---------------------------------------------------------------------------
function oracleAffected(byName, targets) {
  const affected = new Set()
  for (const node of Object.values(byName)) {
    for (const target of targets) {
      if (node === target || target.contains(node)) { affected.add(node); break }
    }
  }
  return affected
}

/**
 * mode 'self'      can an animation change THIS node's own NON-INHERITED values?
 * mode 'inherited' can an animation change any of THIS node's computed values?
 * mode 'subtree'   can an animation change anything in THIS node's subtree?
 */
function oracleBlocks(byName, targetNames, mode, elName) {
  const targets = targetNames.map((n) => byName[n])
  const el = byName[elName]
  if (mode === 'self') return targets.some((t) => t === el)
  if (mode === 'inherited') return oracleAffected(byName, targets).has(el)
  if (mode === 'subtree') {
    const affected = oracleAffected(byName, targets)
    for (const node of Object.values(byName)) {
      if (el.contains(node) && affected.has(node)) return true
    }
    return false
  }
  throw new Error('bad mode ' + mode)
}

// ---------------------------------------------------------------------------
// VERBATIM from src/modules/styleScan.js — v2 (shipped). Keep in sync.
// ---------------------------------------------------------------------------
function buildAnimationScope(doc, animations) {
  const targets = new Set()
  let unresolvable = false
  for (const anim of animations) {
    const target = anim?.effect?.target
    if (!target || target.nodeType !== 1) { unresolvable = true; continue }
    if (target.getRootNode && target.getRootNode() !== doc) { unresolvable = true; continue }
    targets.add(target)
  }
  return { count: animations.length, targets, unresolvable }
}

// ---------------------------------------------------------------------------
// VERBATIM from src/modules/styles.js — v2 (shipped), counter plumbing stripped.
// ---------------------------------------------------------------------------
const ANIM_REACH_DEPTH_LIMIT = 1024
function animationReachesInherited(index, el, doc) {
  let a = el
  for (let depth = 0; a && depth < ANIM_REACH_DEPTH_LIMIT; depth++) {
    if (index.targets.has(a)) return true
    if (a === doc.documentElement) return false
    const next = a.parentElement
    if (!next) return true
    a = next
  }
  return true
}
function animationReachesSubtree(index, el, doc) {
  if (animationReachesInherited(index, el, doc)) return true
  for (const target of index.targets) {
    if (el.contains(target)) return true
  }
  return false
}
function animationBlocks(scan, el, mode) {
  if (!scan.hasAnimations) return false
  const index = scan.animationScope
  if (!index) return true
  if (index.unresolvable) return true
  const doc = el.root
  if (mode === 'self') return index.targets.has(el)
  if (mode === 'inherited') return animationReachesInherited(index, el, doc)
  if (mode === 'subtree') return animationReachesSubtree(index, el, doc)
  throw new Error('bad mode ' + mode)
}

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — the d919614 predicate, verbatim. Asserted to MISCLASSIFY.
// Only geometries where the spec REQUIRES a block are listed: v1 must release each of them.
// ---------------------------------------------------------------------------
function v1AnimationBlocks(scan, el, mode) {
  if (!scan.hasAnimations) return false
  const index = scan.animationScope
  if (!index) return true
  if (index.unresolvable) return true
  if (mode === 'self') return index.targets.has(el)
  if (mode === 'inherited') return index.targets.has(el) || index.ancestors.has(el)
  return index.ancestors.has(el) || [...index.targets].some((t) => t === el || el.contains(t))
}

function v1Index(byName, targetNames) {
  const targets = new Set()
  const ancestors = new Set()
  for (const entry of targetNames.map((n) => anim(byName[n]))) {
    const t = entry.effect.target
    targets.add(t)
    for (let a = t.parentElement; a; a = a.parentElement) ancestors.add(a)
  }
  return { targets, ancestors, unresolvable: false }
}

// ---------------------------------------------------------------------------
// Cases. `expect` is written from the SPEC by hand. It is never read from the implementation.
// role: opportunity = must be RELEASED. falsifier = must be BLOCKED. release = must be RELEASED.
// ---------------------------------------------------------------------------
const CASES = [
  // ---- OPPORTUNITY: the animated node is a sibling, sharing no ancestry with the rows ----
  { id: 'opportunity/sibling-of-root/deep-leaf', targets: ['row1'], el: 'leaf0', mode: 'inherited', expect: false },
  { id: 'opportunity/sibling-of-root/container', targets: ['row1'], el: 'root', mode: 'inherited', expect: false },
  { id: 'opportunity/sibling-of-root/other-sibling', targets: ['row1'], el: 'row2', mode: 'inherited', expect: false },
  { id: 'opportunity/sibling-of-root/cousin-branch', targets: ['row1'], el: 'rowA', mode: 'inherited', expect: false },

  // ---- FALSIFIER: the queried node IS the animated node ----
  { id: 'falsifier/target-itself', targets: ['row1'], el: 'row1', mode: 'inherited', expect: true },

  // ---- FALSIFIERS: the animated node is an ANCESTOR. This is the geometry d919614 inverted. ----
  { id: 'falsifier/ancestor=host/deep-leaf', targets: ['host'], el: 'leaf0', mode: 'inherited', expect: true },
  { id: 'falsifier/ancestor=host/container', targets: ['host'], el: 'root', mode: 'inherited', expect: true },
  { id: 'falsifier/ancestor=host/shallow-row', targets: ['host'], el: 'rowA', mode: 'inherited', expect: true },
  { id: 'falsifier/ancestor=row0/deep-leaf', targets: ['row0'], el: 'leaf1', mode: 'inherited', expect: true },
  { id: 'falsifier/ancestor=body/shallow-row', targets: ['body'], el: 'rowA', mode: 'inherited', expect: true },

  // ---- the asymmetry that pins the direction: an ancestor of the target is NOT affected ----
  { id: 'release/target-is-deep/its-own-ancestor', targets: ['leaf1'], el: 'row0', mode: 'inherited', expect: false },
  { id: 'release/target-is-leaf0/its-sibling-leaf1', targets: ['leaf0'], el: 'leaf1', mode: 'inherited', expect: false },
  { id: 'release/target-is-shallow/unrelated-branch', targets: ['row0'], el: 'row1', mode: 'inherited', expect: false },

  // ---- FALSIFIER: the element is the target, and so is everything under it ----
  { id: 'falsifier/self=target', targets: ['leaf0'], el: 'leaf0', mode: 'inherited', expect: true },
  { id: 'falsifier/self=target/its-child', targets: ['leaf0'], el: 'deep', mode: 'inherited', expect: true },
  { id: 'falsifier/self=capture-root', targets: ['root'], el: 'leaf1', mode: 'inherited', expect: true },
  { id: 'release/self=target/sibling-branch', targets: ['leaf0'], el: 'rowA', mode: 'inherited', expect: false },

  // ---- subtree reachability (consumer C). Both terms are load-bearing. ----
  { id: 'falsifier/subtree/target-inside-root', targets: ['leaf1'], el: 'root', mode: 'subtree', expect: true },
  { id: 'falsifier/subtree/ancestor-above-root', targets: ['host'], el: 'root', mode: 'subtree', expect: true },
  { id: 'falsifier/subtree/root-is-target', targets: ['root'], el: 'root', mode: 'subtree', expect: true },
  { id: 'release/subtree/unrelated-sibling-root', targets: ['leaf1'], el: 'row1', mode: 'subtree', expect: false },
  { id: 'release/subtree/inherited-view-of-target-inside', targets: ['leaf1'], el: 'rowA', mode: 'inherited', expect: false },

  // ---- SELF reachability (E/F/G): only the target itself, never a descendant, never an ancestor --
  { id: 'self-mode/target', targets: ['leaf0'], el: 'leaf0', mode: 'self', expect: true },
  { id: 'self-mode/child-released', targets: ['leaf0'], el: 'leaf1', mode: 'self', expect: false },
  { id: 'self-mode/ancestor-released', targets: ['leaf0'], el: 'row0', mode: 'self', expect: false },
  { id: 'self-mode/unrelated-released', targets: ['row1'], el: 'leaf0', mode: 'self', expect: false },
  { id: 'self-mode/capture-root', targets: ['root'], el: 'root', mode: 'self', expect: true },
]

// Geometries the spec REQUIRES to block, and where d919614 therefore released. Each one is a
// geometry where an animated node is an ancestor of the queried node (directly or via inheritance).
const V1_FALSIFIERS = [
  { id: 'ancestor=host/deep-leaf', targets: ['host'], el: 'leaf0', mode: 'inherited' },
  { id: 'ancestor=host/container', targets: ['host'], el: 'root', mode: 'inherited' },
  { id: 'ancestor=host/shallow-row', targets: ['host'], el: 'rowA', mode: 'inherited' },
  { id: 'ancestor=row0/deep-leaf', targets: ['row0'], el: 'leaf1', mode: 'inherited' },
  { id: 'ancestor=body/shallow-row', targets: ['body'], el: 'rowA', mode: 'inherited' },
  { id: 'self=target/its-child', targets: ['leaf0'], el: 'deep', mode: 'inherited' },
  { id: 'subtree/ancestor-above-root', targets: ['host'], el: 'root', mode: 'subtree' },
]

// The control must also be NON-VACUOUS: d919614 has to release the opportunity geometries, or
// "it misclassified the falsifiers" would prove nothing. Note the asymmetry deliberately NOT
// asserted here: d919614 over-blocks several geometries the spec releases (e.g. the ancestor OF a
// target). Over-blocking only costs performance, so it is not a defect and is not held against it.
const V1_OPPORTUNITIES = CASES.filter((c) => c.id.startsWith('opportunity/') && c.expect === false)

const failures = []
const check = (label, cond) => { if (!cond) failures.push(label) }

// --- 0. drift guard: the shipped sources must still contain the v2 markers ----
{
  const scan = fs.readFileSync(SOURCES.scan, 'utf8')
  const styles = fs.readFileSync(SOURCES.styles, 'utf8')
  const self = fs.readFileSync(new URL(import.meta.url), 'utf8')
  for (const [text, marker] of [
    [scan, 'targets.add(target)'],
    [scan, 'return { count: animations.length, targets, unresolvable }'],
    [styles, 'if (index.targets.has(a)) return true'],
    [styles, 'ANIM_REACH_INHERITED'],
    [styles, 'ANIM_REACH_SUBTREE'],
    [self, 'if (index.targets.has(a)) return true'],
    [self, 'return { count: animations.length, targets, unresolvable }'],
  ]) {
    check(`drift guard: "${marker}" present`, text.includes(marker))
  }
  check('styleScan no longer builds an ancestors closure', !scan.includes('ancestors.add(a)'))
  check('styles no longer asks "am I an ancestor of a target"', !styles.includes('index.ancestors.has(el)'))
}

// --- 1. shipped predicate == independent oracle == hand-written verdict -------
let released = 0
let blocked = 0
const table = []
for (const c of CASES) {
  const { doc, byName } = buildDoc(EDGES)
  const index = buildAnimationScope(doc, c.targets.map((n) => anim(byName[n])))
  const scan = { hasAnimations: true, animationScope: index }
  const got = animationBlocks(scan, byName[c.el], c.mode)
  const oracle = oracleBlocks(byName, c.targets, c.mode, c.el)
  check(`${c.id}: impl (${got}) == oracle (${oracle})`, got === oracle)
  check(`${c.id}: impl (${got}) == hand-written verdict (${c.expect})`, got === c.expect)
  const v1 = v1AnimationBlocks({ hasAnimations: true, animationScope: v1Index(byName, c.targets) }, byName[c.el], c.mode)
  table.push({ id: c.id, mode: c.mode, animated: c.targets.join('+'), queried: c.el, spec: c.expect, v2: got, v1 })
  if (got) blocked++
  else released++
}

// --- 1b. the static prediction table, printed so the hosted log carries it -----
// `spec` is the verdict the geometry REQUIRES. `v2` is what ships. `v1` is d919614, kept to show
// the hosted falsification reproduced offline: v1 releases every must-block ancestor geometry.
const VERDICT = (b) => (b ? 'BLOCK  ' : 'release')
console.log('')
console.log('  geometry                                   mode       animated     queried  spec     v2       v1(d919614)')
for (const r of table) {
  const flag = r.spec === r.v2 ? '  ' : '<<'
  console.log(
    `  ${r.id.padEnd(42)} ${r.mode.padEnd(10)} ${r.animated.padEnd(12)} ${r.queried.padEnd(8)} ` +
    `${VERDICT(r.spec)} ${VERDICT(r.v2)} ${VERDICT(r.v1)}${flag}`,
  )
}
console.log('')
for (const c of V1_FALSIFIERS) {
  const { byName } = buildDoc(EDGES)
  const scan = { hasAnimations: true, animationScope: v1Index(byName, c.targets) }
  const v1 = v1AnimationBlocks(scan, byName[c.el], c.mode)
  check(`negative control ${c.id}: d919614 released it (got ${v1}), spec requires a block`, v1 === false)
}
// Non-vacuity: the same predicate must still release the geometries the spec releases, so the
// assertions above are discriminating rather than a control that rejects everything.
for (const c of V1_OPPORTUNITIES) {
  const { byName } = buildDoc(EDGES)
  const scan = { hasAnimations: true, animationScope: v1Index(byName, c.targets) }
  const v1 = v1AnimationBlocks(scan, byName[c.el], c.mode)
  check(`negative control non-vacuity ${c.id}: v1 released it too (got ${v1})`, v1 === false)
}

// --- 3. fail-closed remains fail-closed ---------------------------------------
{
  const { doc, byName } = buildDoc(EDGES)
  const unattributable = buildAnimationScope(doc, [{ effect: null }, {}, { effect: {} }])
  check('null effect -> unresolvable', unattributable.unresolvable)
  for (const mode of ['self', 'inherited', 'subtree']) {
    check(`null effect blocks ${mode}`, animationBlocks({ hasAnimations: true, animationScope: unattributable }, byName.leaf0, mode))
  }
  const foreign = makeNode('foreign', null, { name: '#other' })
  check('foreign root -> unresolvable', buildAnimationScope(doc, [anim(foreign)]).unresolvable)
  const textNode = { nodeType: 3, parentElement: byName.root }
  check('non-element target -> unresolvable', buildAnimationScope(doc, [{ effect: { target: textNode } }]).unresolvable)
  check('no animation never blocks', !animationBlocks({ hasAnimations: false, animationScope: null }, byName.leaf0, 'inherited'))
  check('counterfactual null index blocks', animationBlocks({ hasAnimations: true, animationScope: null }, byName.leaf0, 'self'))
  check('empty target set releases', !animationBlocks({ hasAnimations: true, animationScope: buildAnimationScope(doc, []) }, byName.leaf0, 'inherited'))
}

// --- 4. the depth budget fails closed, it does not silently release -------------
{
  const edges = [['html', null]]
  let parent = 'html'
  for (let i = 0; i < 4000; i++) {
    edges.push(['n' + i, parent])
    parent = 'n' + i
  }
  const { doc, byName } = buildDoc(edges)
  const scan = { hasAnimations: true, animationScope: buildAnimationScope(doc, []) }
  check('depth-budget exhaustion fails closed', animationBlocks(scan, byName['n3999'], 'inherited') === true)
}

console.log(`R10-ANIM1 geometry check: ${CASES.length} spec cases (${blocked} blocked / ${released} released)` +
  ` + ${V1_FALSIFIERS.length} negative controls + fail-closed set`)
if (failures.length) {
  console.error(`${failures.length} FAILURES:`)
  for (const f of failures) console.error('  ' + f)
  process.exitCode = 1
} else {
  console.log('ALL PASS')
}