// Bambu Studio's GPL-3.0 profiles, resolved once at development time. No slicer installation is required by the app.
import { readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'vite'
const directory=process.env.SNAPBOARD_BAMBU_PROFILES??'D:/Bambu Studio/resources/profiles/BBL'
const server=await createServer({appType:'custom',server:{middlewareMode:true}})
try {
  const {BAMBU_PRINTER_PRESETS}=await server.ssrLoadModule('/src/utils/bambuPrinterPresets.ts')
  const cache=new Map()
  async function resolve(type,name) {
    const key=`${type}/${name}`
    if(cache.has(key))return cache.get(key)
    const raw=JSON.parse(await readFile(join(directory,type,`${name}.json`),'utf8'))
    const result={}
    if(raw.inherits)Object.assign(result,await resolve(type,raw.inherits))
    for(const included of raw.include??[])Object.assign(result,await resolve(type,included))
    Object.assign(result,raw)
    for(const key of ['type','name','inherits','include','from','setting_id','instantiation','description','compatible_printers_condition'])delete result[key]
    cache.set(key,result);return result
  }
  const result={source:'BambuStudio 02.08.02.60 official BBL profiles (GPL-3.0)',printers:{}}
  for(const printer of BAMBU_PRINTER_PRESETS){
    const machine=await resolve('machine',printer.profile),process=await resolve('process',printer.defaultPrintProfile)
    const filament=await resolve('filament',printer.defaultFilamentProfile)
    result.printers[printer.id]={...machine,...process,...filament}
    console.log(printer.id,Object.keys(result.printers[printer.id]).length)
  }
  const rows=Object.values(result.printers),common={}
  for(const [key,value]of Object.entries(rows[0]))if(rows.every(row=>JSON.stringify(row[key])===JSON.stringify(value))){
    common[key]=value;for(const row of rows)delete row[key]
  }
  result.common=common
  await writeFile('src/assets/woodgrain-bambu-printer-configs.json',JSON.stringify(result))
}finally{await server.close()}
