import { afterEach, describe, expect, it } from 'vitest'
import { snapdom } from '../src/index.js'
import { flushStyleInvalidations } from '../src/modules/styles.js'

const mounted = []

afterEach(() => {
  while (mounted.length) mounted.pop().remove()
  flushStyleInvalidations()
})

function scene(css, count = 24) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  mounted.push(style)
  const root = document.createElement('div')
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div')
    el.className = 'anim-rider-twin'
    el.textContent = String(i)
    root.appendChild(el)
  }
  document.body.appendChild(root)
  mounted.push(root)
  return root
}

async function rawArm(root, enabled) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushStyleInvalidations()
  return snapdom.toRaw(root, {
    burst: false,
    cache: 'disabled',
    embedFonts: false,
    __animationNameShare: enabled,
  })
}

describe('identity-share animation-name rider', () => {
  it('keeps a finished entry animation frozen exactly like the historical per-node read', async () => {
    const root = scene(`
      @keyframes animRiderFinished { from { opacity: 0 } to { opacity: 1 } }
      .anim-rider-twin {
        width: 20px; height: 8px; background: rgb(0, 0, 255);
        animation: animRiderFinished 1ms linear 1;
      }
    `)

    // Let the live CSS animations leave their active interval. The regression being protected
    // is clone restart: animation-name remains authored even after the live frame has settled.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await Promise.all(root.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})))

    const historical = await rawArm(root, false)
    const shared = await rawArm(root, true)
    expect(shared).toBe(historical)
  })

  it('keeps selector-partitioned animation names distinct between structural twins', async () => {
    const root = scene(`
      .anim-rider-twin { width: 20px; height: 8px; animation-name: none; }
      .anim-rider-twin:nth-child(2n) { animation-name: animRiderUndefined; }
    `)

    // No @keyframes rule is needed here: the computed animation-name itself is the semantic
    // value ANIMR1 reuses, and :nth-child must split the identity before that reuse can occur.
    const historical = await rawArm(root, false)
    const shared = await rawArm(root, true)
    expect(shared).toBe(historical)
  })
})
