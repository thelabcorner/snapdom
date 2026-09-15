import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { diffCanvas } from '@zumer/snapdiff/diff'
import { styleSharePlan, flushStyleInvalidations } from '../src/modules/styles.js'
import { snapdom } from '../src/index.js'

const mounted = []

afterEach(() => {
  try { document.activeElement?.blur?.() } catch { /* already detached/non-focusable */ }
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

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushStyleInvalidations()
}

async function expectVisualParity(root, productionOptions = {}) {
  const base = { burst: false, embedFonts: false, scale: 1, dpr: 1, ...productionOptions }
  const production = await snapdom.toCanvas(root, base)
  await settle()
  const conservative = await snapdom.toCanvas(root, { ...base, __styleShare: false })
  const diff = diffCanvas(conservative, production, { threshold: 0.1, includeAA: false })
  expect(diff.dimsMatch).toBe(true)
  expect(diff.diff).toBe(0)
  expect(diff.ratio).toBe(0)
  return production
}

function pixel(canvas, x, y) {
  const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data
  return [d[0], d[1], d[2]]
}

function centerInCapture(root, el) {
  const rr = root.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  return [
    Math.max(0, Math.round(er.left - rr.left + er.width / 2)),
    Math.max(0, Math.round(er.top - rr.top + er.height / 2)),
  ]
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

  it('partitions :focus while the focused element itself remains a per-node full read', () => {
    const root = mount(
      '.partition-root .card:focus{color:rgb(1,2,3)}',
      '<div class="grid"><div class="card" tabindex="0"></div><div class="card" tabindex="0"></div><div class="card" tabindex="0"></div></div>',
    )
    root.querySelectorAll('.card')[1].focus()
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors).not.toBeNull()
    expect(plan.selectors.some((x) => x.sel.includes(':focus'))).toBe(true)
    // Same-build counterfactual must retain the historical all-state veto.
    expect(styleSharePlan(root, false)).toEqual({ share: false, selectors: null })
  })

  it('partitions :focus-within ancestors by their live match bit', () => {
    const root = mount(
      '.partition-root .group:focus-within{background:rgb(1,2,3)}',
      '<div class="group"><span tabindex="0"></span></div><div class="group"><span tabindex="0"></span></div>',
    )
    root.querySelectorAll('span')[1].focus()
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors).not.toBeNull()
    expect(plan.selectors.some((x) => x.sel.includes(':focus-within'))).toBe(true)
  })

  it('tracks :focus-within when focus moves between twins across warm captures', async () => {
    const root = mount(`
      .partition-root .grid { display:flex; gap:4px }
      .partition-root .group { width:60px; height:40px; background:rgb(0,0,255) }
      .partition-root .probe { display:block; width:10px; height:10px; outline:none }
      .partition-root .group:focus-within { background:rgb(255,0,0) }
    `, '<div class="grid">' + Array.from({ length: 8 }, () =>
      '<div class="group"><span class="probe" tabindex="0"></span></div>').join('') + '</div>')
    const probes = root.querySelectorAll('.probe')

    probes[1].focus()
    await settle()
    expect(probes[1].matches(':focus')).toBe(true)
    expect(probes[1].parentElement.matches(':focus-within')).toBe(true)
    // Seed the cross-capture snapshot cache in the first focus state.
    await expectVisualParity(root)

    probes[6].focus()
    await settle()
    expect(probes[1].parentElement.matches(':focus-within')).toBe(false)
    expect(probes[6].parentElement.matches(':focus-within')).toBe(true)
    const moved = await expectVisualParity(root)

    // Independent semantic oracle: the old focused group is blue again and the new one is red.
    const [oldX, oldY] = centerInCapture(root, probes[1].parentElement)
    const [newX, newY] = centerInCapture(root, probes[6].parentElement)
    expect(pixel(moved, oldX, oldY)[2]).toBeGreaterThan(120)
    expect(pixel(moved, newX, newY)[0]).toBeGreaterThan(120)
  })

  it('tracks :focus-within across shadow boundaries when internal focus moves', async () => {
    const root = mount(`
      .partition-root .grid { display:flex; gap:4px }
      .partition-root .group { width:64px; height:42px; background:rgb(0,0,255) }
      .partition-root .group:focus-within { background:rgb(255,0,0) }
    `, '<div class="grid">' + Array.from({ length: 6 }, () =>
      '<div class="group"><span class="shadow-host"></span></div>').join('') + '</div>')
    const groups = root.querySelectorAll('.group')
    const hosts = root.querySelectorAll('.shadow-host')
    const probes = []
    for (const host of hosts) {
      const shadow = host.attachShadow({ mode: 'open' })
      const probe = document.createElement('button')
      probe.textContent = 'x'
      probe.style.cssText = 'width:10px;height:10px;padding:0;border:0;outline:none'
      shadow.appendChild(probe)
      probes.push(probe)
    }

    probes[1].focus()
    await settle()
    expect(hosts[1].shadowRoot.activeElement).toBe(probes[1])
    expect(groups[1].matches(':focus-within')).toBe(true)
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors?.some((x) => x.sel.includes(':focus-within'))).toBe(true)
    await expectVisualParity(root)

    probes[4].focus()
    await settle()
    expect(groups[1].matches(':focus-within')).toBe(false)
    expect(groups[4].matches(':focus-within')).toBe(true)
    const moved = await expectVisualParity(root)
    const [oldX, oldY] = centerInCapture(root, groups[1])
    const [newX, newY] = centerInCapture(root, groups[4])
    expect(pixel(moved, oldX, oldY)[2]).toBeGreaterThan(120)
    expect(pixel(moved, newX, newY)[0]).toBeGreaterThan(120)
  })

  it('partitions :focus-visible after real keyboard navigation without sharing the active node', async () => {
    const root = mount(`
      .partition-root .grid { display:flex; gap:4px }
      .partition-root .card { width:48px; height:32px; background:rgb(0,0,255); outline:none }
      .partition-root .card:focus-visible { background:rgb(255,0,0) }
    `, '<div class="grid"><span class="card" tabindex="0"></span><span class="card" tabindex="0"></span><span class="card" tabindex="0"></span></div>')
    const cards = root.querySelectorAll('.card')
    cards[0].focus()
    await userEvent.tab()
    await settle()

    const active = document.activeElement
    expect(Array.from(cards).includes(active)).toBe(true)
    expect(active.matches(':focus-visible')).toBe(true)
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors?.some((x) => x.sel.includes(':focus-visible'))).toBe(true)
    await expectVisualParity(root)
  })

  it('keeps mixed focus + volatile interaction selectors on the conservative veto', () => {
    const root = mount(
      '.partition-root .card:focus:not(:hover){color:rgb(1,2,3)}',
      '<div class="grid"><div class="card" tabindex="0"></div><div class="card" tabindex="0"></div></div>',
    )
    root.querySelector('.card').focus()
    // :focus is partitionable, :hover is deliberately not. Every pseudo token must be proven,
    // so an allowed focus token may never launder a volatile selector onto the fast path.
    expect(styleSharePlan(root)).toEqual({ share: false, selectors: null })
  })

  it('partitions a focus-dependent sibling target and tracks the target when focus moves', async () => {
    const root = mount(`
      .partition-root .grid { display:flex; gap:3px }
      .partition-root .trigger,.partition-root .target { display:inline-block; width:36px; height:24px }
      .partition-root .trigger { outline:none }
      .partition-root .target { background:rgb(0,0,255) }
      .partition-root .trigger:focus + .target { background:rgb(255,0,0) }
    `, '<div class="grid">' + Array.from({ length: 6 }, () =>
      '<span class="trigger" tabindex="0"></span><span class="target"></span>').join('') + '</div>')
    const triggers = root.querySelectorAll('.trigger')
    const targets = root.querySelectorAll('.target')

    triggers[1].focus()
    await settle()
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors?.some((x) => x.sel.includes(':focus') && x.sel.includes('+'))).toBe(true)
    await expectVisualParity(root)

    triggers[4].focus()
    await settle()
    const moved = await expectVisualParity(root)
    const [oldX, oldY] = centerInCapture(root, targets[1])
    const [newX, newY] = centerInCapture(root, targets[4])
    expect(pixel(moved, oldX, oldY)[2]).toBeGreaterThan(120)
    expect(pixel(moved, newX, newY)[0]).toBeGreaterThan(120)
  })

  it('partitions :has(:focus) relational state and invalidates its descendant target', async () => {
    const root = mount(`
      .partition-root .group { display:block; width:80px; height:28px }
      .partition-root .probe { outline:none }
      .partition-root .leaf { display:inline-block; width:32px; height:18px; background:rgb(0,0,255) }
      .partition-root .group:has(.probe:focus) .leaf { background:rgb(255,0,0) }
    `, '<div class="grid">' + Array.from({ length: 8 }, () =>
      '<div class="group"><span class="probe" tabindex="0"></span><span class="leaf"></span></div>').join('') + '</div>')
    const probes = root.querySelectorAll('.probe')
    const leaves = root.querySelectorAll('.leaf')

    probes[2].focus()
    await settle()
    const plan = styleSharePlan(root)
    expect(plan.share).toBe(true)
    expect(plan.selectors?.some((x) => x.sel.includes(':has(') && x.sel.includes(':focus'))).toBe(true)
    await expectVisualParity(root)

    probes[7].focus()
    await settle()
    const moved = await expectVisualParity(root)
    const [oldX, oldY] = centerInCapture(root, leaves[2])
    const [newX, newY] = centerInCapture(root, leaves[7])
    expect(pixel(moved, oldX, oldY)[2]).toBeGreaterThan(120)
    expect(pixel(moved, newX, newY)[0]).toBeGreaterThan(120)
  })

  it('keeps focus-partitioned production output byte-identical to the historical state veto', async () => {
    const cards = Array.from({ length: 80 }, (_, i) => `<span class="card" tabindex="0">${i}</span>`).join('')
    const root = mount(`
      .partition-root .grid { width:640px }
      .partition-root .card { display:inline-block;width:40px;height:20px;background:rgb(0,0,255) }
      .partition-root .card:focus { background:rgb(255,0,0) }
    `, `<div class="grid">${cards}</div>`)
    root.querySelectorAll('.card')[37].focus()
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushStyleInvalidations()
    const opts = { burst: false, cache: 'disabled', embedFonts: false }
    const partitioned = await snapdom.toRaw(root, opts)
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushStyleInvalidations()
    const historical = await snapdom.toRaw(root, { ...opts, __styleShareFocusPartition: false })
    expect(partitioned).toBe(historical)
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
