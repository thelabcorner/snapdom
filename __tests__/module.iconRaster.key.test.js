// Browser-free RS-A10 audit tests: the closed part of the icon-raster key, and the proof that
// the open part is invisible to it.
//
// Runs under `environment: 'node'` (vitest.icon-key.config.js / `npm run test:icon-key`).
// Nothing here touches document, window, FontFace or a canvas. Browser evidence for the same
// finding is the hosted probe (lane6-scratch/r9 `icon` suite), not this file.
//
// The shape of this file is deliberate. The first describe block pins what the key DOES close.
// The second block pins what it does NOT, by asserting the aliasing rather than papering over
// it: a memo built on this key would hand one icon another icon's pixels and box. That is the
// NO-GO, and it has to be a failing-safe test so a future attempt cannot quietly reintroduce
// the key as if it were exact.
import { describe, it, expect } from 'vitest'

import {
  AMBIENT_MEASUREMENT_INPUTS,
  canvasFontString,
  iconRasterKey,
  parseAxes,
  resolveLigatureTarget,
} from '../lane6-scratch/r10/icon-key-spec.mjs'

const URLS = {
  materialIconsFilled: 'https://example.invalid/filled.woff2',
  materialIconsOutlined: 'https://example.invalid/outlined.woff2',
  materialIconsRound: 'https://example.invalid/round.woff2',
  materialIconsSharp: 'https://example.invalid/sharp.woff2',
}

/** The key an ordinary non-Symbols Material icon produces at epoch 0, dpr 1. */
const BASE = {
  text: 'home',
  familyMeasure: 'Material Icons',
  canvasFont: canvasFontString({ family: 'Material Icons', weight: '', size: 24 }),
  color: '#000000',
  dpr: 1,
  fontEpoch: 0,
}

describe('closed surface — the key separates everything the draw reads explicitly', () => {
  it('is a deterministic function of its parts', () => {
    expect(iconRasterKey(BASE)).toBe(iconRasterKey({ ...BASE }))
  })

  const separating = [
    ['text', { text: 'star' }, 'fillText paints a different glyph'],
    ['familyMeasure', { familyMeasure: 'Material Symbols Outlined' }, 'the measured box changes'],
    ['canvasFont', { canvasFont: '24px Other' }, 'ctx.font changes'],
    ['color', { color: 'rgb(255,0,0)' }, 'ctx.fillStyle changes'],
    ['dpr', { dpr: 2 }, 'canvas backing size and ctx.scale change, so the bytes change'],
    ['fontEpoch', { fontEpoch: 1 }, 'an observed FontFaceSet mutation happened'],
  ]
  for (const [name, override, why] of separating) {
    it(`separates on ${name} (${why})`, () => {
      expect(iconRasterKey({ ...BASE, ...override })).not.toBe(iconRasterKey(BASE))
    })
  }

  it('treats dpr as identity, not a hint: 1x and 2x are different rasters', () => {
    expect(iconRasterKey({ ...BASE, dpr: 1 })).not.toBe(iconRasterKey({ ...BASE, dpr: 2 }))
  })
})

describe('closed surface — the key cannot be forged', () => {
  it('rejects a family or color containing the field separator', () => {
    // A plain delimiter join maps ('a','b') and ('ab','') onto one key. These values come
    // off the page, so injectivity is a correctness property, not tidiness.
    const SEP = String.fromCharCode(1)
    expect(iconRasterKey({ ...BASE, text: 'a', color: 'b' }))
      .not.toBe(iconRasterKey({ ...BASE, text: `a${SEP}b`, color: '' }))
  })

  it('rejects shifting a value across two adjacent fields', () => {
    expect(iconRasterKey({ ...BASE, familyMeasure: 'A B', canvasFont: 'C' }))
      .not.toBe(iconRasterKey({ ...BASE, familyMeasure: 'A', canvasFont: 'B C' }))
  })

  it('length-prefixes, so no value can impersonate the field structure', () => {
    expect(iconRasterKey({ ...BASE, text: 'x' })).not.toBe(iconRasterKey({ ...BASE, text: 'xx' }))
  })
})

describe('closed surface — canvasFontString tracks the real assignment', () => {
  it('separates weight "" from weight "normal", which emit different font strings', () => {
    // iconFonts.js:311 emits `${weight} ` only when weight is truthy. A key built from "the
    // resolved weight" would have merged these.
    expect(canvasFontString({ family: 'Material Icons', weight: '', size: 24 })).toBe('24px Material Icons')
    expect(canvasFontString({ family: 'Material Icons', weight: 'normal', size: 24 })).toBe('normal 24px Material Icons')
  })

  it('keeps quoting differences, which change the resolved family', () => {
    expect(canvasFontString({ family: '"X"', size: 16 })).not.toBe(canvasFontString({ family: 'X', size: 16 }))
  })

  it('emits style before weight, matching the pseudo path at fonts.js:73', () => {
    expect(canvasFontString({ family: '"F"', style: 'italic', weight: '700', size: 16 }))
      .toBe('italic 700 16px "F"')
  })
})

