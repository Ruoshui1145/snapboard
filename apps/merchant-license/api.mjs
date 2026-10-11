import {diyQuotaClient} from './diy-quota-client.mjs'
import {json,readJson} from './http.mjs'
export function commercialCapability(req,pathname){const u=new URL(pathname,'http://local');return ['POST','PUT','PATCH'].includes(req.method)&&((u.pathname==='/api/project-library/export'&&!/\.png$/i.test(u.searchParams.get('filename')||''))||(u.pathname==='/api/native-manufacture'&&!u.searchParams.has('job')))?'commercial.export':null}
const sameOrigin=req=>/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host||'')&&(!req.headers.origin||req.headers.origin==='http://'+req.headers.host)&&req.headers['sec-fetch-site']!=='cross-site'
export async function authorizeMerchantRequest(req,res,pathname,client){
 if(pathname.startsWith('/api/farm-orders')){json(res,{error:'个人玩家版不提供农场订单服务'},403);return false}
 if(!commercialCapability(req,pathname))return true
 if(!sameOrigin(req)){json(res,{error:'请从本机软件进行导出'},403);return false}
 try{client||=diyQuotaClient();const ticket=req.headers['x-snapboard-export-ticket'];await client.assertTicket(ticket);req.snapboardDiyQuotaClient=client
 if(new URL(pathname,'http://local').pathname==='/api/project-library/export'){
 const key=await client.claimDelivery(ticket);req.snapboardDiyDeliveryKey=key
 res.once('close',()=>{void client.abortDelivery(ticket,key).catch(()=>{})})
 res.once('finish',()=>{if(res.statusCode>=400)void client.abortDelivery(ticket,key).catch(()=>{})})
 }return true
 }catch(e){json(res,{error:e.message,code:e.code||'DIY_QUOTA_REQUIRED',dataAccess:'preserved'},e.status||403);return false}
}
export async function handleMerchantLicenseApi(req,res,pathname,client){
 if(!sameOrigin(req)){json(res,{error:'请从本机软件查看导出额度'},403);return}
 try{client||=diyQuotaClient();const url=new URL(pathname,'http://'+req.headers.host),action=url.pathname.replace(/^\/api\/merchant-license/,'')||'/'
 if(req.method==='GET'&&action==='/'){json(res,await client.status({force:url.searchParams.get('refresh')==='1'}));return}
 if(req.method==='POST'&&['/begin-export','/complete-export','/cancel-export'].includes(action)){
 const value=await readJson(req);if(!value||Object.keys(value).some(k=>k!=='ticket'))throw Error('导出额度请求无效')
 json(res,action==='/begin-export'?await client.begin():action==='/complete-export'?await client.commit(value.ticket):await client.cancel(value.ticket));return}
 json(res,{error:'接口不存在'},404)
 }catch(e){json(res,{error:e.message,code:e.code,dataAccess:'preserved'},e.status||400)}
}
export async function startDiyDelivery(req,target,expectedBytes){await (req.snapboardDiyQuotaClient||diyQuotaClient()).deliveryIntent(req.headers['x-snapboard-export-ticket'],req.snapboardDiyDeliveryKey,target,expectedBytes)}
export async function finishDiyDelivery(req){await (req.snapboardDiyQuotaClient||diyQuotaClient()).commit(req.headers['x-snapboard-export-ticket'])}
export function merchantLicensingApi(){return{name:'snapboard-diy-quota',configureServer(server){server.middlewares.use('/api/merchant-license',(req,res)=>handleMerchantLicenseApi(req,res,'/api/merchant-license'+req.url));server.middlewares.use('/api',async(req,res,next)=>{if(await authorizeMerchantRequest(req,res,'/api'+req.url))next()})}}}

export {verifyMerchantPayloadIntegrity} from './integrity.mjs'
