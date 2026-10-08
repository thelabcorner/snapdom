import { describe, it, expect, afterEach } from 'vitest'
import { collectFontUsage } from '../src/modules/fonts.js'

const mounted = []
const host = () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  mounted.push(root)
  return root
}
afterEach(() => { for (const n of mounted.splice(0)) n.remove() })

describe('R18 capture-local font variants', () => {
  it('preserves complete fallback chains and exact variant descriptors on repeated nodes', () => {
    const root = host()
    const family = '"R18 Latin", "R18 Symbols", sans-serif'
    root.style.fontFamily = family
    root.style.fontWeight = '700'
    root.style.fontStyle = 'italic'
    for (let i = 0; i < 400; i++) {
      const el = document.createElement('span')
      el.textContent = 'ABC ' + i
      el.style.fontFamily = family
      el.style.fontWeight = '700'
      el.style.fontStyle = 'italic'
      root.appendChild(el)
    }
    const usage = collectFontUsage(root)
    expect(usage.required.has('R18 Latin__700__italic__100')).toBe(true)
    expect(usage.required.has('R18 Symbols__700__italic__100')).toBe(true)
    expect(usage.required.has('sans-serif__700__italic__100')).toBe(false)
    expect(usage.usedCodepoints.has('A'.codePointAt(0))).toBe(true)
  })

  it('remains correct after 256 distinct variant tuples without unbounded admission', () => {
    const root = host()
    for (let i = 0; i < 340; i++) {
      const el = document.createElement('span')
      el.style.fontFamily = '"R18 Unique ' + i + '"'
      el.textContent = 'Item ' + i
      root.appendChild(el)
    }
    const result = collectFontUsage(root)
    for (let i = 0; i < 340; i++) {
      expect(result.required.has('R18 Unique ' + i + '__400__normal__100')).toBe(true)
    }
  })

  it('does not persist a stale font tuple into subsequent captures after a style mutation', () => {
    const root = host()
    root.style.fontFamily = '"R18 Before"'
    root.textContent = 'Hello'
    expect(collectFontUsage(root).required.has('R18 Before__400__normal__100')).toBe(true)
    root.style.fontFamily = '"R18 After"'
    const next = collectFontUsage(root)
    expect(next.required.has('R18 After__400__normal__100')).toBe(true)
    expect(next.required.has('R18 Before__400__normal__100')).toBe(false)
  })

  it('keeps pseudo content and shadow-root font subsets in the traversal', () => {
    const root = host()
    const style = document.createElement('style')
    style.textContent = '.r18-fix::before { content: "★"; font-family: "R18 Pseudo"; font-weight: 700 }'
    document.head.appendChild(style)
    mounted.push(style)
    root.className = 'r18-fix'
    const shell = document.createElement('div')
    const shadow = shell.attachShadow({ mode: 'open' })
    const span = document.createElement('span')
    span.textContent = 'Ω'
    span.style.fontFamily = '"R18 Shadow"'
    shadow.appendChild(span)
    root.appendChild(shell)
    const result = collectFontUsage(root)
    expect(result.usedCodepoints.has('Ω'.codePointAt(0))).toBe(true)
    expect(result.required.has('R18 Shadow__400__normal__100')).toBe(true)
    expect(result.required.has('R18 Pseudo__700__normal__100')).toBe(true)
  })
})
