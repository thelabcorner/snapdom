import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ROOT = process.cwd()
const workflowPath = path.resolve(ROOT, '.github/workflows/r9-calibration.yml')
const source = fs.readFileSync(workflowPath, 'utf8')

function stepBlock(name) {
  const needle = `      - name: ${name}\n`
  const start = source.indexOf(needle)
  assert.notEqual(start, -1, `missing step ${name}`)
  const next = source.indexOf('\n      - name: ', start + needle.length)
  return source.slice(start, next === -1 ? source.length : next)
}

test('calibration workflow keeps the expected job graph', () => {
  for (const job of ['prepare', 'chromium', 'engines', 'closeout']) {
    assert.match(source, new RegExp(`^  ${job}:$`, 'm'))
  }
})

test('immutable prepared artifact is stable across workflow attempts', () => {
  const upload = stepBlock('Upload immutable prepared evidence')
  assert.match(upload, /name: r9-cal-prepared-\$\{\{ github\.run_id \}\}/)
  assert.match(upload, /overwrite: true/)

  const downloads = [...source.matchAll(/name: r9-cal-prepared-\$\{\{ github\.run_id \}\}/g)]
  assert.equal(downloads.length, 4, 'one upload plus three downloads must share the stable prepared identity')
})

test('each preregistered sample cell has a stable overwriteable artifact identity', () => {
  const chromium = stepBlock('Upload raw calibration evidence')
  assert.match(
    chromium,
    /name: r9-cal-sample-chromium-r\$\{\{ matrix\.replicate \}\}-\$\{\{ github\.run_id \}\}/,
  )
  assert.match(chromium, /overwrite: true/)

  const engineStart = source.indexOf('  engines:')
  const engineUploadStart = source.indexOf('      - name: Upload raw calibration evidence', engineStart)
  assert.notEqual(engineUploadStart, -1)
  const engineUploadEnd = source.indexOf('\n  closeout:', engineUploadStart)
  const engineUpload = source.slice(engineUploadStart, engineUploadEnd)
  assert.match(
    engineUpload,
    /name: r9-cal-sample-\$\{\{ matrix\.entry\.engine \}\}-r\$\{\{ matrix\.entry\.replicate \}\}-\$\{\{ github\.run_id \}\}/,
  )
  assert.match(engineUpload, /overwrite: true/)
})

test('closeout combines successful earlier-attempt cells with retried cells', () => {
  const download = stepBlock('Download every calibration sample')
  assert.match(download, /pattern: r9-cal-sample-\*-\$\{\{ github\.run_id \}\}/)

  const upload = stepBlock('Upload calibration closeout')
  assert.match(upload, /name: r9-calibration-summary-\$\{\{ github\.run_id \}\}/)
  assert.match(upload, /overwrite: true/)
})

test('artifact addressing never depends on github.run_attempt', () => {
  assert.equal(source.includes('github.run_attempt'), false)
})
