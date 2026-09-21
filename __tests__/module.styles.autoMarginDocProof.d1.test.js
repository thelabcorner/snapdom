import { describe, it, expect, afterEach } from 'vitest'
import { snapdom } from '../src/index.js'
import { invalidateStyleCaches } from '../src/modules/styles.js'

// R8-D1 oracles: document-level auto-margin proof caching.
//
// Production caches the DOCUMENT half of the R5-SM2 proof (author marginMayBeAuto + hasAnimations)
// on the session, paying scanFor/hasAnimations once per capture instead of once per node. The
// per-node half (UA tags, presentational hints, inline regexes) is unchanged.
//
// These tests are the PRE-REGISTERED oracle package: exact raw-byte parity between the production
// path and the historical per-node path (`__autoMarginDocProofCache: false`), plus protected
// controls for every channel that can legitimately produce an auto margin. No timing claim.

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  invalidateStyleCaches()
})

function mount(css, html) {
  const style = document.createElement('style')
  if (css) style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

const OPTS = { burst: false, cache: 'disabled', embedFonts: false }
const raw = (root, extra = {}) => snapdom.toRaw(root, { ...OPTS, ...extra })

// Parity helper: production (doc-proof cached) vs historical (per-node document scan).
async function parity(fixture) {
  const production = await raw(fixture, { __autoMarginDocProofCache: true })
  invalidateStyleCaches()
  const historical = await raw(fixture, { __autoMarginDocProofCache: false })
  return { production, historical }
}

describe('R8-D1 document-level auto-margin proof caching', () => {
  it('is byte-identical on an ordinary margin-free tree (the common case)', async () => {
    const root = mount(
      '.d1-card{width:80px;height:20px;background:#eef;margin:0}',
      '<div class="d1-cards">' +
        Array.from({ length: 40 }, (_, i) => `<div class="d1-card">c${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical with a real authored auto margin (protected control)', async () => {
    const root = mount(
      '.d1-auto{width:60px;height:20px;background:#fee;margin-left:auto;margin-right:auto}',
      '<div style="width:400px">' +
        Array.from({ length: 12 }, (_, i) => `<div class="d1-auto">a${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical when auto arrives through var() (protected control)', async () => {
    const root = mount(
      ':root{--m:auto}.d1-var{margin-left:var(--m);margin-right:var(--m);width:50px;height:16px}',
      '<div style="width:300px">' +
        Array.from({ length: 8 }, (_, i) => `<div class="d1-var">v${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical for a <table align=center> presentational hint (protected control)', async () => {
    const root = mount(
      'table{margin:0;border-collapse:collapse}td{width:40px;height:12px}',
      '<div style="width:400px"><table align="center"><tbody><tr><td>x</td><td>y</td></tr></tbody></table></div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical under all:inherit (adversarial edge)', async () => {
    const root = mount(
      '.d1-all{all:inherit;width:70px;height:18px;background:#dfd}',
      '<div style="width:350px;margin:0">' +
        Array.from({ length: 6 }, (_, i) => `<div class="d1-all">i${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical under all:revert (adversarial edge)', async () => {
    const root = mount(
      '.d1-rev{all:revert;width:70px;height:18px;background:#fdd}',
      '<div style="width:350px;margin:0">' +
        Array.from({ length: 6 }, (_, i) => `<div class="d1-rev">r${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical with UA auto-margin tags (dialog/hr)', async () => {
    const root = mount(
      'dialog{margin:auto;width:120px;height:40px}hr{margin:0}',
      '<div style="width:400px"><dialog open>d</dialog><hr></div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical with an inline auto margin (per-node channel)', async () => {
    const root = mount(
      '',
      '<div style="width:400px">' +
        Array.from({ length: 10 }, (_, i) => `<div style="margin-left:auto;margin-right:auto;width:50px;height:14px">n${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical with a running animation on the document (doc-level channel)', async () => {
    const root = mount(
      '@keyframes d1k{from{opacity:.4}to{opacity:1}}.d1-anim{margin:0;width:60px;height:16px;animation:d1k 1s linear infinite}',
      '<div style="width:400px">' +
        Array.from({ length: 8 }, (_, i) => `<div class="d1-anim">k${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical when the document has an unstable margin channel (shorthand auto)', async () => {
    const root = mount(
      '.d1-sh{margin:auto;width:64px;height:18px;background:#fed}',
      '<div style="width:400px">' +
        Array.from({ length: 9 }, (_, i) => `<div class="d1-sh">s${i}</div>`).join('') +
        '</div>',
    )
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('is byte-identical for a shadow-host margin subtree (outside-document-scan path)', async () => {
    const root = mount('.d1-host{width:200px;height:40px;margin:0}', '<div class="d1-host"></div>')
    const host = root.firstElementChild
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>.in{width:60px;height:18px;margin-left:auto;margin-right:auto;background:#def}</style>' +
      Array.from({ length: 5 }, (_, i) => `<div class="in">h${i}</div>`).join('')
    const { production, historical } = await parity(root)
    expect(production).toBe(historical)
  })

  it('fails closed to the historical path when the counterfactual flag is explicitly false', async () => {
    const root = mount('.d1-f{width:40px;height:12px;margin:0}', '<div class="d1-f">f</div>')
    const historical = await raw(root, { __autoMarginDocProofCache: false })
    invalidateStyleCaches()
    const alsoHistorical = await raw(root, { __autoMarginDocProofCache: false })
    expect(alsoHistorical).toBe(historical)
  })
})
