import {build} from 'esbuild'
import sharp from 'sharp'
import ts from 'typescript'
import {promises as fs} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import path from 'node:path'
import {zipSync} from 'fflate'
const require=createRequire(import.meta.url),here=import.meta.dirname,root=path.resolve(here,'..'),app=path.join(root,'snapboard-v2'),payload=path.join(here,'payload')
await fs.mkdir(payload,{recursive:true});await fs.mkdir(path.join(here,'generated'),{recursive:true})
for(const name of ['site','seed']){const target=path.resolve(payload,name);if(!target.startsWith(payload+path.sep))throw Error('Unsafe staging path');await fs.rm(target,{recursive:true,force:true})}
const source=ts.createSourceFile('vite.config.ts',await fs.readFile(path.join(app,'vite.config.ts'),'utf8'),ts.ScriptTarget.Latest,true)
const excluded=new Set(['partLibraryWatcher','assemblyLibraryWatcher','systemControlApi'])
const code=source.statements.filter(n=>!ts.isExportAssignment(n)&&!(ts.isImportDeclaration(n)&&['vite','@vitejs/plugin-react','node:child_process'].includes(n.moduleSpecifier.text))&&!(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>excluded.has(d.name.getText(source))))).map(n=>n.getFullText(source)).join('\n')
await build({stdin:{contents:`import {spawn as nodeSpawn} from 'node:child_process';
const spawn=(command,args,options)=>nodeSpawn(command,[path.join(process.env.SNAPBOARD_SYNC_DIR,path.basename(args[0])),...args.slice(1)],{...options,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
`+code+`
export {authorizeMerchantRequest,verifyMerchantPayloadIntegrity} from '../apps/merchant-license/api.mjs';
export function installApis(server){for(const p of [merchantLicensingApi(),partCalibrationApi(),partPackImportApi(),partImportApi(),partBatchApi(),partGroupApi(),projectLibraryApi(),assemblyHostPackImportApi(),resourceManagementApi(),snapColorFarmApi(),importImageApi()])p.configureServer(server)}
`,resolveDir:app,loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(here,'generated/api.cjs')})
const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js');const result=spawnSync(process.execPath,[vite,'build','--mode','diy','--outDir',path.join(payload,'site')],{cwd:app,stdio:'inherit',windowsHide:true,env:{...process.env,VITE_SNAPBOARD_EDITION:'diy',VITE_DESIGNER_ONLY:'1',VITE_BASE:'/'}});if(result.status!==0)throw Error('UI build failed')
const seed=path.join(payload,'seed');for(const dir of ['public/partLibrary','配件资源包','装配资源包'])await fs.mkdir(path.join(seed,dir),{recursive:true})
for(const item of ['配件资源包/官方基础配件包','装配资源包'])await fs.cp(path.join(app,item),path.join(seed,item),{recursive:true,filter:p=>!p.split(path.sep).includes('90-用户导入')})
await fs.copyFile(path.join(app,'public/partLibrary/library.json'),path.join(seed,'public/partLibrary/library.json'))
await fs.mkdir(path.join(payload,'scripts'),{recursive:true});for(const n of ['sync-part-library.mjs','part-category-rules.mjs','sync-assembly-library.mjs','snapcolor_calibration_bridge.py'])await fs.copyFile(path.join(app,'scripts',n),path.join(payload,'scripts',n))
for(const name of ['sync-part-library.mjs','sync-assembly-library.mjs']){const r=spawnSync(process.execPath,[path.join(payload,'scripts',name)],{cwd:seed,stdio:'inherit',windowsHide:true});if(r.status!==0)throw Error('Seed build failed')}
for(const name of ['partLibrary','assemblyLibrary']){const target=path.join(payload,'site',name);if(!target.startsWith(payload+path.sep))throw Error('Unsafe site path');await fs.rm(target,{recursive:true,force:true})}
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])await fs.copyFile(path.join(root,name),path.join(payload,name))
const calibrationSource=process.env.SNAPBOARD_CALIBRATION_SOURCE,runtime=process.env.SNAPBOARD_CALIBRATION_RUNTIME
if(calibrationSource){await fs.cp(calibrationSource,path.join(payload,'calibration/source'),{recursive:true,filter:p=>!p.split(path.sep).includes('__pycache__')});await fs.copyFile(path.join(calibrationSource,'LICENSE'),path.join(payload,'LUMINA-LICENSE.txt'))}
if(runtime){await fs.access(path.join(runtime,'python.exe'));await fs.cp(runtime,path.join(payload,'python'),{recursive:true,filter:p=>!p.split(path.sep).includes('__pycache__')});const probe=spawnSync(path.join(payload,'python/python.exe'),[path.join(payload,'scripts/snapcolor_calibration_bridge.py')],{input:'{"action":"status"}',encoding:'utf8',windowsHide:true,cwd:seed,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',SNAPBOARD_CALIBRATION_SOURCE:path.join(payload,'calibration/source')}});if(probe.status!==0||!JSON.parse(probe.stdout||'{}').ok)throw Error('Bundled calibration runtime failed')}
const version=JSON.parse(await fs.readFile(path.join(here,'package.json'),'utf8')).version
await fs.writeFile(path.join(payload,'merchant-edition.json'),JSON.stringify({edition:'diy',dailyExports:10}))
await fs.writeFile(path.join(payload,'build-info.json'),JSON.stringify({version,edition:'diy',dailyExports:10,builtAt:new Date().toISOString(),seedPolicy:'official-starter-only',server:'https://auth.snapboard.cn'},null,2))
const sourceFiles={},collect=async(dir,prefix)=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink()||['node_modules','dist','output','.git','payload','generated'].includes(entry.name)||entry.name.startsWith('.env')||/\.(pem|key|pfx|p12)$/i.test(entry.name))continue;const filename=path.join(dir,entry.name),key=prefix+'/'+entry.name;if(entry.isDirectory())await collect(filename,key);else sourceFiles[key]=new Uint8Array(await fs.readFile(filename))}}
for(const dir of ['snapboard-v2/src','snapboard-v2/scripts','snapboard-v2/patches','apps/merchant-license','apps/order-workbench/shared','desktop','docs'])await collect(path.join(root,dir),dir)
for(const file of ['package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md','README.md','CHANGELOG.md','snapboard-v2/package.json','snapboard-v2/vite.config.ts','snapboard-v2/index.html','snapboard-v2/tsconfig.json','snapboard-v2/tsconfig.app.json','snapboard-v2/tsconfig.node.json'])sourceFiles[file]=new Uint8Array(await fs.readFile(path.join(root,file)))
await collect(path.join(seed,'配件资源包'),'snapboard-v2/配件资源包');await collect(path.join(seed,'装配资源包'),'snapboard-v2/装配资源包');await collect(path.join(app,'public/snapcolor'),'snapboard-v2/public/snapcolor');for(const file of ['favicon.svg','icons.svg','partLibrary/library.json'])sourceFiles['snapboard-v2/public/'+file]=new Uint8Array(await fs.readFile(path.join(app,'public',file)))
for(const dir of ['vendor/clipper-lib','vendor/libtess','vendor/lumina-studio/runtime-template'])await collect(path.join(root,dir),dir)
sourceFiles['snapboard-v2/.env.diy']=new Uint8Array(await fs.readFile(path.join(app,'.env.diy')));
await collect(path.join(app,'public/lattice-reference'),'snapboard-v2/public/lattice-reference');
if(calibrationSource)await collect(path.join(payload,'calibration/source'),'vendor/lumina-studio/source');
await fs.writeFile(path.join(payload,'SnapBoard-source.zip'),zipSync(sourceFiles,{level:6}))
const png=await sharp(path.join(app,'public/favicon.svg')).resize(256,256).png().toBuffer(),header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);await fs.writeFile(path.join(here,'icon.ico'),Buffer.concat([header,png]))
console.log('Prepared DIY payload. A trusted release signature is required before packaging or starting.')
