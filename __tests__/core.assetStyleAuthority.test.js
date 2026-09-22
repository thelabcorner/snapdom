import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'

const mounted = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.remove?.()
})

function mount(tag, html, css = '') {
  if (css) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    mounted.push(style)
  }
  const root = document.createElement(tag)
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

async function raw(root, extra = {}) {
  return snapdom.toRaw(root, {
    burst: false,
    cache: 'disabled',
    embedFonts: false,
    ...extra,
  })
}

describe('R7-SA6 asset style authority', () => {
  it('reuses exact HTML styles while collecting CSS references to external SVG defs', async () => {
    const sprite = mount(
      'svg',
      '<defs><filter id="sa6-filter"><feGaussianBlur stdDeviation="1"/></filter></defs>',
    )
    sprite.style.cssText = 'position:absolute;width:0;height:0'

    const capture = async (reuse) => {
      const root = mount(
        'div',
        '<div class="probe off">filtered</div>',
        '.probe{width:80px;height:30px}.off{filter:none}.on{filter:url(#sa6-filter)}',
      )
      let changed = false
      try {
        return await raw(root, {
          __svgDefsStyleReuse: reuse,
          filter(el) {
            if (!changed && el.classList?.contains('probe')) {
              changed = true
              el.classList.replace('off', 'on')
            }
            return true
          },
        })
      } finally { root.remove() }
    }

    const historical = await capture(false)
    const reused = await capture(true)
    expect(reused).toBe(historical)
    expect(decodeURIComponent(reused)).toContain('sa6-filter')
  })

  it('reuses the live image declaration across src/content/size/object-fit freezing', async () => {
    const src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"%3E%3Crect width="2" height="2" fill="red"/%3E%3C/svg%3E'
    const capture = async (reuse) => {
      const root = mount(
        'div',
        `<img class="probe before" src="${src}">`,
        '.probe{display:block}.before{width:20px;height:10px;object-fit:cover}.after{width:31px;height:13px;object-fit:contain}',
      )
      let changed = false
      try {
        return await raw(root, {
          __imageStyleReuse: reuse,
          filter(el) {
            if (!changed && el.classList?.contains('probe')) {
              changed = true
              el.classList.replace('before', 'after')
            }
            return true
          },
        })
      } finally { root.remove() }
    }

    const historical = await capture(false)
    const reused = await capture(true)
    expect(reused).toBe(historical)
    expect(decodeURIComponent(reused)).toContain('object-fit: contain')
  })

  it('reuses the exact source declaration for SVG paint properties after a class mutation', async () => {
    const capture = async (reuse) => {
      const root = mount(
        'div',
        '<svg width="40" height="20"><rect class="shape before" width="40" height="20"/></svg>',
        '.shape.before{fill:rgb(255,0,0)}.shape.after{fill:rgb(0,0,255)}',
      )
      let changed = false
      try {
        return await raw(root, {
          __svgPaintStyleReuse: reuse,
          filter(el) {
            if (!changed && el.classList?.contains('shape')) {
              changed = true
              el.classList.replace('before', 'after')
            }
            return true
          },
        })
      } finally { root.remove() }
    }

    const historical = await capture(false)
    const reused = await capture(true)
    expect(reused).toBe(historical)
    expect(decodeURIComponent(reused)).toContain('fill: rgb(0, 0, 255)')
  })
})
