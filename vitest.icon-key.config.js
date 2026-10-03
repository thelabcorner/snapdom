// Browser-free lane for the pure RS-A10 key/invalidation proofs.
//
// The main suite (vitest.config.js) runs every __tests__ file inside a real browser, which is
// correct for the capture tests and wrong for these: iconRaster.js imports nothing and reads no
// globals, so proving the key and its invalidation needs no engine. Keeping them here means the
// proof runs in seconds on a laptop with no Playwright browser downloaded, and cannot silently
// come to depend on one.
//
// `npm run test:icon-key` — no browser, no network, no timing.
// The same file is still picked up by the default browser suite, because it is browser-safe.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__tests__/module.iconRaster.key.test.js'],
    environment: 'node',
    browser: { enabled: false },
    // Nothing in this lane may reach the network; a silent fallback that made an invalidation
    // proof pass would be worse than no proof at all.
    env: { SNAPDOM_ICON_KEY_OFFLINE: '1' },
  },
})