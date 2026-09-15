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

async function capture(build, seed) {
  const { root, mutate } = build()
  try {
    return await snapdom.toRaw(root, {
      burst: false,
      cache: 'disabled',
      embedFonts: false,
      __contentVisibilityStyleSeed: seed,
      // filter runs inside deepClone, after forceContentVisibility has populated the optional
      // handoff cache but before inlineAllStyles consumes it. It is therefore an adversarial
      // oracle for whether the handed-off CSSStyleDeclaration remains live across mutations.
      filter: (el) => {
        mutate?.(el)
        return true
      },
    })
  } finally {
    root.remove()
  }
}

describe('R7-SA1 content-visibility style handoff', () => {
  it('remains byte-identical when a class mutation happens between the prepass and style snapshot', async () => {
    const build = () => {
      const { root } = scene(
        '.before{color:rgb(255,0,0);width:90px}.after{color:rgb(0,0,255);width:140px}',
        '<div class="probe before">mutation target</div>',
      )
      let done = false
      return {
        root,
        mutate(el) {
          if (!done && el.classList?.contains('probe')) {
            done = true
            el.classList.remove('before')
            el.classList.add('after')
          }
        },
      }
    }
    const historical = await capture(build, false)
    const seeded = await capture(build, true)
    expect(seeded).toBe(historical)
    expect(decodeURIComponent(seeded)).toContain('rgb(0, 0, 255)')
  })

  it('remains byte-identical across a CSSOM rule edit after the prepass', async () => {
    const build = () => {
      const { root, style } = scene('.probe{color:rgb(12,34,56);width:100px}', '<div class="probe">cssom target</div>')
      let done = false
      return {
        root,
        mutate(el) {
          if (!done && el.classList?.contains('probe')) {
            done = true
            style.sheet.cssRules[0].style.setProperty('color', 'rgb(98, 76, 54)')
            style.sheet.cssRules[0].style.setProperty('width', '133px')
          }
        },
      }
    }
    const historical = await capture(build, false)
    const seeded = await capture(build, true)
    expect(seeded).toBe(historical)
    expect(decodeURIComponent(seeded)).toContain('rgb(98, 76, 54)')
  })

  it('remains byte-identical when structural reordering changes an nth-child match mid-clone', async () => {
    const build = () => {
      const { root } = scene(
        '.row{display:block;width:80px;color:rgb(0,0,255)}.row:nth-child(2){color:rgb(255,0,0);width:130px}',
        '<div class="list"><div class="row a">a</div><div class="row b">b</div><div class="row c">c</div></div>',
      )
      let done = false
      return {
        root,
        mutate(el) {
          if (!done && el.classList?.contains('a')) {
            done = true
            const list = root.querySelector('.list')
            list.appendChild(list.firstElementChild)
          }
        },
      }
    }
    const historical = await capture(build, false)
    const seeded = await capture(build, true)
    expect(seeded).toBe(historical)
  })
})
