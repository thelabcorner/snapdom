import { chromium, firefox, webkit } from 'playwright'

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const out = await page.evaluate(() => {
      const cases = [
        'CONTAINER-TYPE:inline-size;WIDTH:2CQW',
        'Container-Name:foo;height:3CqH',
        String.raw`container-type:inline-size;width:2c\71 w`,
        String.raw`font-size:calc(1px + 2c\71 w)`,
      ]
      return cases.map((text) => {
        const el = document.createElement('div')
        el.setAttribute('style', text)
        const s = el.style
        return {
          input: text,
          cssText: s.cssText,
          names: Array.from({ length: s.length }, (_, i) => s[i]),
          values: Array.from({ length: s.length }, (_, i) => [s[i], s.getPropertyValue(s[i])]),
        }
      })
    })
    console.log(JSON.stringify({ engine: name, cases: out }))
  } finally {
    await browser.close()
  }
}
