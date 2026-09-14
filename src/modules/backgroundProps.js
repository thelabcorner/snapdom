/**
 * Shared property contract between style snapshots and the background post-pass.
 *
 * `background.js` consumes these properties from a cached style snapshot. Element-level
 * universe narrowing must therefore retain the same properties whenever that consumer can
 * run; otherwise "absent from the snapshot" stops meaning "the document cannot depend on it".
 */

/** Props that can contain url(...) and may need inlining. */
export const URL_PROPS = [
  'background-image',
  'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image',
  'mask-source', 'mask-box-image-source', 'mask-border-source', '-webkit-mask-box-image-source',
  'border-image', 'border-image-source',
]

/** URL/source props checked by the snapshot's cheap "background pass has work" probe. */
export const BACKGROUND_INLINE_FLAG_PROPS = URL_PROPS.slice(1)

/** Mask longhands copied by the background post-pass for every flagged node. */
export const MASK_LAYOUT_PROPS = [
  'mask-position', 'mask-size', 'mask-repeat', 'mask-mode', 'mask-composite',
  '-webkit-mask-position', '-webkit-mask-size', '-webkit-mask-repeat', '-webkit-mask-composite',
  'mask-origin', 'mask-clip', '-webkit-mask-origin', '-webkit-mask-clip',
  '-webkit-mask-position-x', '-webkit-mask-position-y',
]

/** Background longhands copied when the node actually paints a background. */
export const BG_LAYOUT_PROPS = [
  'background-position', 'background-position-x', 'background-position-y',
  'background-size', 'background-repeat', 'background-origin', 'background-clip',
  'background-attachment', 'background-blend-mode',
]

/** Border-image auxiliaries copied when border-image is active. */
export const BORDER_AUX_PROPS = [
  'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat',
]
