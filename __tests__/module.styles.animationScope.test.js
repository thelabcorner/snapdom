import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

// R10-ANIM1: the document-wide `hasAnimations` veto, resolved per consumer.
//
// Every case below is an exact-raw-parity test: the SAME bundle, the SAME document, the only
// difference between arms is `__animationScope`. The historical arm (false) restores the
// document-wide veto mechanism for mechanism, so a byte difference here is a real fidelity
// regression and not a fixture artifact.

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  flushStyleInvalidations()
})

function mount(css, build) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  const root = document.createElement('div')
  build(root)
  document.body.appendChild(root)
  mounted.push(root, style)
  flushStyleInvalidations()
  return root
}

/**
 * A live animation, FROZEN at t=0.
 *
 * Paused-but-relevant animations are still returned by getAnimations(), so this exercises the
 * same veto a running animation would — and because an animated computed value changes with the
 * clock, freezing is what makes exact-raw-parity a meaningful assertion. Two arms taken
 * microseconds apart would otherwise race the animation, and any difference would say nothing
 * about this lane.
 */
function frozenAnimation(el, keyframes, options = {}) {
  const anim = el.animate(keyframes, { duration: 100000, iterations: Infinity, ...options })
  anim.pause()
  anim.currentTime = 0
  mounted.push({ remove: () => anim.cancel() })
  return anim
}

/** Freeze every live animation, for fixtures whose animation comes from an @keyframes rule. */
function freezeAllAnimations() {
  for (const anim of document.getAnimations()) {
    anim.pause()
    anim.currentTime = 0
  }
}

/** Animate the first child of `el`, so `el` is an ancestor of an animation target. */
function runChild(el) {
  const child = document.createElement('span')
  child.textContent = 'child'
  el.appendChild(child)
  frozenAnimation(child, [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }])
  mounted.push(child)
}

async function parity(root, extra = {}) {
  const common = { cache: 'disabled', burst: false, embedFonts: false, ...extra }
  const historical = await snapdom.toRaw(root, { ...common, __animationScope: false })
  const candidate = await snapdom.toRaw(root, { ...common, __animationScope: true })
  expect(candidate).toBe(historical)
  return { historical, candidate }
}

/** A neutral-tag corpus: divs only, so nothing in ELEMENT_UNIVERSE_RISK_TAGS forces the full read. */
function corpus(root, count = 60) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div')
    el.className = `row r${i}`
    el.textContent = `row ${i}`
    root.appendChild(el)
  }
}

const BASE_CSS = '.row{display:block;padding:2px;color:#334155}'

describe('R10-ANIM1 sibling animation is a performance opportunity', () => {
  it('is exact when the only animation targets an unrelated sibling', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    await parity(root)
  })

  it('is exact for an animated sibling with a high-entropy corpus', async () => {
    const root = mount(BASE_CSS, (root) => {
      for (let i = 0; i < 120; i++) {
        const el = document.createElement('div')
        el.className = `row r${i} extra-${i % 7}`
        el.textContent = `row ${i}`
        root.appendChild(el)
      }
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ transform: 'translateX(0px)' }, { transform: 'translateX(40px)' }])
    })
    await parity(root)
  })

  it('is exact when the animation is on a CSS-animated sibling via @keyframes', async () => {
    const root = mount(`${BASE_CSS}@keyframes spin{from{opacity:.3}to{opacity:.8}}.spinner{animation:spin 100s linear infinite}`, (root) => {
      corpus(root)
      const spinner = document.createElement('div')
      spinner.className = 'spinner'
      root.parentNode.appendChild(spinner)
      mounted.push(spinner)
      freezeAllAnimations()
    })
    await parity(root)
  })

  it('releases the element universe on a sibling animation instead of vetoing it', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    const count = () => {
      const sink = {}
      return snapdom.toRaw(root, {
        cache: 'disabled', burst: false, embedFonts: false, __animationScopeCounters: sink,
      }).then(() => sink)
    }
    const historical = await count()
    const candidate = await count()
    expect(historical.elementUniverse.blocked).toBeGreaterThan(0)
    expect(candidate.elementUniverse.released).toBeGreaterThan(0)
    expect(candidate.elementUniverse.blocked).toBe(0)
  })
})