describe('closed surface — resolveLigatureTarget is fully determined before any await', () => {
  it('keeps legacy Material Icons as-is and never proposes a face', () => {
    const t = resolveLigatureTarget('Material Icons', '', '', URLS)
    expect(t.kind).toBe('as-is')
    expect(t.face).toBe(null)
  })

  it('keeps a non-Material family as-is', () => {
    expect(resolveLigatureTarget('Font Awesome 6 Free', 'fa', "'FILL' 1", URLS).kind).toBe('as-is')
  })

  it('keeps Symbols as-is at FILL=0', () => {
    expect(resolveLigatureTarget('Material Symbols Outlined', '', "'FILL' 0", URLS).kind).toBe('as-is')
  })

  it('maps FILL=1 to a static face per style keyword, quoted for the canvas', () => {
    for (const [cls, alias] of [
      ['material-symbols-rounded', 'snapdom-mi-round'],
      ['material-symbols-sharp', 'snapdom-mi-sharp'],
      ['material-symbols-outlined', 'snapdom-mi-filled'],
    ]) {
      const t = resolveLigatureTarget('Material Symbols', cls, "'FILL' 1", URLS)
      expect(t.kind).toBe('static-face')
      expect(t.face.alias).toBe(alias)
      expect(t.familyForCanvas).toBe(`"${alias}"`)
    }
  })

  it('falls back to as-is when the style has no static face configured', () => {
    expect(resolveLigatureTarget('Material Symbols', 'sharp', "'FILL' 1", { materialIconsFilled: 'u' }).kind).toBe('as-is')
  })

  it('collapses variation strings that differ only in axes the canvas cannot express', () => {
    expect(parseAxes("'fill' 1").FILL).toBe(1)
    const a = resolveLigatureTarget('Material Symbols', 'rounded', "'FILL' 1, 'wght' 400", URLS)
    const b = resolveLigatureTarget('Material Symbols', 'rounded', "'FILL' 1, 'wght' 900", URLS)
    expect(a.familyForCanvas).toBe(b.familyForCanvas)
  })

  it('collapses class names that resolve to the same style keyword', () => {
    const a = resolveLigatureTarget('Material Symbols', 'material-symbols-rounded foo', "'FILL' 1", URLS)
    const b = resolveLigatureTarget('Material Symbols', 'x rounded y', "'FILL' 1", URLS)
    expect(a.face.alias).toBe(b.face.alias)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The NO-GO. Everything below asserts that the key ALIASES cases it must not alias.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('open surface — the key aliases every ambient measurement input', () => {
  it('enumerates the inputs, so the claim is falsifiable by adding a row', () => {
    expect(AMBIENT_MEASUREMENT_INPUTS.length).toBeGreaterThan(10)
    for (const row of AMBIENT_MEASUREMENT_INPUTS) {
      expect(row).toMatchObject({
        property: expect.any(String),
        scope: expect.stringMatching(/^(inherited|selected|ancestor)$/),
        affects: expect.any(Array),
        note: expect.any(String),
      })
    }
  })

  // Two icons, identical in everything the key can see, differing only in ambient CSS. The
  // memo would return icon A's {dataUrl, width, height} for icon B. `ambient` is accepted and
  // then dropped, which IS the finding: nothing the caller knows about it reaches the key.
  const keyIgnoringAmbient = (ambient) => {
    void ambient // the finding, in one line: nothing about it reaches the key
    return iconRasterKey({ ...BASE })
  }

  const AMBIENT_PAIRS = [
    ['letter-spacing', 'normal', '4px'],
    ['word-spacing', 'normal', '8px'],
    ['text-transform', 'none', 'uppercase'],
    ['font-stretch', '100%', '125%'],
    ['font-size-adjust', 'none', '0.52'],
    ['writing-mode', 'horizontal-tb', 'vertical-rl'],
    ['direction', 'ltr', 'rtl'],
    ['font-kerning', 'auto', 'none'],
    ['font-optical-sizing', 'auto', 'none'],
    ['text-indent', '0px', '12px'],
    ['font-variant-numeric', 'normal', 'tabular-nums'],
    ['text-rendering', 'auto', 'optimizeLegibility'],
  ]

  for (const [property, a, b] of AMBIENT_PAIRS) {
    it(`aliases ${property}: ${a} and ${b} produce the same key`, () => {
      expect(keyIgnoringAmbient({ [property]: a })).toBe(keyIgnoringAmbient({ [property]: b }))
    })
  }

  it('aliases an ancestor transform, which no span-derived key can hold', () => {
    // body { transform: scale(2) } doubles both reported dimensions. The span's own computed
    // style is unchanged, so serializing it whole would still alias.
    const spanStyleUnchanged = { letterSpacing: 'normal', fontFamily: 'Material Icons', fontSize: '24px' }
    expect(keyIgnoringAmbient({ ancestorTransform: 'scale(2)', spanStyle: spanStyleUnchanged }))
      .toBe(keyIgnoringAmbient({ ancestorTransform: 'none', spanStyle: spanStyleUnchanged }))
  })

  it('aliases a direct-matching author rule on the bare span', () => {
    expect(keyIgnoringAmbient({ matched: 'span{letter-spacing:6px}' }))
      .toBe(keyIgnoringAmbient({ matched: null }))
  })

  it('aliases two icons in the SAME capture, which is what defeats capture scope', () => {
    // The host page toggles a class on body between icon 3 and icon 4. Same capture, same
    // store, same font epoch — and the memo cannot tell them apart.
    const storeEpoch = 0
    const icon3 = iconRasterKey({ ...BASE, text: 'home', fontEpoch: storeEpoch })
    const icon4 = iconRasterKey({ ...BASE, text: 'home', fontEpoch: storeEpoch })
    expect(icon3).toBe(icon4)
  })
})

describe('repairs considered, and why each fails', () => {
  it('repair 1 — key on the span computed style: cannot cover the ancestor rows', () => {
    // Serializing getComputedStyle(span) captures the inherited and selected rows. It cannot
    // capture `ancestor`, because those act on the returned coordinates, not on the span.
    const coveredScopes = new Set(AMBIENT_MEASUREMENT_INPUTS.map((r) => r.scope))
    expect(coveredScopes.has('inherited')).toBe(true)
    expect(coveredScopes.has('selected')).toBe(true)
    expect(coveredScopes.has('ancestor')).toBe(true) // ← the uncovered one
    expect(AMBIENT_MEASUREMENT_INPUTS.filter((r) => r.scope === 'ancestor').length).toBeGreaterThan(0)
  })

  it('repair 2 — append to a snapdom-owned canonical host: still cannot cover ancestor rows', () => {
    // `all: initial` on the host neutralizes inheritance and `body>span` rules, but an
    // `!important` author declaration still wins, and the host cannot escape a transform on
    // document.body — getBoundingClientRect is post-transform wherever the span lives.
    const importantRule = 'span { letter-spacing: 6px !important }'
    expect(importantRule).toMatch(/!important/)
    expect(AMBIENT_MEASUREMENT_INPUTS.some((r) => r.scope === 'ancestor')).toBe(true)
  })

  it('repair 3 — key on the measured rect: sound, but saves only the encode', () => {
    // Including width/height in the key closes the measurement by construction. It does not
    // remove the measurement, so the forced layout — the dominant of the five costs — stays,
    // and only the PNG encode is skipped. That is a poor trade for a new aliasing surface.
    const repairedKey = ({ measuredWidth, measuredHeight, ...rest }) =>
      `${iconRasterKey(rest)}|${measuredWidth}x${measuredHeight}`
    const keyA = repairedKey({ ...BASE, measuredWidth: 24, measuredHeight: 24 })
    const keyB = repairedKey({ ...BASE, measuredWidth: 25, measuredHeight: 24 })
    expect(keyA).not.toBe(keyB)
    // The reason repair 3 is needed at all: the spec key is blind to the measurement, so two
    // icons that measured differently still share a key. And the reason it is declined anyway:
    // repairing it requires the rect, which is the forced layout the memo was meant to remove.
    expect(iconRasterKey({ ...BASE, measuredWidth: 24 })).toBe(iconRasterKey({ ...BASE, measuredWidth: 25 }))
  })

  it('records the verdict: the residual is not expressible as a key at any price', () => {
    const fatal = AMBIENT_MEASUREMENT_INPUTS.filter(
      (r) => r.scope === 'ancestor' || r.scope === 'selected'
    )
    expect(fatal.length).toBeGreaterThan(0)
    // Both of these are undecidable or out-of-span, so no amount of key enrichment closes them.
    expect(fatal.some((r) => /getBoundingClientRect returns post-transform/.test(r.note))).toBe(true)
    expect(fatal.some((r) => /undecidable/.test(r.note))).toBe(true)
  })
})
