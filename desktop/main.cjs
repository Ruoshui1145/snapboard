const {app,BrowserWindow,Menu,dialog,shell,session,safeStorage}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),{randomBytes}=require('node:crypto'),{spawn}=require('node:child_process');
const {createServer}=require('./server.cjs'),{initializeSeed}=require('./seed.cjs'),{createWorkspaceWindows}=require('./windows.cjs');
process.env.SNAPBOARD_EDITION='diy';delete process.env.SNAPBOARD_FARM_ACCOUNT_MODE;
app.setName('SnapBoard DIY');app.setPath('userData',path.join(app.getPath('appData'),'SnapBoard DIY'));
const payload=app.isPackaged?path.join(process.resourcesPath,'payload'):path.join(__dirname,'payload');let local,workspaces;
if(!app.requestSingleInstanceLock())app.quit();else{
app.on('second-instance',()=>{if(workspaces)void workspaces.open(local.origin+'/design').catch(e=>dialog.showErrorBox('打开失败',e.message))});
app.whenReady().then(async()=>{
 const userData=app.getPath('userData'),dataRoot=path.join(userData,'workspace');await fs.mkdir(dataRoot,{recursive:true});
 const {verifyMerchantPayloadIntegrity}=require('./generated/api.cjs');await verifyMerchantPayloadIntegrity(payload);
 const edition=JSON.parse(await fs.readFile(path.join(payload,'merchant-edition.json'),'utf8'));if(edition.edition!=='diy'||edition.dailyExports!==10)throw Error('个人版发行配置无效');
 const licenseRoot=path.join(dataRoot,'.merchant-license');await fs.mkdir(licenseRoot,{recursive:true});
 try{if(!safeStorage.isEncryptionAvailable())throw Error('系统保护不可用');const keyFile=path.join(licenseRoot,'vault-key.dpapi');let key;
 try{key=safeStorage.decryptString(await fs.readFile(keyFile))}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32).toString('base64');await fs.writeFile(keyFile,safeStorage.encryptString(key),{flag:'wx',mode:0o600})}process.env.SNAPBOARD_LICENSE_STORAGE_KEY=key
 }catch{delete process.env.SNAPBOARD_LICENSE_STORAGE_KEY;process.env.SNAPBOARD_LICENSE_STORAGE_UNAVAILABLE='1'}
 process.env.PYTHONDONTWRITEBYTECODE='1';await initializeSeed(path.join(payload,'seed'),dataRoot);
 for(const name of ['sync-part-library.mjs','sync-assembly-library.mjs'])await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(payload,'scripts',name)],{cwd:dataRoot,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});let errors='';child.stdout.resume();child.stderr.on('data',d=>errors+=d);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(errors||'资源初始化失败')))});
 process.env.SNAPBOARD_CALIBRATION_SCRIPT=path.join(payload,'scripts','snapcolor_calibration_bridge.py');process.env.SNAPBOARD_CALIBRATION_SOURCE=path.join(payload,'calibration','source');
 const python=path.join(payload,'python','python.exe');if(await fs.access(python).then(()=>true,()=>false))process.env.SNAPBOARD_CALIBRATION_PYTHON=python;
 const portFile=path.join(userData,'local-port.json'),preferredPort=await fs.readFile(portFile,'utf8').then(JSON.parse).catch(()=>0);local=await createServer({dataRoot,payload,preferredPort,onQuit:()=>app.quit()});await fs.writeFile(portFile,JSON.stringify(Number(new URL(local.origin).port)));
 await session.defaultSession.cookies.set({url:local.origin,name:'snapboard_session',value:local.token,httpOnly:true,sameSite:'strict'});session.defaultSession.setPermissionRequestHandler((_web,_permission,cb)=>cb(false));
 workspaces=createWorkspaceWindows({BrowserWindow,origin:local.origin,openExternal:url=>{void shell.openExternal(url).catch(()=>{})},onError:e=>dialog.showErrorBox('打开失败',e.message)});
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'文件',submenu:[{label:'打开用户数据目录',click:()=>shell.openPath(dataRoot)},{type:'separator'},{role:'quit',label:'退出'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},{label:'帮助',submenu:[{label:'许可证与来源',click:()=>shell.openPath(path.join(payload,'THIRD_PARTY_NOTICES.md'))},{label:'版本',click:()=>dialog.showMessageBox({message:'SnapBoard 个人玩家版 '+app.getVersion(),detail:'本机设计与制造；每日10次导出，按北京时间更新。'})}]}]));
 await workspaces.open(local.origin+'/design');
}).catch(e=>{dialog.showErrorBox('SnapBoard 启动失败',e.message);app.quit()});
app.on('window-all-closed',()=>app.quit());app.on('will-quit',()=>local?.server.close());}
