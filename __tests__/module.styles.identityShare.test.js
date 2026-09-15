// The identity-share fast path (styles.js): one full style read per structural identity,
// per-node re-reads only for the layout-varying props. Fidelity is gated, and every gate
// here is asserted in PIXELS or in bytes — never on the flag itself.
import { describe, it, expect, afterEach } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'
import { bigTableHTML } from './category.libs.js'

const mounted = []
afterEach(() => { while (mounted.length) mounted.pop().remove() })

function mount(html, css) {
  if (css) {
    const st = document.createElement('style')
    st.textContent = css
    document.head.appendChild(st)
    mounted.push(st)
  }
  const el = document.createElement('div')
  // Sized to its content: a full-width block container would put the fractional sample
  // points into empty space beside the spans (the object-test trap, again).
  el.style.display = 'inline-block'
  el.innerHTML = html
  document.body.appendChild(el)
  mounted.push(el)
  return el
}

/** Drain pending mutation records (the mount itself queues some) and settle stamps. A
 *  capture whose assets phase runs while the MOUNT record is still pending trips
 *  needsBackgroundInline's conservative stamps-moved fallback, which inlines extra inert
 *  longhands — byte noise that is pixel-neutral, pre-existing, and ORDER-dependent (verified
 *  by swapping arm order: the asymmetry swaps with it). Settling makes byte comparison
 *  meaningful. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0))
  flushStyleInvalidations()
}

async function px(el, fx, fy, opts = {}) {
  const c = await snapdom.toCanvas(el, { embedFonts: false, scale: 1, dpr: 1, burst: false, ...opts })
  const d = c.getContext('2d').getImageData(
    Math.min(c.width - 1, Math.round(c.width * fx)),
    Math.min(c.height - 1, Math.round(c.height * fy)), 1, 1).data
  return `${d[0]},${d[1]},${d[2]}`
}

describe('identity share — the fast path itself', () => {
  it('produces a BYTE-identical payload to the full-read path', async () => {
    const el = document.createElement('div')
    el.style.cssText = 'width:640px;font-family:Arial,sans-serif;font-size:13px'
    el.innerHTML = bigTableHTML(120)
    document.body.appendChild(el)
    mounted.push(el)
    await settle()
    await snapdom.toRaw(el, { burst: false }) // warm: absorbs first-capture stamp churn
    await settle()
    const on = await snapdom.toRaw(el, { burst: false })
    await settle()
    const off = await snapdom.toRaw(el, { burst: false, __styleShare: false })
    expect(on).toBe(off)
  })

  it('does not collide attribute tuples containing the old identity delimiters', async () => {
    const el = mount(
      '<span class="identity-delim">a</span><span class="identity-delim" a="1" b="2">b</span>',
      '.identity-delim{display:block;color:rgb(0,0,255)} .identity-delim[b="2"]{color:rgb(255,0,0)}')
    const [a] = el.querySelectorAll('.identity-delim')
    // Make the first element's ONE attribute payload serialize exactly like the second element's
    // TWO old `name=value` parts joined by U+0001. If identity tuples are delimiter-concatenated,
    // these structurally different elements alias and the second can inherit the first snapshot.
    a.setAttribute('a', '1' + String.fromCharCode(1) + 'b=2')
    await settle()
    // Force the share so this regression test exercises the identity encoder itself rather than
    // depending on whatever unrelated stylesheet gates happen to exist in the test document.
    const on = await snapdom.toRaw(el, { burst: false, cache: 'disabled', __styleShare: true })
    await settle()
    const off = await snapdom.toRaw(el, { burst: false, cache: 'disabled', __styleShare: false })
    expect(on).toBe(off)
  })
})

describe('identity share — the gates, in pixels', () => {
  // Every scene below has two elements with IDENTICAL tag + attributes + chain that the
  // author CSS styles DIFFERENTLY. If the gate ever fails and the snapshot is shared, the
  // second element paints the first one's colour — which is exactly what each test would
  // catch.
  const BOX = 'display:inline-block;width:40px;height:40px'

  it(':nth-child differentiates identical siblings', async () => {
    const el = mount(
      '<span class="nth-g"></span><span class="nth-g"></span>',
      `.nth-g { ${BOX}; background: rgb(0,0,255) } .nth-g:nth-child(2) { background: rgb(255,0,0) }`)
    expect(await px(el, 0.2, 0.5)).toBe('0,0,255')
    expect(await px(el, 0.75, 0.5)).toBe('255,0,0')
  })

  it('sibling combinators differentiate identical siblings', async () => {
    const el = mount(
      '<span class="sib-g"></span><span class="sib-g"></span>',
      `.sib-g { ${BOX}; background: rgb(0,0,255) } .sib-g + .sib-g { background: rgb(255,0,0) }`)
    expect(await px(el, 0.75, 0.5)).toBe('255,0,0')
  })

  it(':has() differentiates by content', async () => {
    const el = mount(
      '<div class="has-g"><i></i></div><div class="has-g"></div>',
      `.has-g { ${BOX}; background: rgb(0,0,255) } .has-g:has(i) { background: rgb(255,0,0) }`)
    expect(await px(el, 0.2, 0.5)).toBe('255,0,0')
    expect(await px(el, 0.75, 0.5)).toBe('0,0,255')
  })

  it('the focused element keeps its focus styling', async () => {
    const el = mount(
      '<button class="foc-g">a</button><button class="foc-g">a</button>',
      `.foc-g { ${BOX}; border:0; background: rgb(0,0,255) } .foc-g:focus { background: rgb(255,0,0) }`)
    el.querySelectorAll('button')[1].focus()
    // Dominance, not equality: the UA focus ring blends over the button at some sample
    // points, so exact red is engine-dependent — red-vs-blue dominance is not.
    const [fr, , fb] = (await px(el, 0.75, 0.5)).split(',').map(Number)
    expect(fr).toBeGreaterThan(120)
    expect(fb).toBeLessThan(80)
    const [ur, , ub] = (await px(el, 0.2, 0.5)).split(',').map(Number)
    expect(ub).toBeGreaterThan(120)
    expect(ur).toBeLessThan(80)
  })

  it('@container rules differentiate twins by their container\'s size', async () => {
    // Same identity chain, containers of different widths: the rule paints only the wide
    // one. No selector here is structural, so only the scan's @container awareness can keep
    // the share from copying the narrow twin's blue onto the wide one.
    const el = mount(
      '<div class="cqg"><div class="cq"><div class="cqt"></div></div><div class="cq"><div class="cqt"></div></div></div>',
      `.cqg{display:grid;grid-template-columns:100px 300px} .cq{container-type:inline-size}
       .cqt{height:40px;background:rgb(0,0,255)} @container (min-width:200px){.cqt{background:rgb(255,0,0)}}`)
    expect(await px(el, 50 / 400, 0.5)).toBe('0,0,255')
    expect(await px(el, 250 / 400, 0.5)).toBe('255,0,0')
  })

  it('layout-varying values stay per-node even when the identity matches', async () => {
    // Identical identities, different content: the second cell is wider. A shared width
    // would squeeze or stretch one of them.
    const el = mount(
      '<table style="border-collapse:collapse"><tr>' +
      '<td style="padding:4px;background:rgb(0,0,255)">x</td>' +
      '<td style="padding:4px;background:rgb(255,0,0)">a much longer cell that stretches wide</td>' +
      '</tr></table>')
    await settle()
    await snapdom.toRaw(el, { burst: false })
    await settle()
    const raw = await snapdom.toRaw(el, { burst: false })
    await settle()
    const off = await snapdom.toRaw(el, { burst: false, __styleShare: false })
    expect(raw).toBe(off)
  })
})

describe('identity share — layout re-read narrowing', () => {
  // Twins under different-width parents: same identity chain (identical tags + attrs),
  // genuinely different used values wherever %-margins/paddings resolve. Grid columns give
  // the parents different widths without any structural-position SELECTOR (container
  // properties don't trip the share-unsafety scan — that asymmetry is exactly what the
  // re-read exists to cover).
  function twinFixture(twinCSS, inlineStyle = '') {
    return mount(
      `<div class="grid">
        <div class="col"><div class="twin"${inlineStyle ? ` style="${inlineStyle}"` : ''}><i>x</i></div></div>
        <div class="col"><div class="twin"${inlineStyle ? ` style="${inlineStyle}"` : ''}><i>x</i></div></div>
      </div>`,
      `.grid{display:grid;grid-template-columns:160px 320px;background:#dde}
       .col{background:#fff}
       .twin{height:24px;background:#c00}${twinCSS ? `.twin{${twinCSS}}` : ''}`
    )
  }

  // A capture of a borderless fixture emits no mutation records, so nothing moves the
  // per-element stamps between arms and the second arm would replay the first arm's
  // snapshotCache entries — byte-identical by tautology, proving nothing. Dirty the root
  // between arms so every arm genuinely re-resolves its styles.
  async function dirty(el) {
    el.setAttribute('data-probe-dirty', '1')
    el.removeAttribute('data-probe-dirty')
    await settle()
  }

  async function byteIdentical(el) {
    await settle()
    await snapdom.toRaw(el, { burst: false })
    await dirty(el)
    const on = await snapdom.toRaw(el, { burst: false })
    await dirty(el)
    const off = await snapdom.toRaw(el, { burst: false, __styleShare: false })
    expect(on).toBe(off)
  }

  it('author %-margins force the re-read: byte-identical to the full path', async () => {
    await byteIdentical(twinFixture('margin-left:10%'))
  })

  it('INLINE %-padding (no author rule) forces it through the identity attribute', async () => {
    await byteIdentical(twinFixture('', 'padding-left:12%'))
  })

  it('author %-offsets remain per-node used values', async () => {
    await byteIdentical(twinFixture('position:relative;top:10%'))
  })

  it('container-relative logical offsets remain per-node used values', async () => {
    await byteIdentical(twinFixture('position:relative;inset-inline-start:10cqw'))
  })

  it('INLINE relative offsets force the historical rider path', async () => {
    await byteIdentical(twinFixture('', 'position:relative;left:12%'))
  })

  it('fixed offsets on static twins skip per-twin CSSOM rereads and remain byte-identical', async () => {
    const el = twinFixture('top:14px;right:3px;bottom:auto;left:2rem')
    await settle()
    const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'getPropertyValue')
    const original = CSSStyleDeclaration.prototype.getPropertyValue
    const run = async (gate) => {
      let reads = 0
      Object.defineProperty(CSSStyleDeclaration.prototype, 'getPropertyValue', {
        ...desc,
        value(prop) {
          if (prop === 'top' || prop === 'right' || prop === 'bottom' || prop === 'left') reads++
          return original.apply(this, arguments)
        },
      })
      try {
        await dirty(el)
        const raw = await snapdom.toRaw(el, {
          burst: false,
          cache: 'disabled',
          __styleShare: true,
          __styleShareInsetValueGate: gate,
        })
        return { raw, reads }
      } finally {
        Object.defineProperty(CSSStyleDeclaration.prototype, 'getPropertyValue', desc)
      }
    }
    const historical = await run(false)
    const gated = await run(true)
    expect(gated.raw).toBe(historical.raw)
    expect(gated.reads).toBeLessThan(historical.reads)
  })

  it('positioned twins keep the historical offset riders even with no authored inset', async () => {
    const el = mount(
      `<div class="off-grid">
        <div class="off-host"><div class="off-twin">x</div></div>
        <div class="off-host"><div class="off-twin">x</div></div>
      </div>`,
      `.off-grid{display:grid;grid-template-columns:160px 320px}
       .off-host{position:relative;height:40px}
       .off-twin{position:absolute;width:20px;height:20px;background:#c00}`,
    )
    await settle()
    const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'getPropertyValue')
    const original = CSSStyleDeclaration.prototype.getPropertyValue
    const run = async (gate) => {
      let reads = 0
      Object.defineProperty(CSSStyleDeclaration.prototype, 'getPropertyValue', {
        ...desc,
        value(prop) {
          if (prop === 'top' || prop === 'right' || prop === 'bottom' || prop === 'left') reads++
          return original.apply(this, arguments)
        },
      })
      try {
        await dirty(el)
        const raw = await snapdom.toRaw(el, {
          burst: false,
          cache: 'disabled',
          __styleShare: true,
          __styleShareInsetValueGate: gate,
        })
        return { raw, reads }
      } finally {
        Object.defineProperty(CSSStyleDeclaration.prototype, 'getPropertyValue', desc)
      }
    }
    const historical = await run(false)
    const gated = await run(true)
    expect(gated.raw).toBe(historical.raw)
    expect(gated.reads).toBe(historical.reads)
  })

  it('min/max sizing props never re-read and never diverge', async () => {
    await byteIdentical(twinFixture('min-width:50%;max-width:90%'))
  })

  it('px margins skip the re-read without a byte of difference', async () => {
    await byteIdentical(twinFixture('margin-left:14px;padding:6px'))
  })

  it('grid track lists are used values: each grid twin keeps its own columns', async () => {
    // The deep-tree shape: twin `1fr 1fr` grids under 160px and 320px columns. Computed
    // style reports the USED tracks (`78px 78px` / `158px 158px`), so a shared list gives
    // the wide twin the narrow one's columns and its second cell ends at its midpoint.
    const el = mount(
      `<div class="gg">
        <div class="gcol"><div class="gtwin"><i></i><b></b></div></div>
        <div class="gcol"><div class="gtwin"><i></i><b></b></div></div>
      </div>`,
      `.gg{display:grid;grid-template-columns:160px 320px}
       .gtwin{display:grid;grid-template-columns:1fr 1fr;height:40px}
       .gtwin i{background:rgb(0,0,255)} .gtwin b{background:rgb(255,0,0)}`)
    expect(await px(el, 120 / 480, 0.5)).toBe('255,0,0') // narrow twin, second cell
    expect(await px(el, 200 / 480, 0.5)).toBe('0,0,255') // wide twin, first cell
    expect(await px(el, 448 / 480, 0.5)).toBe('255,0,0') // wide twin, right end of its second cell
  })

  it('a % translate resolves against each twin\'s own box', async () => {
    await byteIdentical(twinFixture('transform:translateX(50%)'))
  })

  it('logical sizes are used values, like width and height', async () => {
    await byteIdentical(twinFixture('inline-size:50%'))
  })

  it('keeps snapshot-key signatures distinct when only one twin gains a classic scrollbar gutter', async () => {
    const el = mount(
      `<div class="gutter-twin"><i class="short">x</i></div>
       <div class="gutter-twin"><i class="short">x</i></div>
       <div class="gutter-twin"><i class="tall">x</i></div>`,
      `.gutter-twin{display:block;width:120px;height:40px;overflow:auto;box-sizing:content-box}
       .short{display:block;height:10px}.tall{display:block;height:160px}`
    )
    const [a, b, c] = el.querySelectorAll('.gutter-twin')
    // Browser-mode CI uses overlay scrollbars on every engine, so the native geometry cannot
    // exercise #498's classic-gutter correction. Override ONLY the layout-box accessors that
    // addScrollbarGutter consumes: both twins keep identical computed styles, while the second
    // reports a 17px vertical scrollbar gutter. This deterministically reaches the same branch
    // as Windows/Linux classic scrollbars without changing style identity.
    // The first twin establishes the shared full snapshot. The second twin seeds the compact
    // shared-twin signature/cache entry with NO gutter. The third has the same pre-gutter style
    // values but gains a gutter after getSnapshot() has memoized that signature; that is the
    // collision sequence this regression is meant to pin.
    for (const [node, offsetWidth, clientWidth] of [[a, 120, 120], [b, 120, 120], [c, 137, 120]]) {
      Object.defineProperties(node, {
        offsetWidth: { configurable: true, get: () => offsetWidth },
        clientWidth: { configurable: true, get: () => clientWidth },
        offsetHeight: { configurable: true, get: () => 40 },
        clientHeight: { configurable: true, get: () => 40 },
      })
    }

    await settle()
    const shared = await snapdom.toRaw(el, { burst: false, cache: 'disabled' })
    await dirty(el)
    const full = await snapdom.toRaw(el, { burst: false, cache: 'disabled', __styleShare: false })
    expect(shared).toBe(full)
  })

  it('does not leak a first-twin classic scrollbar gutter into later twins', async () => {
    const el = mount(
      `<div class="gutter-first"><i>x</i></div>
       <div class="gutter-first"><i>x</i></div>
       <div class="gutter-first"><i>x</i></div>`,
      `.gutter-first{display:block;width:120px;height:40px;overflow:auto;box-sizing:content-box}
       .gutter-first>i{display:block;height:10px}`
    )
    const [a, b, c] = el.querySelectorAll('.gutter-first')
    for (const [node, offsetWidth, clientWidth] of [[a, 137, 120], [b, 120, 120], [c, 120, 120]]) {
      Object.defineProperties(node, {
        offsetWidth: { configurable: true, get: () => offsetWidth },
        clientWidth: { configurable: true, get: () => clientWidth },
        offsetHeight: { configurable: true, get: () => 40 },
        clientHeight: { configurable: true, get: () => 40 },
      })
    }

    await settle()
    const shared = await snapdom.toRaw(el, { burst: false, cache: 'disabled' })
    await dirty(el)
    const full = await snapdom.toRaw(el, { burst: false, cache: 'disabled', __styleShare: false })
    expect(shared).toBe(full)
  })

  it('does not compound a classic scrollbar gutter across repeated unchanged captures', async () => {
    const el = mount(
      '<div class="gutter-repeat"><i>x</i></div>',
      '.gutter-repeat{display:block;width:120px;height:40px;overflow:auto;box-sizing:content-box}' +
      '.gutter-repeat>i{display:block;height:10px}'
    )
    const node = el.querySelector('.gutter-repeat')
    Object.defineProperties(node, {
      offsetWidth: { configurable: true, get: () => 137 },
      clientWidth: { configurable: true, get: () => 120 },
      offsetHeight: { configurable: true, get: () => 40 },
      clientHeight: { configurable: true, get: () => 40 },
    })

    await settle()
    const first = await snapdom.toRaw(el, { burst: false, cache: 'disabled' })
    const second = await snapdom.toRaw(el, { burst: false, cache: 'disabled' })
    expect(second).toBe(first)
  })
})
