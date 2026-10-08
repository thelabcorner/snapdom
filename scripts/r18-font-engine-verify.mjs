import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root=resolve(process.argv[2]||'r18-engine-evidence')
const engines=['chromium','firefox','webkit']
const scenarios=['font-repeat-1200','font-fallback-1200','font-entropy-350','font-repeat-400','font-phase-off']
let pairs=0
for(const engine of engines){
  const report=JSON.parse(await readFile(resolve(root,engine+'.json'),'utf8'))
  if(report.schema!=='snapdom-r18-font-cross-engine-v1'||report.engine!==engine||
     report.baselineSha!=='ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b'||
     report.candidateSha!=='70045ebd68a276554ef50151ce2505e772689e6a'||
     report.scenarios?.length!==scenarios.length)throw Error('R18 provenance mismatch '+engine)
  for(let i=0;i<scenarios.length;i++){
    const sc=report.scenarios[i]
    if(sc.scenario?.name!==scenarios[i]||sc.exactRaw!==true||sc.exactPixels!==true||
       sc.pairs?.length!==8||sc.pairs.filter(p=>p.order==='AB').length!==4||
       sc.pairs.filter(p=>p.order==='BA').length!==4)
      throw Error('R18 incomplete parity '+engine+' '+scenarios[i])
    for(const p of sc.pairs){
      if(!/^[a-f0-9]{64}$/.test(p.rawSha256)||!(p.A?.ms>0&&p.B?.ms>0))
        throw Error('R18 incomplete capture '+engine+' '+scenarios[i])
      pairs++
    }
  }
}
if(pairs!==120)throw Error('R18 missing exact pairs')
console.log('R18_FONT_THREE_ENGINE_ACCEPTED; engines=3 scenarios=15 pairs='+pairs)
