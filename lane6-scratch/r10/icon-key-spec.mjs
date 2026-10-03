/**
 * RS-A10 lane: the icon-raster key, specified — and the reason it cannot be shipped.
 *
 * This is an AUDIT artifact, not library code. It lives under lane6-scratch/ precisely so that
 * nothing here can reach `src/` and change shipped behaviour. `src/` on this branch is
 * byte-identical to c523ddb; see docs/perf/RS_A10_ICON_RASTER_MEMO.md for the verdict.
 *
 * ── What the two draw sites actually cost ───────────────────────────────────────────────────
 * At c523ddb, per call, `materialIconToImage` (src/modules/iconFonts.js:262) and `iconToImage`
 * (src/modules/fonts.js:41) each perform:
 *   1. a `document.fonts` await — `load()` + `ready` for the ligature path, `ready` alone for
 *      the pseudo path;
 *   2. `document.body.appendChild(span)`;
 *   3. `span.getBoundingClientRect()` — a FORCED SYNCHRONOUS LAYOUT of the whole document,
 *      taken immediately after that append dirtied it;
 *   4. `document.body.removeChild(span)`;
 *   5. `canvas.toDataURL()` — a PNG encode.
 * Neither memoizes, and both callers loop serially (`ligatureIconToImage` iconFonts.js:366,
 * the pseudo pass pseudo.js:955), so N icons pay N of all five.
 *
 * ── The candidate key ─────────────────────────────────────────────────────────────────────
 * `iconRasterKey` below is the minimal pure key over everything the draw READS EXPLICITLY.
 * It is correct for the canvas raster and INCOMPLETE for the measurement, and the split is the
 * whole finding:
 *
 *   raster inputs   = text, ctx.font, fillStyle, dpr, canvas.width/height, font state
 *   measure inputs  = the above PLUS every metric-affecting property of a live <span> in the
 *                     host document that the icon path never sets or reads
 *
 * The two are COUPLED, not independent: `canvas.width = ceil(rect.width) * dpr`. So the
 * measurement is an input to the raster bytes. Memoizing the pair requires the measurement, and
 * the measurement cannot be derived from the key (see AMBIENT_MEASUREMENT_INPUTS).
 *
 * ── Why this is NO-GO rather than merely unproven ─────────────────────────────────────────
 * AMBIENT_MEASUREMENT_INPUTS lists the inherited and ambient properties that reach
 * `getBoundingClientRect()`. Each is inherited from, or selected onto, a LIVE document that the
 * capture does not own and does not observe. Two of them are independently fatal to the "just
 * key on the span's computed style" repair:
 *
 *   - `transform` / `zoom` on any ancestor. `getBoundingClientRect()` returns coordinates in the
 *     visual space AFTER ancestor transforms, so `body { transform: scale(2) }` doubles both
 *     reported dimensions. This is not a property OF THE SPAN, so no span-derived key can
 *     contain it — not a whole-computed-style serialization, not a property allow-list.
 *   - whether any author rule matches the bare <span> at all. The span has no class, id, or
 *     attribute, so `span {}`, `* {}` and `body > span {}` all match it. Deciding that none
 *     does requires reading every stylesheet, and that is undecidable in general: `cssRules()`
 *     throws on a cross-origin sheet, `@layer`/`::where()` nest arbitrarily, an `!important`
 *     declaration beats the inline styles the icon path sets, and a sheet can be inserted
 *     between two icons in the same capture.
 *
 * The residual is therefore not "small enough to accept" — it is not expressible as a key at
 * any price. The only sound memo is one that still performs the measurement, and that saves only
 * the PNG encode (keying on the measured rect), which is the cheapest of the five costs. Ship
 * nothing; see the doc for the ceiling the hosted probe measures.
 *
 * Pure module: no DOM, no globals. Callable under `environment: 'node'`.
 * @module icon-key-spec
 */

/** Field separator. Never produced by `encodePart`, so a key cannot be forged by input. */
const SEP = '\u0001'

/**
 * Length-prefix a key field. Injective by construction: no field can contain the separator, so
 * no two different part lists encode to the same string. Families, colors and ligature text are
 * page-controlled, so a delimiter-join alone would be a collision bug waiting for a family name
 * containing U+0001.
 * @param {string|number} value
 * @returns {string}
 */
function encodePart(value) {
  const s = String(value)
  return s.length + ':' + s
}

