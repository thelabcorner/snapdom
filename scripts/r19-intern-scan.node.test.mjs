import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import test from 'node:test'

const current = readFileSync(new URL('../src/engines/svg.js', import.meta.url), 'utf8')
const legacy = execFileSync('git', ['show', 'cac07a4108086718bc9511663346e1b9fcf4e226:src/engines/svg.js'], { encoding: 'utf8' })
function compile(source) {
  const begin = source.indexOf('function internInlineStyles(foString, fo) {')
  const end = source.indexOf('\n/** Signatures that cannot trade inline precedence', begin)
  assert.ok(begin >= 0 && end > begin, 'extract only actual production implementation')
  return new Function('isSafari', 'inlineStylesThatMustStay', source.slice(begin, end) + '\nreturn internInlineStyles')(
    () => false, (_fo, _hasAuthorStyles, _hasEditableAssets) => new Set()
  )
}
const original = compile(legacy)
const candidate = compile(current)
let seed = 0x1234abca
function rand() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
const styles = ['color:red;line-height:18px', 'font-weight:700', 'width:3px; &amp; spacing', 'padding:0 3px', '', 'stroke:blue;fill:#000', 'display:flex;align-items:center', 'color:&quot;quoted&quot;']
function fixture(count, imageBytes, authorStyles = false) {
  const css = authorStyles ? '<style>.foo{content:" style=\\\"fake\\\""} p{color:red}</style>' : ''
  let markup = '<foreignObject><style>.a{color:teal}</style>' + css + '<div>'
  for (let i=0; i<count; i++) {
    const value = styles[rand() % styles.length]
    markup += '<div data-test="' + i + '" style="' + value + '"><span style="' + styles[rand() % styles.length] + '">txt</span></div>'
    if (imageBytes > 0 && i === count >>> 1) markup += '<img src="data:image/png;base64,' + 'Q'.repeat(imageBytes) + '"/>'
  }
  return markup + '</div></foreignObject>'
}
for (let i=0; i<1000; i++) {
  const count = rand() % 35
  let html = fixture(count, 0, (i % 5 === 0))
  if (i % 3 === 0) html += ' style="trailing"'
  if (i % 11 === 0) html += '<style> style="ignore this"</style>'
  assert.equal(candidate(html, null), original(html, null), 'fuzz iteration ' + i)
}
test('1000 seeded differential intern-output fixtures', () => assert.ok(true))
for (const bytes of [0, 1024*1024, 8*1024*1024, 24*1024*1024]) {
  for (const count of [0, 2, 64, 512, 2500]) {
    const html = fixture(count, bytes, count > 100)
    assert.equal(candidate(html, null), original(html, null), 'payload ' + bytes + ' nodes '+count)
  }
}
test('20 large-payload differential fixtures', () => assert.ok(true))
function timed(fn, input) {
  for (let i=0;i<3;i++) fn(input, null)
  const arr=[]
  for(let i=0;i<15;i++) {
    const t=performance.now()
    fn(input, null)
    arr.push(performance.now()-t)
  }
  return arr.sort((a,b)=>a-b)[7]
}
if (process.env.SNAPDOM_R19_BENCH === '1') {
  for(const [name, nodes, payload] of [
    ['image-no-intern', 0, 16*1024*1024],
    ['image-rare-style', 4, 16*1024*1024],
    ['image-heavy-table', 2500, 16*1024*1024],
    ['text-heavy-table', 2500, 0],
    ['small-mixed', 100, 16*1024],
  ]) {
    const html=fixture(nodes,payload,false)
    // Both orders alternated to avoid consistently favoring the second variant.
    const a=timed(original,html); const b=timed(candidate,html)
    const b2=timed(candidate,html);const a2=timed(original,html)
    const old=(a+a2)/2; const now=(b+b2)/2
    console.log(JSON.stringify({name,bytes:html.length,oldMs:Number(old.toFixed(4)),candidateMs:Number(now.toFixed(4)),changePct:Number(((now/old-1)*100).toFixed(2))}))
  }
}
