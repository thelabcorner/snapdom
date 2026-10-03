// Shadow-card fixtures and the read census they are measured with.
//
// What this measures and what it does NOT measure. Every number produced here is a CALL
// COUNT into browser CSSOM/selector APIs. A call count is not a wall time: the CSSOM cache,
// the JIT and the host runner all sit between one getPropertyValue and one nanosecond of
// real work. The standing lesson on this branch is that CSSOM-read deletions (SA2 gCS, the
// BRST scroll census, OFF1 offsets) moved no wall time on the standing fixtures. Any figure
// of the form "N times fewer reads" therefore describes the shape of the pipeline, never its
// duration, and the only admissible wall claim is a hosted A/B (lane6-scratch/r10-shadow).
//
// The census exists because the identity share CANNOT see inside a shadow root: those sheets
// are outside the document scan, so inlineAllStyles refuses every shadow node and pays a full
// computed-style read for it. That refusal is correct (see identityFor in src/modules/styles.js)
// and it is also why a page of shadow cards pays far more reads per node than the same page
// of light-DOM cards. The tests assert that ORDERING, not a magnitude, because a magnitude
// recorded on one engine is not a fact about another.

// Snapdom never clones a shadow root's own <style> child, and never inlines one
// (inlineAllStyles returns on source.tagName === 'STYLE' before any identity work), so the
// node census below skips it for the same reason.
const UNCENSUSED_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'META', 'TITLE'])

/** The read families the census counts. `typedOM` counts computedStyleMap acquisitions, not
 *  the per-property gets inside the returned map. */
export const READ_KEYS = ['getComputedStyle', 'getPropertyValue', 'matches', 'getRootNode', 'matchMedia', 'typedOM']

/** An empty collector for the share telemetry option (__styleShareCounters). */
export function newShareCounters() {
  return { identities: 0, outOfTree: 0, elementHits: 0, elementMisses: 0, pseudoHits: 0, pseudoMisses: 0 }
}

function newReadCounts() {
  const out = {}
  for (const key of READ_KEYS) out[key] = 0
  return out
}

/** Counts the elements a capture actually visits: the document tree (hosts and slotted
 *  children included, because both live in the document) and every open shadow root below it.
 *  Must run OUTSIDE a counted region: it calls getRootNode itself. */
export function treeNodeCounts(root) {
  const counts = { documentNodes: 0, shadowNodes: 0 }
  const walk = (parent, inShadow) => {
    for (const child of parent.children) {
      if (UNCENSUSED_TAGS.has(child.tagName)) continue
      if (inShadow) counts.shadowNodes++
      else counts.documentNodes++
      if (child.shadowRoot) walk(child.shadowRoot, true)
      walk(child, inShadow)
    }
  }
  if (root.getRootNode() !== root.ownerDocument) counts.shadowNodes++
  else counts.documentNodes++
  walk(root, root.getRootNode() !== root.ownerDocument)
  return counts
}

function installReadCounters(counts) {
  const restorers = []
  const bump = (key) => { counts[key]++ }
  const wrap = (owner, name, key) => {
    if (!owner) return
    const original = owner[name]
    if (typeof original !== 'function') return
    try {
      owner[name] = function (...args) { bump(key); return original.apply(this, args) }
      restorers.push(() => { try { owner[name] = original } catch { /* frozen in this engine */ } })
    } catch { /* non-writable in this engine: the family is simply uncounted */ }
  }
  const nativeGCS = window.getComputedStyle
  try {
    window.getComputedStyle = function (...args) { bump('getComputedStyle'); return nativeGCS.apply(this, args) }
    restorers.push(() => { window.getComputedStyle = nativeGCS })
  } catch { /* uncounted */ }
  wrap(CSSStyleDeclaration.prototype, 'getPropertyValue', 'getPropertyValue')
  wrap(Element.prototype, 'matches', 'matches')
  wrap(Node.prototype, 'getRootNode', 'getRootNode')
  wrap(window, 'matchMedia', 'matchMedia')
  if (Element.prototype.computedStyleMap) wrap(Element.prototype, 'computedStyleMap', 'typedOM')
  return () => { while (restorers.length) restorers.pop()() }
}

/** Build a fixture, run one capture with every read family counted, tear everything down.
 *  `capture(root, shareCounters)` returns whatever the caller wants kept (a payload string,
 *  a canvas). The share counters are handed in so a caller can pass them straight to snapdom
 *  as `__styleShareCounters`. */