/**
 * The exact `ctx.font` string a draw site assigns.
 *
 * Derived once, next to the key, so the key is built from the string that is rasterized rather
 * than from the inputs the caller happened to pass. This matters at c523ddb: the ligature path
 * emits `${weight} ` only when `weight` is truthy (iconFonts.js:311), so `weight: 'normal'` and
 * `weight: ''` yield `normal 24px X` and `24px X` — different strings that may rasterize
 * differently. A key built from "the resolved weight" would have merged them.
 *
 * @param {object} parts
 * @param {string} parts.family - family exactly as it appears in the canvas font string
 * @param {string|number} [parts.weight=''] - emitted only when truthy (ligature path)
 * @param {string|number} [parts.style=''] - emitted first when non-empty (pseudo path)
 * @param {number} parts.size - CSS px
 * @returns {string}
 */
export function canvasFontString({ family, weight = '', style = '', size }) {
  return `${style ? `${style} ` : ''}${weight ? `${weight} ` : ''}${size}px ${family}`
}

/**
 * Build the key over the inputs the draw reads EXPLICITLY.
 *
 * Every field maps to something the draw touches:
 *  - `text`          what `fillText` paints
 *  - `familyMeasure` the measuring span's `font-family`, which sets the reported box
 *  - `canvasFont`    the canvas font string, from `canvasFontString`
 *  - `color`         `ctx.fillStyle`
 *  - `dpr`           canvas backing size and `ctx.scale`, so it changes the bytes
 *  - `fontEpoch`     the only FontFaceSet mutation this lane can observe (`document.fonts.add`
 *                    in `ensureLigatureCanvasFont`, iconFonts.js:205)
 *
 * Known-NOT-closed: every entry of AMBIENT_MEASUREMENT_INPUTS. This function is a SPECIFICATION
 * of the closed subset and a demonstration that the open subset is invisible to it. It is not a
 * memo key: `__tests__/module.iconRaster.key.test.js` asserts the aliasing rather than hiding it.
 *
 * @param {object} parts
 * @param {string} parts.text
 * @param {string} parts.familyMeasure
 * @param {string} parts.canvasFont
 * @param {string} parts.color
 * @param {number} parts.dpr
 * @param {number} parts.fontEpoch
 * @returns {string}
 */
export function iconRasterKey({ text, familyMeasure, canvasFont, color, dpr, fontEpoch }) {
  return encodePart(fontEpoch) + SEP +
    encodePart(text) + SEP +
    encodePart(familyMeasure) + SEP +
    encodePart(canvasFont) + SEP +
    encodePart(color) + SEP +
    encodePart(dpr)
}

/**
 * Metric-affecting inputs to `getBoundingClientRect()` on the measuring span that the icon path
 * neither sets inline nor reads. The span is a bare `<span>` (no class, id, or attribute)
 * appended to `document.body`, so every one of these is either inherited from the live document
 * or selected onto the span directly.
 *
 * Recorded as DATA, not prose, so the adversarial tests can iterate exactly the set this
 * analysis claims — the claim is then falsifiable by adding a row.
 *
 * `scope` is the honest reach of each row:
 *  - 'inherited'  arrives via inheritance from document.body / documentElement
 *  - 'selected'   matches the bare span through some author selector (undecidable whether it does)
 *  - 'ancestor'   lives on an ancestor and corrupts the returned coordinates rather than the
 *                 span's own box — provably outside any span-derived key
 *
 * @type {ReadonlyArray<{property: string, scope: string, affects: ('width'|'height'|'both')[], note: string}>}
 */
export const AMBIENT_MEASUREMENT_INPUTS = Object.freeze([
  { property: 'letter-spacing', scope: 'inherited', affects: ['width'], note: 'adds a constant per gap, so it moves the reported width directly' },
  { property: 'word-spacing', scope: 'inherited', affects: ['width'], note: 'same, for the space advance' },
  { property: 'text-transform', scope: 'inherited', affects: ['width'], note: 'uppercase/lowercase widen the run; the canvas applies no text-transform, so the span and the canvas already disagree here at c523ddb' },
  { property: 'font-stretch', scope: 'inherited', affects: ['width'], note: 'selects a different face width' },
  { property: 'font-size-adjust', scope: 'inherited', affects: ['width', 'height'], note: 'rescales the used font-size against the x-height metric' },
  { property: 'font-kerning', scope: 'inherited', affects: ['width'], note: 'pairwise advance adjustments' },
  { property: 'font-optical-sizing', scope: 'inherited', affects: ['width'], note: 'a different optical-size face for the same nominal size' },
  { property: 'text-indent', scope: 'inherited', affects: ['width'], note: 'shifts the inline content start' },
  { property: 'direction', scope: 'inherited', affects: ['width'], note: 'inline run direction' },
  { property: 'writing-mode', scope: 'inherited', affects: ['width', 'height'], note: 'swaps the inline and block axes of the reported rect' },
  { property: 'font-variant-numeric', scope: 'inherited', affects: ['width'], note: 'not overridden on the iconToImage span' },
  { property: 'font-variant-east-asian', scope: 'inherited', affects: ['width'], note: 'not overridden on the iconToImage span' },
  { property: 'font-variant-caps', scope: 'inherited', affects: ['width'], note: 'not overridden on the iconToImage span' },
  { property: 'text-rendering', scope: 'inherited', affects: ['width', 'height'], note: 'engine-dependent metric nudges' },
  { property: 'display', scope: 'selected', affects: ['width', 'height'], note: 'a bare span defaults to inline; `span{display:block}` or `:flex` changes the box' },
  { property: '(any author rule matching `span`)', scope: 'selected', affects: ['width', 'height'], note: 'the span has no class/id/attribute, so `span{}`, `*{}` and `body>span{}` all match; undecidable, and `!important` beats the inline styles' },
  { property: 'transform', scope: 'ancestor', affects: ['width', 'height'], note: 'FATAL: getBoundingClientRect returns post-transform coordinates, so `body{transform:scale(2)}` doubles both. Not a property of the span, so no span-derived key can hold it' },
  { property: 'zoom', scope: 'ancestor', affects: ['width', 'height'], note: 'FATAL for the same reason as transform' },
  { property: 'font-face availability / unicode-range', scope: 'inherited', affects: ['width', 'height'], note: 'which face actually matched; only this lane\'s own document.fonts.add is observed, never a host webfont finishing' },
])

