#!/usr/bin/env node
// Cross-engine CSSOM basis probe for BGS1. Mechanism semantics only; NO timing claim.
import { chromium, firefox, webkit } from 'playwright'

const DATA = 'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")'
const props = [
  'mask-image', '-webkit-mask-image', 'mask-source',
  'mask-box-image-source', 'mask-border-source', '-webkit-mask-box-image-source',
  'border-image-source',
]
const shorthands = [
  ['mask', `${DATA} center / cover no-repeat`],
  ['-webkit-mask', `${DATA} center / cover no-repeat`],
  ['mask-border', `${DATA} 30`],
  ['-webkit-mask-box-image', `${DATA} 30`],
  ['border-image', `${DATA} 30`],
]

for (const [engine, bt] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await bt.launch({ headless: true })
  const page = await browser.newPage()
  try {
    const { rows, shorthandRows } = await page.evaluate(({ props, shorthands, DATA }) => {
      const out = []
      for (const authored of props) {
        const el = document.createElement('div')
        el.style.setProperty(authored, DATA)
        document.body.appendChild(el)
        const accepted = !!el.style.getPropertyValue(authored)
        const cs = getComputedStyle(el)
        const values = Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)]))
        out.push({ authored, accepted, values })
        el.remove()
      }
      const shorthandOut = []
      for (const [authored, value] of shorthands) {
        const el = document.createElement('div')
        el.style.setProperty(authored, value)
        document.body.appendChild(el)
        const accepted = !!el.style.getPropertyValue(authored)
        const cs = getComputedStyle(el)
        const values = Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)]))
        shorthandOut.push({ authored, accepted, values })
        el.remove()
      }
      return { rows: out, shorthandRows: shorthandOut }
    }, { props, shorthands, DATA })
    console.log(`\n${engine}`)
    for (const row of rows) {
      const seen = Object.entries(row.values).filter(([, v]) => v && v !== 'none').map(([p]) => p)
      console.log(`${row.authored.padEnd(31)} accepted=${String(row.accepted).padEnd(5)} visible=[${seen.join(', ')}]`)
    }
    console.log('shorthands')
    for (const row of shorthandRows) {
      const seen = Object.entries(row.values).filter(([, v]) => v && v !== 'none').map(([p]) => p)
      console.log(`${row.authored.padEnd(31)} accepted=${String(row.accepted).padEnd(5)} visible=[${seen.join(', ')}]`)
    }
  } finally {
    await browser.close()
  }
}
