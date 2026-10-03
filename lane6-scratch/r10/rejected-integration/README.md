# REJECTED — do not ship

These two files are the memo implementation that this audit built, measured against, and then
**reverted**. They are kept only as the record of what was attempted, so that a future attempt
starts from the finding instead of re-deriving it.

`src/` on `perf/v3-r10-icon-memo` is byte-identical to `c523ddb`. These copies are **not** wired
into anything; nothing imports them, and the filenames deliberately do not end in `.js` so no
linter, bundler, or test glob picks them up.

| File | What it was |
|---|---|
| `iconFonts.js.memo-attempt` | `materialIconToImage` / `ligatureIconToImage` with a capture-scoped memo, the pure-resolution split of `ensureLigatureCanvasFont`, and the font epoch |
| `fonts.js.memo-attempt` | `iconToImage` with the same memo |

## Why it was reverted

The key it used — `{text, familyMeasure, canvasFont, color, dpr, fontEpoch}` — is correct for the
canvas raster and **incomplete for the measurement**, and the two are coupled
(`canvas.width = ceil(rect.width) * dpr`).

The attempt asserted that capture scope made the key exact. That was the hand-wave: the
measuring span inherits live ambient CSS (`letter-spacing`, `text-transform`, `font-stretch`,
`font-size-adjust`, `writing-mode`, …), and an ancestor `transform` corrupts the returned
coordinates without being a property of the span at all. A host page can change those between two
icons in the same capture, under one store, at one font epoch.

See `docs/perf/RS_A10_ICON_RASTER_MEMO.md` §5 and the browser-free tests in
`__tests__/module.iconRaster.key.test.js`, which assert the aliasing.

## The one idea in here worth keeping

The memo tags an entry with the font epoch **read after the pixels are produced**, not the one read
at entry. A draw that had to load a face produces its pixels *after* the epoch bump, so the next
identical node hits that entry — the font load costs one extra raster, not one per remaining icon.
That reasoning is sound and is worth carrying into whatever eventually replaces this.