/**
 * `'FILL' 1, 'wght' 400` -> `{ FILL: 1, WGHT: 400 }`. Axis tags are upper-cased.
 *
 * Extracted verbatim from iconFonts.js:134 so the lane can reason about FILL without importing
 * the module (which pulls in DOM-touching siblings).
 * @param {string} [variation]
 * @returns {Record<string, number>}
 */
export function parseAxes(variation = '') {
  const out = Object.create(null)
  const v = String(variation || '')
  const rx = /['"]?\s*([A-Za-z]{3,4})\s*['"]?\s*([+-]?\d+(?:\.\d+)?)\s*/g
  let m; while ((m = rx.exec(v))) out[m[1].toUpperCase()] = Number(m[2])
  return out
}

/**
 * Decide, WITHOUT touching the DOM, which family the canvas would draw a ligature with — the
 * decision half of `ensureLigatureCanvasFont` (iconFonts.js:155), split out so the key COULD be
 * computed before any await.
 *
 * Material Icons (legacy, non-variable) and every non-Material family stay as they are. Material
 * Symbols is variable and a canvas font string carries no `font-variation-settings`, so a
 * Symbols icon at FILL=1 would draw hollow; for that case a static filled face is wanted under a
 * snapdom alias, matched to the style keyword in the class list. With FILL=0, or with no static
 * face for that style, the original Symbols family stays.
 *
 * `face === null` means no font load will be attempted, i.e. the family pair is fully determined
 * before any await — the property the memo needed and could not otherwise have had.
 *
 * @param {string} family - the node's computed `font-family`
 * @param {string} [className] - where Material Symbols puts the style keyword
 * @param {string} [variation] - `font-variation-settings`, read for the FILL axis
 * @param {Record<string, string>} [urls] - static face URLs; injected so this stays pure
 * @returns {{kind: 'as-is'|'static-face', familyForMeasure: string, familyForCanvas: string,
 *            face: {url: string, alias: string}|null}}
 */
export function resolveLigatureTarget(family, className, variation, urls = {}) {
  const fam = String(family || '')
  const lowerFam = fam.toLowerCase()
  const cls = String(className || '').toLowerCase()

  const asIs = { kind: 'as-is', familyForMeasure: fam, familyForCanvas: fam, face: null }

  if (/\bmaterial\s*icons\b/.test(lowerFam) && !/\bsymbols\b/.test(lowerFam)) return asIs
  if (!/\bmaterial\s*symbols\b/.test(lowerFam)) return asIs

  const axes = parseAxes(variation)
  const FILL = axes.FILL ?? axes.fill
  let style = 'outlined'
  if (/\brounded\b/.test(cls) || /\bround\b/.test(cls)) style = 'rounded'
  else if (/\bsharp\b/.test(cls)) style = 'sharp'
  else if (/\boutlined\b/.test(cls)) style = 'outlined'

  let face = null
  if (FILL === 1) {
    if (style === 'outlined' && urls.materialIconsFilled) {
      face = { url: urls.materialIconsFilled, alias: 'snapdom-mi-filled' }
    } else if (style === 'rounded' && urls.materialIconsRound) {
      face = { url: urls.materialIconsRound, alias: 'snapdom-mi-round' }
    } else if (style === 'sharp' && urls.materialIconsSharp) {
      face = { url: urls.materialIconsSharp, alias: 'snapdom-mi-sharp' }
    }
  }
  if (!face) return asIs

  const quoted = `"${face.alias}"`
  return { kind: 'static-face', familyForMeasure: quoted, familyForCanvas: quoted, face }
}