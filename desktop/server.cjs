const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createReadStream} = require('node:fs');
const {randomBytes} = require('node:crypto');
const {installApis,authorizeMerchantRequest} = require('./generated/api.cjs');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.npy':'application/octet-stream','.stl':'model/stl','.3mf':'model/3mf','.glb':'model/gltf-binary','.gltf':'model/gltf+json'};
async function createServer({dataRoot, payload, preferredPort = 0, smoke = false, onQuit = () => {}}) {
  await fs.mkdir(dataRoot, {recursive:true});
  process.chdir(dataRoot);
  process.env.SNAPBOARD_SYNC_DIR = path.join(payload, 'scripts');
  const handlers = [];
  const token = randomBytes(32).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const cookie = (req.headers.cookie || '').split(';').map(v => v.trim());
      if (req.headers.host !== new URL(origin).host || !cookie.includes(`snapboard_session=${token}`) || (req.headers.origin && req.headers.origin !== origin)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Cache-Control','no-store');
      // Embind currently generates JS wrappers; permit that trusted runtime, never inline scripts.
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (smoke && url.pathname === '/api/desktop-smoke/exports' && req.method === 'GET') {
        const files=await fs.readdir(path.join(dataRoot,'已保存项目/制造导出')).catch(()=>[]);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(files));return;
      }
      if (url.pathname === '/api/system/shutdown' && req.method === 'POST') {
        res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ok:true,message:'SnapBoard 即将关闭'})); setTimeout(onQuit,200); return;
      }
      if(authorizeMerchantRequest && !(await authorizeMerchantRequest(req,res,url.pathname+url.search)))return;
      const handler = handlers.find(h => url.pathname === h.route || ['/api/farm-orders','/api/merchant-license'].includes(h.route) && url.pathname.startsWith(h.route + '/'));
      if (handler) { req.url = (url.pathname.slice(handler.route.length) || '/') + url.search; await handler.handler(req, res); return; }
      if (url.pathname.startsWith('/api/')) {res.writeHead(404);res.end();return;}
      if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) {res.writeHead(400);res.end();return;}
      const library = relative.startsWith('partLibrary/') || relative.startsWith('assemblyLibrary/');
      const base = library ? path.join(dataRoot, 'public') : path.join(payload,'site');
      if (!relative || relative === 'design' || relative === 'order-console' || relative === 'index.html') relative='index.html';
      let file = path.resolve(base,relative);
      if (!file.startsWith(base + path.sep)) {res.writeHead(403);res.end();return;}
      let stat;
      try {file = await fs.realpath(file); stat = await fs.stat(file);} catch {res.writeHead(404);res.end();return;}
      const realBase = await fs.realpath(base);
      if (!file.startsWith(realBase + path.sep) || !stat.isFile()) {res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Content-Length',stat.size);
      if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    } catch(error) {if (!res.headersSent) res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  installApis({httpServer:server,middlewares:{use:(route, handler) => handlers.push({route, handler})}});
  await new Promise((resolve,reject) => {
    const listen = port => {
      const fail = error => {if(error.code === 'EADDRINUSE' && port) listen(0); else reject(error);};
      server.once('error',fail);
      server.listen(port,'127.0.0.1',()=>{server.off('error',fail);resolve();});
    };
    listen(Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535 ? preferredPort : 0);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {server,origin,token};
}
module.exports = {createServer};
