import { afterAll, beforeAll, bench, describe } from 'vitest'
import { snapdom } from '../src/index.js'

const benchOpts = { time: 1600, warmupIterations: 2 }

function mount(node) {
  document.body.appendChild(node)
  return node
}

function makeCardGrid(cards = 90) {
  const root = document.createElement('main')
  root.style.cssText = 'width:960px;padding:18px;background:#fff;font-family:Arial,sans-serif;color:#222'
  const grid = document.createElement('div')
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:8px'
  for (let i = 0; i < cards; i++) {
    const card = document.createElement('article')
    card.style.cssText = `padding:9px;border:1px solid #ddd;border-radius:7px;background:${i % 2 ? '#f8fafc' : '#eef2ff'};box-shadow:0 1px 2px rgba(0,0,0,.08)`
    card.innerHTML = `<h3 style="margin:0;font-size:13px">Card ${i}</h3><p style="margin:5px 0;font-size:11px">Measured capture fixture ${i}</p><strong style="font-size:15px">${i * 17}</strong><span style="display:block;opacity:.7">row ${i % 9}</span>`
    grid.appendChild(card)
  }
  root.appendChild(grid)
  return root
}

function makeStyleHeavy(rows = 220) {
  const root = document.createElement('section')
  root.style.cssText = 'width:900px;padding:16px;font-family:system-ui;background:#fafafa;color:#18181b'
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('div')
    row.style.cssText = `display:flex;align-items:center;gap:${(i % 5) + 4}px;padding:${(i % 4) + 3}px ${10 + (i % 7)}px;margin:${i % 3}px 0;border:${i % 2}px solid rgba(0,0,0,.14);border-radius:${i % 9}px;background:rgba(${30 + (i % 80)},${40 + (i % 70)},${80 + (i % 60)},.08);transform:translateX(${i % 3}px);opacity:${0.82 + (i % 10) / 100}`
    row.innerHTML = `<span style="font-weight:${400 + (i % 4) * 100}">Metric ${i}</span><span style="margin-left:auto;color:rgb(${40 + (i % 100)},70,110)">${i * 13}</span><em style="font-size:${10 + (i % 6)}px">sample</em><b style="letter-spacing:${i % 3}px">${i % 2 ? 'hot' : 'cold'}</b>`
    root.appendChild(row)
  }
  return root
}

function makeRepeatedRows(rows = 320) {
  const root = document.createElement('div')
  root.style.cssText = 'width:840px;font-family:Arial,sans-serif'
  const template = '<span class="label">Repeated component</span><span class="value">12345</span><span class="meta">stable</span><i class="dot"></i>'
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('div')
    row.className = 'repeated-row'
    row.style.cssText = 'display:grid;grid-template-columns:1fr 90px 90px 12px;align-items:center;gap:8px;height:28px;border-bottom:1px solid #e4e4e7;padding:0 8px'
    row.innerHTML = template
    root.appendChild(row)
  }
  return root
}

function makeClipPage(sections = 48, cardsPerSection = 20) {
  const root = document.createElement('div')
  root.style.cssText = 'width:820px;font-family:system-ui;font-size:12px;color:#222'
  for (let s = 0; s < sections; s++) {
    const section = document.createElement('section')
    section.style.cssText = 'padding:12px;border-bottom:1px solid #ddd'
    const title = document.createElement('h2')
    title.textContent = `Section ${s}`
    section.appendChild(title)
    const grid = document.createElement('div')
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:5px'
    for (let i = 0; i < cardsPerSection; i++) {
      const card = document.createElement('div')
      card.style.cssText = 'height:40px;padding:5px;background:#f4f4f5;border-radius:4px;box-shadow:0 1px 1px rgba(0,0,0,.08)'
      card.textContent = `Cell ${s}-${i}`
      grid.appendChild(card)
    }
    section.appendChild(grid)
    root.appendChild(section)
  }
  return root
}

function makePseudoText(items = 300) {
  const style = document.createElement('style')
  style.dataset.perfFixture = 'pseudo'
  style.textContent = '.perf-pseudo-item::before{content:"•";margin-right:4px;color:#71717a}.perf-pseudo-item:nth-child(3n)::after{content:" ok";font-weight:700}.perf-pseudo-item{font:12px/1.35 Arial,sans-serif}'
  document.head.appendChild(style)
  const root = document.createElement('div')
  root.style.cssText = 'width:700px;padding:12px'
  for (let i = 0; i < items; i++) {
    const item = document.createElement('div')
    item.className = 'perf-pseudo-item'
    item.textContent = `Text fixture ${i} abcdefghijklmnopqrstuvwxyz 0123456789`
    root.appendChild(item)
  }
  return { root, style }
}

describe('optimization scientist: cold capture corpus', () => {
  let medium
  let styleHeavy
  let repeated

  beforeAll(() => {
    medium = mount(makeCardGrid())
    styleHeavy = mount(makeStyleHeavy())
    repeated = mount(makeRepeatedRows())
  })

  afterAll(() => {
    medium?.remove()
    styleHeavy?.remove()
    repeated?.remove()
  })

  bench('cold-medium-450', async () => {
    await snapdom.toRaw(medium, { cache: 'disabled' })
  }, benchOpts)

  bench('cold-style-heavy-1100', async () => {
    await snapdom.toRaw(styleHeavy, { cache: 'disabled' })
  }, benchOpts)

  bench('cold-repeated-rows-1600', async () => {
    await snapdom.toRaw(repeated, { cache: 'disabled' })
  }, benchOpts)
})

describe('optimization scientist: clip culling', () => {
  let page
  beforeAll(() => {
    page = mount(makeClipPage())
  })
  afterAll(() => page?.remove())

  bench('clip-viewport-1000', async () => {
    window.scrollTo(0, 0)
    await snapdom.toRaw(page, { cache: 'disabled', clip: 'viewport' })
  }, benchOpts)
})

describe('optimization scientist: pseudo and text path', () => {
  let fixture
  beforeAll(() => {
    fixture = makePseudoText()
    mount(fixture.root)
  })
  afterAll(() => {
    fixture?.root.remove()
    fixture?.style.remove()
  })

  bench('cold-pseudo-text-300', async () => {
    await snapdom.toRaw(fixture.root, { cache: 'disabled' })
  }, benchOpts)
})

describe('optimization scientist: warm repeated capture', () => {
  let medium
  beforeAll(() => {
    medium = mount(makeCardGrid())
  })
  afterAll(() => medium?.remove())

  bench('warm-medium-default-cache', async () => {
    await snapdom.toRaw(medium)
  }, benchOpts)
})
