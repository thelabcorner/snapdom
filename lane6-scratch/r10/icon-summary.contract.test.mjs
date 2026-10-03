import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SCRIPT = path.resolve(process.cwd(), 'lane6-scratch/r10/summarize.mjs')
const browsers = ['chromium', 'firefox', 'webkit']
const replicates = [0, 1, 2, 3]
const gitSha = 'a'.repeat(40)
const bundleSha = 'b'.repeat(64)

function fixture(name, mode, nodes, distinct, mean) {
  return {
    selfContainedPass: true,
    parity: true,
    countersParity: true,
    meta: { mode },
    counters: mode === 'icons'
      ? { iconRects: nodes, pngEncodes: nodes, fontLoads: nodes, fontReadies: 0 }
      : { iconRects: 0, pngEncodes: 0, fontLoads: 0, fontReadies: 0 },
    ceiling: {
      iconNodes: nodes,
      distinctKeys: distinct,
      avoidableLayouts: Math.max(0, nodes - distinct),
    },
    candidate: { pct: 0 },
    layoutsPlaceholder: true,
    _mean: mean,
  }
}

function report(browser, replicate) {
  const fixtures = {
    'no-icon-120': fixture('no-icon-120', 'none', 0, 0, 10),
    'icon-distinct-120': fixture('icon-distinct-120', 'icons', 120, 120, 34),
    'icon-repeat-120': fixture('icon-repeat-120', 'icons', 120, 1, 42),
    'icon-repeat-12x10': fixture('icon-repeat-12x10', 'icons', 120, 12, 39),
  }
  const effectForward = {}
  for (const [name, fx] of Object.entries(fixtures)) {
    effectForward[name] = { slot1: { mean: fx._mean + replicate * 0.01 } }
    delete fx._mean
  }
  return {
    schema: 'snapdom-r9-hosted-bench-v1',
    provenance: {
      browser: { actualName: browser },
      protocol: { suite: 'icon', mode: 'option-pair' },
      git: { candidateSha: gitSha, baselineSha: gitSha },
      bundles: {
        candidate: { sha256: bundleSha },
        baseline: { sha256: bundleSha },
      },
    },
    fixtures,
    layouts: { effectForward },
  }
}

function makeMatrix() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdom-icon-summary-'))
  const input = path.join(root, 'inputs')
  fs.mkdirSync(input, { recursive: true })
  for (const browser of browsers) {
    for (const replicate of replicates) {
      fs.writeFileSync(
        path.join(input, `icon-ceiling-${browser}-r${replicate}.json`),
        JSON.stringify(report(browser, replicate)),
      )
    }
  }
  return { root, input }
}

function run(root, input) {
  return spawnSync(process.execPath, [SCRIPT, `--input-dir=${input}`], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('icon ceiling closeout accepts exactly the complete 12-cell matrix', () => {
  const { root, input } = makeMatrix()
  try {
    const proc = run(root, input)
    assert.equal(proc.status, 0, proc.stderr || proc.stdout)
    const summary = JSON.parse(fs.readFileSync(path.join(root, 'lane6-scratch/r10/summary.json'), 'utf8'))
    assert.equal(summary.complete, true)
    assert.equal(summary.allGatesHeld, true)
    assert.equal(summary.expectedCells, 12)
    assert.equal(summary.observedCells, 12)
    assert.equal(summary.candidateGitSha, gitSha)
    assert.equal(summary.bundleSha256, bundleSha)
    assert.deepEqual(summary.rows.map((x) => [x.engine, x.replicates]), [
      ['chromium', 4], ['firefox', 4], ['webkit', 4],
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('icon ceiling closeout fails when one preregistered cell is missing', () => {
  const { root, input } = makeMatrix()
  try {
    fs.unlinkSync(path.join(input, 'icon-ceiling-webkit-r3.json'))
    const proc = run(root, input)
    assert.notEqual(proc.status, 0)
    assert.match(proc.stderr, /missing preregistered cells: webkit:3/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('icon ceiling closeout fails on mixed git identity', () => {
  const { root, input } = makeMatrix()
  try {
    const p = path.join(input, 'icon-ceiling-firefox-r2.json')
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
    doc.provenance.git.candidateSha = 'c'.repeat(40)
    doc.provenance.git.baselineSha = 'c'.repeat(40)
    fs.writeFileSync(p, JSON.stringify(doc))
    const proc = run(root, input)
    assert.notEqual(proc.status, 0)
    assert.match(proc.stderr, /expected one measured git identity/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
