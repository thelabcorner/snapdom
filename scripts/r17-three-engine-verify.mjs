import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const dir=resolve(process.argv[2]||'r17-engine-evidence')
const engines=['chromium','firefox','webkit']
const expectedScenarios=['mixed-straggler','html-straggler','svg-straggler','mixed-fast','mixed-small','inline-control']
let total=0
for(const engine of engines){
  const report=JSON.parse(await readFile(resolve(dir,engine+'.json'),'utf8'))
  if(report.schema!=='snapdom-r17-cross-engine-v1'||report.engine!==engine||
     report.baselineSha!=='ce135fbfb73e358e99cfab266cb2ef5ffcff4d8b'||
     report.candidateSha!=='5261af4114f5886d71645126ef26ecd74078e771'||
     report.scenarios?.length!==expectedScenarios.length)
    throw Error('invalid '+engine+' source provenance/scenario count')
  for(let i=0;i<expectedScenarios.length;i++){
    const sc=report.scenarios[i]
    if(sc.scenario?.name!==expectedScenarios[i]||sc.exactRaw!==true||sc.exactPixels!==true||sc.pairs?.length!==8)
      throw Error('incomplete '+engine+' '+expectedScenarios[i]+' raw/pixel evidence')
    if(sc.pairs.filter(p=>p.order==='AB').length!==4||
       sc.pairs.filter(p=>p.order==='BA').length!==4)throw Error('unbalanced '+engine)
    for(const p of sc.pairs){
      if(!/^[a-f0-9]{64}$/.test(p.rawSha256)||!(p.A?.ms>0&&p.B?.ms>0))
        throw Error('missing raw hash or timing '+engine)
      if(p.A?.maxFlight>6||p.B?.maxFlight>6)throw Error('request ceiling violated '+engine)
      total++
    }
  }
}
if(total!==144)throw Error('need all 144 exact output pairs')
console.log('R17_THREE_ENGINE_FIDELITY_ACCEPTED; engines=3 scenarios=18 pairs='+total)
