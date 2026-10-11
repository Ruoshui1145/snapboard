// Two application windows share the local service and Electron session.
function workspaceTarget(origin,value) {
  let url;try{url=new URL(value,origin);}catch{return null;}
  if(url.origin!==origin||url.username||url.password||url.hash||!['/design','/order-console'].includes(url.pathname))return null;
  const seen=new Set(),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  for(const [key,value] of url.searchParams){
    if(seen.has(key)||!['order','artifact','number'].includes(key))return null;seen.add(key);
    if(key==='number'?(url.pathname!=='/order-console'||!/^SB-\d{8}-\d{4}$/.test(value)):!uuid.test(value))return null;
  }
  if(url.searchParams.has('artifact')&&(url.pathname!=='/design'||!url.searchParams.has('order')))return null;
  return {role:url.pathname==='/design'?'design':'orders',url:url.href,search:url.search};
}
function createWorkspaceWindows({BrowserWindow,origin,openExternal,show=true,onError=console.error}) {
  const windows=new Map(),ready=new Map();
  const focus=window=>{if(show){if(window.isMinimized())window.restore();window.show();window.focus();}};
  const external=value=>{
    let url;try{url=new URL(value);}catch{return;}
    if(url.origin===origin||!['https:','http:'].includes(url.protocol)||url.username||url.password)return;
    // Local application links must never leave the authenticated desktop session.
    if(/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(url.hostname))return;
    openExternal(url.href);
  };
  const open=async(value)=>{
    const target=workspaceTarget(origin,value);if(!target)return null;
    let window=windows.get(target.role);
    if(window&&!window.isDestroyed()){
      await ready.get(target.role);
      if(window.isDestroyed())return null;
      if(target.search)await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('snapboard-workspace-navigate',{detail:{search:${JSON.stringify(target.search)}}}))`);
      focus(window);return window;
    }
    const title=target.role==='orders'?'SnapBoard · 订单工作台':'SnapBoard · 设计器';
    window=new BrowserWindow({width:1440,height:960,minWidth:1000,minHeight:700,show:false,title,backgroundColor:'#0b101b',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:show}});
    windows.set(target.role,window);
    window.on('closed',()=>{if(windows.get(target.role)===window){windows.delete(target.role);ready.delete(target.role);}});
    window.webContents.on('page-title-updated',event=>{event.preventDefault();window.setTitle(title);});
    window.webContents.setWindowOpenHandler(({url})=>{if(workspaceTarget(origin,url))void open(url).catch(onError);else external(url);return {action:'deny'};});
    window.webContents.on('will-navigate',(event,url)=>{const targetUrl=typeof url==='string'?url:event.url;event.preventDefault();if(workspaceTarget(origin,targetUrl))void open(targetUrl).catch(onError);else external(targetUrl);});
    const loaded=Promise.resolve().then(()=>window.loadURL(target.url));ready.set(target.role,loaded);
    try{await loaded;}
    catch(error){
      if(windows.get(target.role)===window){windows.delete(target.role);ready.delete(target.role);}
      if(!window.isDestroyed())window.destroy();
      throw error;
    }
    if(window.isDestroyed())return null;
    focus(window);return window;
  };
  return {open,windows};
}
module.exports={workspaceTarget,createWorkspaceWindows};
