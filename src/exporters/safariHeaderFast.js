/**
 * Conservative shadow-free detection on a canonical percent-encoded SVG URL.
 *
 * fixSafariShadows only rewrites when the decoded SVG matches:
 *   /(?:box-shadow|text-shadow)\s*:[^;"}]*px/i
 *
 * We do not attempt to parse CSS or override that decision. Instead this
 * linear token scanner proves a STRICTER absence condition: within each
 * encoded region bounded by a semicolon, quotation mark or closing brace,
 * no shadow marker is followed by `px`. False positives take the legacy
 * rewrite; a false negative would violate the fidelity gate.
 *
 * Letter and hyphen percent escapes are not canonical encodeURIComponent
 * output and are rejected: otherwise a shadow marker encoded as e.g.
 * `%62ox-shadow` could evade the token scanner.
 */
export function definitelyNoEncodedSafariShadows(url) {
  if (typeof url !== 'string' ||
      !url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')) return false
  if (/%(?:2D|4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A])/i.test(url)) return false
  const token = /box-shadow|text-shadow|px|%3B|%22|%7D/ig
  let potentialShadow = false
  let match
  while ((match = token.exec(url)) !== null) {
    const item = match[0].toLowerCase()
    if (item === 'box-shadow' || item === 'text-shadow') potentialShadow = true
    else if (item === 'px' && potentialShadow) return false
    else if (item[0] === '%') potentialShadow = false
  }
  return true
}

/**
 * Exact translation of Safari's no-rewrite SVG sizing onto the canonical
 * encoded opening tag. Uses the historical reference geometry/rounding and
 * width/height substring replacement order, not the non-Safari rule.
 */
export function resizeEncodedSafariSvg(url, { scale = 1, width, height, meta = {} }) {
  if (typeof url !== 'string' ||
      !url.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')) return null
  const comma = url.indexOf(',')
  const end = url.indexOf('%3E', comma + 1)
  if (end < 0 || end - comma > 4096) return null
  const encodedHead = url.slice(comma + 1, end + 3)
  let head
  try { head = decodeURIComponent(encodedHead) } catch { return null }
  if (!/^<svg\b[^>]*>$/i.test(head) || encodeURIComponent(head) !== encodedHead) return null
  const natW = parseFloat((head.match(/\bwidth="([\d.]+)/i) || [])[1])
  const natH = parseFloat((head.match(/\bheight="([\d.]+)/i) || [])[1])
  if (!Number.isFinite(natW) || !Number.isFinite(natH)) return null
  const refW = Number.isFinite(meta.vbW) ? meta.vbW : Number.isFinite(meta.w0) ? meta.w0 : natW
  const refH = Number.isFinite(meta.vbH) ? meta.vbH : Number.isFinite(meta.h0) ? meta.h0 : natH
  const hasW = Number.isFinite(width), hasH = Number.isFinite(height)
  let cssW, cssH
  if (hasW && hasH) { cssW = width; cssH = height }
  else if (hasW) { cssW = width; cssH = Math.max(1, Math.round(refH * (width / Math.max(1, refW)))) }
  else if (hasH) { cssH = height; cssW = Math.max(1, Math.round(refW * (height / Math.max(1, refH)))) }
  else { cssW = Math.max(1, Math.round(natW * scale)); cssH = Math.max(1, Math.round(natH * scale)) }
  const nextHead = head
    .replace(/width="[^"]*"/, `width="${cssW}"`)
    .replace(/height="[^"]*"/, `height="${cssH}"`)
  return {
    url: url.slice(0, comma + 1) + encodeURIComponent(nextHead) + url.slice(end + 3),
    width: cssW,
    height: cssH,
  }
}
