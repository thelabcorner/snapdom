/**
 * Scale an already percent-encoded snapDOM SVG data URL by changing ONLY the
 * root element's two dimension attributes. The SVG engine serializes that
 * header before any embedded image data, so this touches kilobytes rather
 * than decoding and re-encoding the potentially multi-megabyte entire SVG.
 *
 * This is an exact-byte specialization of the historical:
 *   encodeURIComponent(svg.replace(head, scaledHead))
 * It accepts only the canonical URL and header emitted by the SVG engine;
 * noncanonical and externally-authored URLs return null for the old path.
 *
 * @param {string} url
 * @param {number} scale
 * @returns {string|null} scaled URL, or null when the conservative fast path cannot apply
 */
export function scaleEncodedSvgHeader(url, scale) {
  if (typeof url !== 'string' || !Number.isFinite(scale) ||
      !url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')) return null

  const comma = url.indexOf(',')
  // A giant or unusual header is outside this specialization. The bound also
  // ensures no accidental O(payload-size) scan on image-rich documents.
  const end = url.indexOf('%3E', comma + 1)
  if (end < 0 || end - comma > 4096) return null

  const encodedHead = url.slice(comma + 1, end + 3)
  let head
  try { head = decodeURIComponent(encodedHead) } catch { return null }
  if (!/^<svg\b[^>]*>$/i.test(head) || encodeURIComponent(head) !== encodedHead) return null

  const width = Number((head.match(/\bwidth="([\d.]+)"/i) || [])[1])
  const height = Number((head.match(/\bheight="([\d.]+)"/i) || [])[1])
  if (!(width > 0 && height > 0)) return null

  // Keep exactly the original round-to-integer semantics and case preservation.
  const nextHead = head
    .replace(/\bwidth="[^"]*"/i, `width="${Math.max(1, Math.round(width * scale))}"`)
    .replace(/\bheight="[^"]*"/i, `height="${Math.max(1, Math.round(height * scale))}"`)

  return url.slice(0, comma + 1) + encodeURIComponent(nextHead) + url.slice(end + 3)
}

/**
 * Specialize the oversize raster clamp for canonical snapDOM SVG URLs. The
 * legacy clamp edits only SVG's opening dimensions; copying the multi-MiB
 * payload through decodeURIComponent/encodeURIComponent buys nothing.
 * Return null for unusual inputs so the old path stays authoritative.
 */
export function clampEncodedSvgHeader(url, maxSide, maxArea) {
  if (typeof url !== 'string' || !url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg') ||
      !(Number.isFinite(maxSide) && maxSide > 0 && Number.isFinite(maxArea) && maxArea > 0)) return null
  const comma = url.indexOf(',')
  const end = url.indexOf('%3E', comma + 1)
  if (end < 0 || end - comma > 4096) return null
  const encodedHead = url.slice(comma + 1, end + 3)
  let head
  try { head = decodeURIComponent(encodedHead) } catch { return null }
  if (!/^<svg\b[^>]*>$/i.test(head) || encodeURIComponent(head) !== encodedHead) return null
  const width = parseFloat((head.match(/\bwidth="([\d.]+)/i) || [])[1])
  const height = parseFloat((head.match(/\bheight="([\d.]+)/i) || [])[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const factor = Math.min(1, maxSide / width, maxSide / height, Math.sqrt(maxArea / (width * height)))
  if (!(factor < 1)) return null
  const nextWidth = Math.max(1, Math.floor(width * factor))
  const nextHeight = Math.max(1, Math.floor(height * factor))
  // Original replacement syntax is intentional; byte-exact parity tests
  // compare it against clampSvgTextRasterSize's historic implementation.
  const nextHead = head
    .replace(/(\bwidth=")[\d.]+/i, `$1${nextWidth}`)
    .replace(/(\bheight=")[\d.]+/i, `$1${nextHeight}`)
  return {
    url: url.slice(0, comma + 1) + encodeURIComponent(nextHead) + url.slice(end + 3),
    width, height, nextWidth, nextHeight,
  }
}
