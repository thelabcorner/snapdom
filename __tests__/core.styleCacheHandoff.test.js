import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.remove?.()
})

function scene(css, html) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return { root, style }
}

async function raw(root, lineSeed, cvSeed, extra = {}) {
  return snapdom.toRaw(root, {
    burst: false,
    cache: 'disabled',
    embedFonts: false,
    __lineClampStyleSeed: lineSeed,
    __contentVisibilityStyleSeed: cvSeed,
    ...extra,
  })
}

async function factorial(root, extra = {}) {
  const out = []
  for (const lineSeed of [false, true]) {
    for (const cvSeed of [false, true]) {
      out.push(await raw(root, lineSeed, cvSeed, extra))
    }
  }
  expect(new Set(out).size).toBe(1)
  return out[3]
}

describe('R7-SA2 phase-shared computed-style handoff', () => {
  it('keeps all four cache-handoff arms byte-identical through the content-visibility mutation', async () => {
    const { root } = scene(
      '.probe{content-visibility:auto;contain-intrinsic-size:40px;width:180px;' +
      'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;' +
      'font:16px/20px Arial;overflow:hidden;color:rgb(12,34,56)}',
      '<div class="probe">Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</div>',
    )
    await factorial(root)
  })

  it('keeps all four cache-handoff arms byte-identical through a real line-clamp text mutation', async () => {
    const { root } = scene(
      '.probe{width:180px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;' +
      'font:16px/20px Arial;overflow:hidden;color:rgb(12,34,56)}',
      '<div class="probe">Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</div>',
    )
    const result = await factorial(root)
    expect(decodeURIComponent(result)).toContain('…')
  })

  it('observes a class mutation after both prepasses exactly like fresh getComputedStyle', async () => {
    const build = () => scene(
      '.before{color:rgb(255,0,0);width:90px}.after{color:rgb(0,0,255);width:140px}',
      '<div class="probe before">mutation target</div>',
    ).root

    const capture = async (lineSeed, cvSeed) => {
      const root = build()
      let done = false
      try {
        return await raw(root, lineSeed, cvSeed, {
          filter(el) {
            if (!done && el.classList?.contains('probe')) {
              done = true
              el.classList.remove('before')
              el.classList.add('after')
            }
            return true
          },
        })
      } finally {
        root.remove()
      }
    }

    const historical = await capture(false, false)
    const combined = await capture(true, true)
    expect(combined).toBe(historical)
    expect(decodeURIComponent(combined)).toContain('rgb(0, 0, 255)')
  })

  it('observes a CSSOM rule edit after both prepasses exactly like the historical path', async () => {
    const capture = async (lineSeed, cvSeed) => {
      const { root, style } = scene(
        '.probe{color:rgb(12,34,56);width:100px}',
        '<div class="probe">cssom target</div>',
      )
      let done = false
      try {
        return await raw(root, lineSeed, cvSeed, {
          filter(el) {
            if (!done && el.classList?.contains('probe')) {
              done = true
              style.sheet.cssRules[0].style.setProperty('color', 'rgb(98, 76, 54)')
              style.sheet.cssRules[0].style.setProperty('width', '133px')
            }
            return true
          },
        })
      } finally {
        root.remove()
        style.remove()
      }
    }

    const historical = await capture(false, false)
    const combined = await capture(true, true)
    expect(combined).toBe(historical)
    expect(decodeURIComponent(combined)).toContain('rgb(98, 76, 54)')
  })

  it('tracks structural selector changes after the handoff without stale nth-child values', async () => {
    const capture = async (lineSeed, cvSeed) => {
      const { root } = scene(
        '.row{display:block;width:80px;color:rgb(0,0,255)}.row:nth-child(2){color:rgb(255,0,0);width:130px}',
        '<div class="list"><div class="row a">a</div><div class="row b">b</div><div class="row c">c</div></div>',
      )
      let done = false
      try {
        return await raw(root, lineSeed, cvSeed, {
          filter(el) {
            if (!done && el.classList?.contains('a')) {
              done = true
              const list = root.querySelector('.list')
              list.appendChild(list.firstElementChild)
            }
            return true
          },
        })
      } finally {
        root.remove()
      }
    }

    const historical = await capture(false, false)
    const combined = await capture(true, true)
    expect(combined).toBe(historical)
  })

  it('keeps backdrop-filter firing byte-identical when discovery reuses the handed-off declaration', async () => {
    const capture = async (reuse) => {
      const { root } = scene(
        '.back{width:260px;height:100px;background:repeating-linear-gradient(90deg,#000 0 8px,#fff 8px 16px)}' +
        '.frost{width:180px;height:70px;background:rgba(255,255,255,.2);backdrop-filter:blur(8px)}',
        '<div class="back"><div class="frost">frosted</div></div>',
      )
      try {
        return await raw(root, true, true, { __backdropStyleReuse: reuse })
      } finally {
        root.remove()
      }
    }

    const historical = await capture(false)
    const reused = await capture(true)
    expect(reused).toBe(historical)
    expect(decodeURIComponent(reused)).toContain('filter: blur(8px)')
  })

  it('sees a backdrop-filter class mutation made after the declaration handoff', async () => {
    const capture = async (reuse) => {
      const { root } = scene(
        '.back{width:260px;height:100px;background:repeating-linear-gradient(90deg,#000 0 8px,#fff 8px 16px)}' +
        '.frost{width:180px;height:70px;background:rgba(255,255,255,.2)}.active{backdrop-filter:blur(9px)}',
        '<div class="back"><div class="frost">frost later</div></div>',
      )
      let done = false
      try {
        return await raw(root, true, true, {
          __backdropStyleReuse: reuse,
          filter(el) {
            if (!done && el.classList?.contains('frost')) {
              done = true
              el.classList.add('active')
            }
            return true
          },
        })
      } finally {
        root.remove()
      }
    }

    const historical = await capture(false)
    const reused = await capture(true)
    expect(reused).toBe(historical)
    expect(decodeURIComponent(reused)).toContain('filter: blur(9px)')
  })

})
