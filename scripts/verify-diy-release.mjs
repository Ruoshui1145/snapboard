import assert from 'node:assert/strict'
import {promises as fs} from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {generateKeyPairSync,randomUUID,randomBytes,verify} from 'node:crypto'
import {createServer as createVite} from 'vite'
import {createDiyQuotaClient} from '../apps/merchant-license/diy-quota-client.mjs'
import {authorizeMerchantRequest,handleMerchantLicenseApi} from '../apps/merchant-license/api.mjs'
import {signJwt,hash,diyQuotaMessage} from '../apps/merchant-license/crypto.mjs'
import {beijingDay,quotaDayEnd} from '../apps/merchant-license/diy-quota-ledger.mjs'
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'output/release-verification');await fs.mkdir(output,{recursive:true})
const temp=await fs.mkdtemp(path.join(output,'diy-')),priorCwd=process.cwd(),require=createRequire(import.meta.url),key=randomBytes(32)
const authority=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}})
let now=Date.parse('2026-10-11T10:00:00+08:00'),offline=false,mode='normal',wire=0,local,renderer
const identities=new Map(),seen=new Set(),checks=[]
const transport=async(_url,options)=>{
 assert.equal(options.headers.Accept,'application/json');assert.equal(options.redirect,'error');if(offline)throw Error('Synthetic offline')
 const request=JSON.parse(options.body);assert.deepEqual(Object.keys(request).sort(),['completed','device','issuedAt','nonce','signature'])
 assert.ok(verify(null,diyQuotaMessage(request),request.device.publicKey,Buffer.from(request.signature,'base64url')))
 assert.ok(!seen.has(request.nonce));seen.add(request.nonce);wire++
 let row=identities.get(request.device.deviceId);if(!row){row={id:randomUUID(),applicationId:randomUUID(),days:new Map()};identities.set(request.device.deviceId,row)}
 const day=beijingDay(now);let bucket=row.days.get(day);if(!bucket){bucket={ids:Array.from({length:10},()=>randomUUID()),spent:new Set()};row.days.set(day,bucket)}
 for(const receipt of request.completed){const old=row.days.get(receipt.day);assert.ok(old?.ids.includes(receipt.id));old.spent.add(receipt.id)}
 const claims={licenseId:row.id,applicationId:row.applicationId,deviceId:request.device.deviceId,deviceKeyHash:hash(request.device.publicKey),nonce:request.nonce,day,limit:10,used:bucket.spent.size,permitIds:bucket.ids.filter(id=>!bucket.spent.has(id)),iat:Math.floor(now/1000),exp:quotaDayEnd(day)/1000}
 if(mode==='unmetered')Object.assign(claims,{unmetered:true,limit:null,used:0,permitIds:[]})
 let proof=signJwt(claims,authority.privateKey,'diy-quota');if(mode==='forged')proof=proof.slice(0,-5)+'AAAAA'
 return new Response(JSON.stringify({proof}),{status:200})
}
const makeClient=directory=>createDiyQuotaClient({directory,publicKey:authority.publicKey,controllerUrl:'http://127.0.0.1:5199',storageKey:key,localSimulation:true,clock:()=>now,fetcher:transport})
let client=makeClient(path.join(temp,'device'))
try{
 assert.equal((await client.status({force:true})).quota.remaining,10)
 const cancelled=await client.begin();assert.equal(cancelled.status.quota.remaining,9);await client.cancel(cancelled.ticket);assert.equal((await client.status()).quota.remaining,10);checks.push('cancel releases the reservation without consuming the daily allowance')
 const compiled=require('../desktop/generated/api.cjs'),originalInstall=compiled.installApis
 const authorizedRequest=(req,res,route)=>authorizeMerchantRequest(req,res,route,client)
 const installApis=server=>originalInstall({...server,middlewares:{use:(route,handler)=>server.middlewares.use(route,route==='/api/merchant-license'?(req,res)=>handleMerchantLicenseApi(req,res,'/api/merchant-license'+req.url,client):handler)}})
 require.cache[require.resolve('../desktop/generated/api.cjs')].exports={...compiled,authorizeMerchantRequest:authorizedRequest,installApis}; const {createServer}=require('../desktop/server.cjs');local=await createServer({dataRoot:path.join(temp,'data'),payload:path.join(root,'desktop/payload')})
 const headers={'Cookie':'snapboard_session='+local.token,Origin:local.origin,'Content-Type':'application/octet-stream'}
 renderer=await createVite({root:path.join(root,'snapboard-v2'),configFile:false,logLevel:'silent',appType:'custom',server:{middlewareMode:true,hmr:false,ws:false}})
 const [{createSplitPanels3MF},{PEGBOARD_DEFAULT_CONFIG,splitOrthogonalPolygon}]=await Promise.all([renderer.ssrLoadModule('/src/utils/export3mf.ts'),renderer.ssrLoadModule('/src/utils/pegboardSplit.ts')])
 const split=splitOrthogonalPolygon({points:[{x:0,y:0},{x:80,y:0},{x:80,y:80},{x:0,y:80}],holes:[]},PEGBOARD_DEFAULT_CONFIG)
 const bytes=createSplitPanels3MF(split.panels,PEGBOARD_DEFAULT_CONFIG,'Synthetic personal-edition check')
 for(let i=0;i<10;i++){
 const {ticket}=await client.begin(),url=local.origin+'/api/project-library/export?filename=synthetic-'+i+'.3mf'
 const response=await fetch(url,{method:'POST',headers:{...headers,'x-snapboard-export-ticket':ticket},body:bytes});assert.equal(response.status,200,await response.text());await client.commit(ticket)
 const saved=await fs.readFile(path.join(temp,'data/已保存项目/制造导出/synthetic-'+i+'.3mf'));assert.deepEqual(saved,Buffer.from(bytes))
 assert.equal((await fetch(url,{method:'POST',headers:{...headers,'x-snapboard-export-ticket':ticket},body:bytes})).status,403)
 }
 assert.equal((await client.status({force:true})).quota.remaining,0);await assert.rejects(client.begin(),e=>e.code==='DIY_QUOTA_EXHAUSTED');checks.push('10 real 3MF saves succeed, repeated save ticket is rejected, and the 11th export is refused')
 client=makeClient(path.join(temp,'device'));assert.equal((await client.status({force:true})).quota.remaining,0);checks.push('restart preserves consumed daily allowance')
 assert.equal((await fetch(local.origin+'/api/merchant-license',{headers:{Cookie:headers.Cookie,Origin:'https://evil.invalid'}})).status,403)
 assert.equal((await fetch(local.origin+'/api/farm-orders/orders',{method:'POST',headers,body:'{}'})).status,403);checks.push('cross-origin requests and farm routes remain rejected')
 now=Date.parse('2026-10-12T00:00:01+08:00');assert.equal((await client.status({force:true})).quota.remaining,10);checks.push('Beijing midnight refresh provides a new signed 10-export allowance')
 offline=true;await client.status({force:true});const queued=await client.begin();await client.commit(queued.ticket);assert.equal((await client.status()).quota.remaining,9);offline=false;assert.equal((await client.status({force:true})).quota.remaining,9);checks.push('already signed allowance works offline and later synchronization does not charge twice')
 for(const bad of ['unmetered','forged']){mode=bad;const invalid=makeClient(path.join(temp,bad));assert.equal((await invalid.status({force:true})).commercialAllowed,false);await assert.rejects(invalid.begin());}mode='normal';checks.push('signed unlimited policy and forged signatures are both rejected by this 10-export edition')
 const entries=await fs.readdir(path.join(temp,'data/已保存项目/制造导出'));assert.equal(entries.length,10)
 await fs.writeFile(path.join(output,'diy-release.json'),JSON.stringify({passed:true,checks,actual3mfFileSaves:10,wireRequests:wire,productionServerTested:false,guiTested:false},null,2));console.log('PASS personal release: '+checks.length+' checks, 10 real 3MF saves, 11th refused, restart/midnight/offline/security boundaries')
}finally{process.chdir(priorCwd);if(local)await new Promise(resolve=>{local.server.close(resolve);local.server.closeAllConnections()});await renderer?.close();const target=path.resolve(temp);if(!target.startsWith(path.resolve(output)+path.sep))throw Error('Unsafe test cleanup');await fs.rm(target,{recursive:true,force:true,maxRetries:4,retryDelay:100})}
