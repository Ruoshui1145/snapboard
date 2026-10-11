import assert from 'node:assert/strict'
import {readFile,access} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..'),files=execFileSync('git',['ls-files','-z'],{cwd:root}).toString('utf8').split(String.fromCharCode(0)).filter(Boolean),failures=[]
for(const name of files){
 const segments=name.split('/'),base=path.basename(name)
 if(segments.some(s=>['node_modules','output','workspace-data','商业运营','.local'].includes(s))||['.pem','.key','.vault','.pfx','.p12'].includes(path.extname(name))||base.startsWith('.env')&&name!=='snapboard-v2/.env.diy'&&base!=='.env.example')failures.push(name)
 if((name.startsWith('apps/site-management/')||name.startsWith('apps/order-workbench/'))&&!name.startsWith('apps/order-workbench/shared/'))failures.push(name)
 const data=await readFile(path.join(root,name));if(data.includes(0))continue;let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data)}catch{continue}
 if(['','RSA ','EC ','OPENSSH ','ENCRYPTED '].some(kind=>text.includes('-----BEGIN '+kind+'PRIVATE KEY-----')))failures.push(name+' contains private key material')
}
assert.deepEqual(failures,[],'Public snapshot contains excluded files')
for(const file of ['README.md','CHANGELOG.md','docs/GETTING_STARTED.md','docs/PERSONAL_EDITION.md','docs/README.md']){
 const text=await readFile(path.join(root,file),'utf8'),targets=[...text.matchAll(/src="([^"]+)"/g)].map(m=>m[1]);let start=0
 while((start=text.indexOf('](',start))!==-1){const end=text.indexOf(')',start+2);if(end===-1)break;targets.push(text.slice(start+2,end));start=end+1}
 for(const target of targets){if(target.startsWith('http:')||target.startsWith('https:')||target.startsWith('#'))continue;await access(path.resolve(path.dirname(path.join(root,file)),target.split('#')[0]))}
}
const [rootPkg,front,desktop,policy]=await Promise.all(['package.json','snapboard-v2/package.json','desktop/package.json','apps/merchant-license/policy.json'].map(async f=>JSON.parse(await readFile(path.join(root,f),'utf8'))))
assert.equal(rootPkg.version,front.version);assert.equal(front.version,desktop.version);assert.equal(desktop.snapboardEdition,'diy');assert.equal(policy.controllerUrl,'https://auth.snapboard.cn');assert.equal(policy.localSimulation,false)
assert.equal((await readFile(path.join(root,'apps/merchant-license/diy-quota-ledger.mjs'),'utf8')).includes('openDiyQuotaLedger'),false)
console.log('PASS public snapshot: '+files.length+' tracked files; no private backend, keys, user data or stale generated bundles; current documentation links and production personal policy checked')