import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

// Offline counterfactual only: retain the current mesh and machine/material
// recipe, changing just layer height to the screenshot's all-board fine profile.
// These files are not a supplied customer project and are never production output.
const directory='../output/slicing-profile-audit-20261004'
const geometryHash=zip=>createHash('sha256').update(Object.keys(zip).filter(name=>name.endsWith('.model')).sort().map(name=>name+'\n'+strFromU8(zip[name])).join('\n')).digest('hex')
const controls=[]
for(const name of ['full-bed-through-honeycomb-A1','full-bed-retained-honeycomb-A1']){
  const original=await readFile(`${directory}/${name}.3mf`),zip=unzipSync(original),before=geometryHash(zip)
  const settings=JSON.parse(strFromU8(zip['Metadata/project_settings.config']))
  assert.equal(settings.layer_height,'0.28');assert.equal(settings.initial_layer_print_height,'0.25')
  settings.layer_height='0.08'
  zip['Metadata/project_settings.config']=strToU8(JSON.stringify(settings,null,2))
  zip['Metadata/model_settings.config']=strToU8(strFromU8(zip['Metadata/model_settings.config']).replaceAll('<metadata key="layer_height" value="0.28"/>','<metadata key="layer_height" value="0.08"/>'))
  zip['Metadata/layer_config_ranges.xml']=strToU8('<?xml version="1.0" encoding="UTF-8"?><objects><object id="1"><range min_z="0" max_z="5"><option opt_key="layer_height">0.08</option></range></object></objects>')
  assert.equal(geometryHash(zip),before,'counterfactual changes no XYZ, triangles, placement or thickness')
  const bytes=zipSync(zip),file=`simulated-all-fine-${name}.3mf`
  await writeFile(`${directory}/${file}`,bytes)
  controls.push({original:`${name}.3mf`,originalSha256:createHash('sha256').update(original).digest('hex'),file,sha256:createHash('sha256').update(bytes).digest('hex'),geometrySha256:before,geometryUnchanged:true,scope:'模拟同网格A1/同工艺全板0.08层高，非用户原件；不作为生产导出'})
}
await writeFile(`${directory}/controlled-fine-inputs.json`,JSON.stringify(controls,null,2))
console.log('PASS controlled input geometry identities',controls.map(({file,geometrySha256})=>({file,geometrySha256})))