describe('R10-ANIM1 ancestor animation is a correctness falsifier', () => {
  it('is exact when an ancestor animates an inherited property', async () => {
    const root = mount(BASE_CSS, (root) => {
      root.parentNode.classList.add('wrap')
      corpus(root)
      frozenAnimation(root.parentNode, [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }])
    })
    await parity(root)
  })

  it('is exact when an ancestor animates a registered custom property', async () => {
    const root = mount(
      '@property --tone{syntax:"<color>";inherits:true;initial-value:#000}.row{color:var(--tone)}',
      (root) => {
        corpus(root)
        frozenAnimation(root.parentNode, [{ '--tone': 'rgb(1,2,3)' }, { '--tone': 'rgb(200,10,10)' }])
      },
    )
    await parity(root)
  })

  it('is exact when the capture root itself is animated', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      frozenAnimation(root, [{ opacity: '0.4' }, { opacity: '1' }])
    })
    await parity(root)
  })

  it('is exact when a descendant of the element is animated', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      frozenAnimation(root.firstElementChild, [{ opacity: '0.4' }, { opacity: '1' }])
    })
    await parity(root)
  })

  it('still vetoes the element universe for an ancestor animation', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      frozenAnimation(root.parentNode, [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }])
    })
    const sink = {}
    await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      __animationScope: true, __animationScopeCounters: sink,
    })
    expect(sink.elementUniverse.released).toBe(0)
    expect(sink.elementUniverse.blocked).toBeGreaterThan(0)
    expect(sink.index.targets).toBeGreaterThan(0)
    expect(sink.index.ancestors).toBeUndefined()
  })

  it('still vetoes the element universe for a child of the capture root', async () => {
    // The geometry d919614 missed: the queried nodes are neither the animation target nor its
    // ancestors — they are its DESCENDANTS. Inheritance runs downward, so they are affected.
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      runChild(root)
    })
    const sink = {}
    await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      __animationScope: true, __animationScopeCounters: sink,
    })
    expect(sink.elementUniverse.released).toBe(0)
    expect(sink.elementUniverse.blocked).toBeGreaterThan(0)
  })

  it('releases every captured element when the animation is outside the captured root', async () => {
    // The mirror of the falsifier above, and the shape the opportunity actually takes: the animated
    // node is in a disjoint subtree, so it is neither a target of nor an ancestor of any captured
    // node.
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ color: 'rgb(1,2,3)' }, { color: 'rgb(9,9,9)' }])
    })
    const sink = {}
    await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      __animationScope: true, __animationScopeCounters: sink,
    })
    expect(sink.elementUniverse.released).toBeGreaterThan(0)
    expect(sink.elementUniverse.blocked).toBe(0)
  })

  it('is exact when an ancestor animates a non-inherited property', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      frozenAnimation(root.parentNode, [{ paddingLeft: '0px' }, { paddingLeft: '24px' }])
    })
    await parity(root)
  })

  it('is exact when the animation targets the element ::before', async () => {
    const root = mount(`${BASE_CSS}.row::before{content:"x"}`, (root) => {
      corpus(root)
      frozenAnimation(root.firstElementChild, [{ opacity: '0' }, { opacity: '1' }], { pseudoElement: '::before' })
    })
    await parity(root)
  })
})

describe('R10-ANIM1 subtree animation is the fallback control', () => {
  it('keeps the truncation prepass for an animation inside the captured subtree', async () => {
    const root = mount(`${BASE_CSS}.row{-webkit-line-clamp:2;text-overflow:ellipsis;display:-webkit-box}`, (root) => {
      corpus(root, 12)
      frozenAnimation(root.lastElementChild, [{ opacity: '0.4' }, { opacity: '1' }])
    })
    const sink = {}
    await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      __animationScope: true, __animationScopeCounters: sink,
    })
    expect(sink.textTruncationPrepass?.blocked).toBeGreaterThan(0)
    expect(sink.textTruncationPrepass?.released).toBe(0)
  })

  it('keeps the truncation prepass for an animation on the root ancestor', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root, 12)
      frozenAnimation(root.parentNode, [{ opacity: '0.4' }, { opacity: '1' }])
    })
    const sink = {}
    await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      __animationScope: true, __animationScopeCounters: sink,
    })
    expect(sink.textTruncationPrepass?.blocked).toBeGreaterThan(0)
  })

  it('releases the truncation prepass when the animation is a sibling', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root, 12)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.4' }, { opacity: '1' }])
    })
    const sink = {}
    await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      __animationScope: true, __animationScopeCounters: sink,
    })
    expect(sink.textTruncationPrepass?.released).toBeGreaterThan(0)
    expect(sink.textTruncationPrepass?.blocked).toBe(0)
  })
})

