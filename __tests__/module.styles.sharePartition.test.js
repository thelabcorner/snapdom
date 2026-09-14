import { describe, it, expect, afterEach } from 'vitest'
import { styleSharePlan, flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  flushStyleInvalidations()
})

function mount(css, html = '<div class="grid"><div class="card"><span class="badge"></span></div><div class="card"></div><div class="card"></div></div>') {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)

  const root = document.createElement('div')
  root.className = 'partition-root'
  root.innerHTML = html
  document.body.appendChild(root)
  mounted.push(root)
  flushStyleInvalidations()
  return root
}

describe('identity share — selector partition plan', () => {
  it('partitions positional selectors instead of disabling the capture', () => {
    const root = mount('.partition-root .card:nth-child(2n){color:rgb(1,2,3)}')
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors).not.toBeNull()
    expect(plan.selectors.some((x) => x.sel.includes(':nth-child'))).toBe(true)
  })

  it('partitions sibling and :has() selectors in the proven subset', () => {
    const root = mount(`
      .partition-root .card + .card { border-left-width: 3px; }
      .partition-root .card:has(.badge) { outline-width: 2px; }
    `)
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors).not.toBeNull()
    expect(plan.selectors.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back for state selectors that currently match', () => {
    const root = mount('.partition-root .card:not(:hover){color:rgb(1,2,3)}')
    expect(styleSharePlan(root)).toEqual({ share: false, selectors: null })
  })

  it('falls back when counters can carry structural state across twins', () => {
    const root = mount(`
      .partition-root .card { counter-increment: item; }
      .partition-root .card:nth-child(2n) { color: rgb(1,2,3); }
    `)
    expect(styleSharePlan(root)).toEqual({ share: false, selectors: null })
  })

  it('falls back for selectors whose result depends on container size', () => {
    const root = mount(`
      .partition-root .grid { container-type: inline-size; }
      @container (min-width: 1px) {
        .partition-root .card:nth-child(2n) { color: rgb(1,2,3); }
      }
    `)
    expect(styleSharePlan(root)).toEqual({ share: false, selectors: null })
  })
})