export async function census(fixture, capture) {
  const share = newShareCounters()
  const reads = newReadCounts()
  const { root, dispose } = fixture.build()
  const nodes = treeNodeCounts(root)
  const restore = installReadCounters(reads)
  let kept
  try {
    kept = await capture(root, share)
  } finally {
    restore()
    dispose()
  }
  return { ...reads, share, nodes, kept }
}

const CARD_CSS = '.sc{display:block;width:110px;height:18px;margin:0;padding:0;background:rgb(0,0,255)}'
  + '.sc .t{display:block;width:100px;height:8px;background:rgb(255,255,255)}'
  + '.sc .v{display:block;width:100px;height:8px;background:rgb(128,128,128)}'

function sheet(cssText) {
  const el = document.createElement('style')
  el.textContent = cssText
  document.head.appendChild(el)
  return el
}

function adoptedSheet(cssText) {
  const s = new CSSStyleSheet()
  s.replaceSync(cssText)
  return s
}

function host(tag = 'div') {
  return document.createElement(tag)
}

/** N shadow roots whose internal structure and sheets are byte-identical: the shape a per-root
 *  identity partition could still share, because twins exist INSIDE each root and never across. */
function uniformShadowCards(roots = 6, perRoot = 4) {
  const style = sheet('.shadow-cards{width:700px;background:#fff}')
  const root = document.createElement('div')
  root.className = 'shadow-cards'
  for (let i = 0; i < roots; i++) {
    const h = host()
    const sr = h.attachShadow({ mode: 'open' })
    sr.innerHTML = `<style>:host{display:block}${CARD_CSS}</style>`
    for (let c = 0; c < perRoot; c++) {
      const card = document.createElement('div')
      card.className = 'sc'
      card.innerHTML = '<span class="t"></span><span class="v"></span>'
      sr.appendChild(card)
    }
    root.appendChild(h)
  }
  document.body.appendChild(root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

/** The same page with a per-card unique attribute: identity keys can no longer repeat. */
function heterogeneousShadowCards(roots = 6, perRoot = 4) {
  const style = sheet('.shadow-cards{width:700px;background:#fff}')
  const root = document.createElement('div')
  root.className = 'shadow-cards'
  for (let i = 0; i < roots; i++) {
    const h = host()
    const sr = h.attachShadow({ mode: 'open' })
    sr.innerHTML = `<style>:host{display:block}${CARD_CSS}</style>`
    for (let c = 0; c < perRoot; c++) {
      const card = document.createElement('div')
      card.className = 'sc'
      card.dataset.i = String(i * perRoot + c)
      card.innerHTML = '<span class="t"></span><span class="v"></span>'
      sr.appendChild(card)
    }
    root.appendChild(h)
  }
  document.body.appendChild(root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

/** Uniform cards whose rules live in adoptedStyleSheets instead of a cloned <style>: the
 *  capture can read the rules through CSSOM but never sees a sheet element to skip. */
function adoptedShadowCards(roots = 6, perRoot = 4) {
  const style = sheet('.shadow-cards{width:700px;background:#fff}')
  const root = document.createElement('div')
  root.className = 'shadow-cards'
  for (let i = 0; i < roots; i++) {
    const h = host()
    const sr = h.attachShadow({ mode: 'open' })
    sr.adoptedStyleSheets = [adoptedSheet(`:host{display:block}${CARD_CSS}`)]
    for (let c = 0; c < perRoot; c++) {
      const card = document.createElement('div')
      card.className = 'sc'
      card.innerHTML = '<span class="t"></span><span class="v"></span>'
      sr.appendChild(card)
    }
    root.appendChild(h)
  }
  document.body.appendChild(root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

/** #488's shape: identical hosts split by their OWN root's `:host(:not(:first-child))`. The
 *  document scan never reads that rule, so the hosts must stay unshareable. */
function hostSplitShadowCards() {
  const style = sheet('.host-split{display:flex;width:400px;background:#fff}')
  const root = document.createElement('div')
  root.className = 'host-split'
  for (let i = 0; i < 3; i++) {
    const h = host()
    const sr = h.attachShadow({ mode: 'open' })
    sr.innerHTML = `<style>:host{display:block;width:120px;height:20px}${CARD_CSS}`
      + ':host(:not(:first-child)){margin-left:8px;border-left:4px solid rgb(255,0,0)}</style>'
    for (let c = 0; c < 3; c++) {
      const card = document.createElement('div')
      card.className = 'sc'
      sr.appendChild(card)
    }
    root.appendChild(h)
  }
  document.body.appendChild(root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

/** `::slotted(:not(:first-child))` splitting light children of one host: those children live
 *  in the DOCUMENT tree, so only assignedSlot keeps them out of the share. */
function slottedSplitShadowCards(count = 4) {
  const style = sheet('.slotted-split{display:block;width:400px;background:#fff}')
  const root = document.createElement('div')
  root.className = 'slotted-split'
  const h = host()
  const sr = h.attachShadow({ mode: 'open' })
  sr.innerHTML = '<style>:host{display:flex}'
    + '::slotted(*){display:block;width:110px;height:18px;margin:0;padding:0;background:rgb(0,0,255)}'
    + '::slotted(:not(:first-child)){margin-left:8px;border-left:4px solid rgb(255,0,0)}</style><slot></slot>'
  for (let i = 0; i < count; i++) h.appendChild(document.createElement('div'))
  root.appendChild(h)
  document.body.appendChild(root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

/** Two roots, one identical subtree each, DIFFERENT pseudo-element declarations inside them.
 *  This is the cross-shadow-root oracle: the two subtrees are structural twins, and before the
 *  namespace fix both interned to the same id off the shared 'R' marker, so the second root's
 *  ::before was handed the first root's snapshot. */
function pseudoSplitShadowCards() {
  const style = sheet('.pseudo-split{display:flex;width:400px;background:#fff}')
  const root = document.createElement('div')
  root.className = 'pseudo-split'
  const tones = [['A', 'rgb(255,0,0)'], ['B', 'rgb(0,0,255)']]
  for (const [letter, color] of tones) {
    const h = host()
    const sr = h.attachShadow({ mode: 'open' })
    sr.innerHTML = '<style>:host{display:block;width:80px}'
      + `.psc::before{content:"${letter}";display:block;width:60px;height:20px;background:${color}}</style>`
      + '<div class="psc"></div>'
    root.appendChild(h)
  }
  document.body.appendChild(root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

/** The control: the same card shape with no shadow root anywhere. Sharing MUST fire here, so a
 *  fixture that reports no hits anywhere means the share was disabled, not that it had no work. */
function documentUniformCards(count = 24) {
  const style = sheet('.doc-cards{width:700px;background:#fff}'
    + '.doc-card{display:block;width:110px;height:18px;margin:0;padding:0;background:rgb(0,0,255)}')
  const root = document.createElement('div')
  root.className = 'doc-cards'
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div')
    card.className = 'doc-card'
    root.appendChild(card)
  }
  document.body.appendChild(root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}

export const SHADOW_FIXTURES = [
  { name: 'uniform-shadow-cards', needs: null, build: uniformShadowCards,
    covers: 'uniform shadow cards: twins exist inside each root, never across roots' },
  { name: 'heterogeneous-shadow-cards', needs: null, build: heterogeneousShadowCards,
    covers: 'heterogeneous shadow cards: a per-card attribute makes every identity unique' },
  { name: 'adopted-shadow-cards', needs: 'adoptedStyleSheets', build: adoptedShadowCards,
    covers: 'uniform shadow cards whose rules arrive through adoptedStyleSheets' },
  { name: 'host-split-shadow-cards', needs: null, build: hostSplitShadowCards,
    covers: ':host() splitting identical hosts from inside each root (#488)' },
  { name: 'slotted-split-shadow-cards', needs: null, build: slottedSplitShadowCards,
    covers: '::slotted() splitting document-tree children of one host (#488)' },
  { name: 'pseudo-split-shadow-cards', needs: null, build: pseudoSplitShadowCards,
    covers: 'pseudo-bearing shadow nodes in two roots whose ::before rules differ' },
  { name: 'document-uniform-cards', needs: null, build: documentUniformCards,
    covers: 'the light-DOM control: the share must fire here' },
]

export function fixtureByName(name) {
  const found = SHADOW_FIXTURES.find((fx) => fx.name === name)
  if (!found) throw new Error(`unknown shadow fixture: ${name}`)
  return found
}

/** Whether this engine exposes the API a fixture needs. */
export function fixtureSupported(fixture) {
  if (fixture.needs !== 'adoptedStyleSheets') return true
  return typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in ShadowRoot.prototype
}