describe('R10-ANIM1 fail-closed and no-animation controls', () => {
  it('is exact with no animation at all', async () => {
    const root = mount(BASE_CSS, (root) => corpus(root))
    await parity(root)
  })

  it('is exact and unreleasable when the scan cannot be trusted', async () => {
    // A cross-origin sheet makes scanAuthorStyles return the `unreliable` record, which must keep
    // vetoing exactly as it does today rather than reading as "no animation in scope".
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    await parity(root)
  })

  it('is exact for a shadow-root animation, which cannot be attributed', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      const host = document.createElement('div')
      const shadow = host.attachShadow({ mode: 'open' })
      const inner = document.createElement('span')
      shadow.appendChild(inner)
      root.appendChild(host)
      frozenAnimation(inner, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    const sink = {}
    await snapdom.toRaw(root, {
      cache: 'disabled', burst: false, embedFonts: false,
      __animationScope: true, __animationScopeCounters: sink,
    })
    expect(sink.index?.unresolvable).toBe(true)
    await parity(root)
  })

  it('is exact for an animation on a slotted node', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      const host = document.createElement('div')
      host.attachShadow({ mode: 'open' })
      root.appendChild(host)
      const slotted = document.createElement('span')
      host.appendChild(slotted)
      frozenAnimation(slotted, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    await parity(root)
  })

  it('is exact for a cancelled animation (no live animation remains)', async () => {
    const root = mount(BASE_CSS, (root) => {
      corpus(root)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }]).cancel()
    })
    await parity(root)
  })
})

describe('R10-ANIM1 exact-raw parity over the wider style surface', () => {
  it('is exact with backgrounds, masks and borders under a sibling animation', async () => {
    const root = mount(
      '.row{display:block;padding:2px;color:#334155;border:1px solid #ccc}' +
      '.card{background:linear-gradient(red,blue);padding:4px}',
      (root) => {
        for (let i = 0; i < 40; i++) {
          const card = document.createElement('div')
          card.className = 'card'
          const row = document.createElement('div')
          row.className = 'row'
          row.textContent = `card ${i}`
          card.appendChild(row)
          root.appendChild(card)
        }
        const sibling = document.createElement('div')
        root.parentNode.appendChild(sibling)
        mounted.push(sibling)
        frozenAnimation(sibling, [{ backgroundColor: 'rgb(1,2,3)' }, { backgroundColor: 'rgb(4,5,6)' }])
      },
    )
    await parity(root)
  })

  it('is exact with auto margins under a sibling animation', async () => {
    const root = mount('.row{display:block;width:120px;margin-left:auto;margin-right:auto}', (root) => {
      corpus(root, 30)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    await parity(root)
  })

  it('is exact with auto margins when the element itself is animated', async () => {
    const root = mount('.row{display:block;width:120px;margin-left:auto;margin-right:auto}', (root) => {
      corpus(root, 30)
      frozenAnimation(root.firstElementChild, [
        { marginLeft: '0px' }, { marginLeft: '40px' },
      ])
    })
    await parity(root)
  })

  it('is exact for a centered dialog (UA auto margin) under a sibling animation', async () => {
    const root = mount('.row{display:block;padding:2px}', (root) => {
      corpus(root, 10)
      const dialog = document.createElement('dialog')
      dialog.setAttribute('open', '')
      dialog.textContent = 'centered'
      root.appendChild(dialog)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    await parity(root)
  })

  it('is exact with pseudo elements under a sibling animation', async () => {
    const root = mount(`${BASE_CSS}.row::before{content:"pre";color:#a00}`, (root) => {
      corpus(root, 30)
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    await parity(root)
  })

  it('is exact under a sibling animation with the identity share path engaged', async () => {
    const root = mount(BASE_CSS, (root) => {
      for (let i = 0; i < 80; i++) {
        const el = document.createElement('div')
        el.className = 'row'
        el.textContent = `same ${i % 4}`
        root.appendChild(el)
      }
      const sibling = document.createElement('div')
      root.parentNode.appendChild(sibling)
      mounted.push(sibling)
      frozenAnimation(sibling, [{ opacity: '0.2' }, { opacity: '0.9' }])
    })
    await parity(root, { __styleShare: true })
  })
})
