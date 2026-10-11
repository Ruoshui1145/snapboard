import {createServer} from 'vite'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
// Use the same module loader as the app; standalone tsc lost Vite/WASM/JSON declarations.
export async function checkModule(entry) {
  const cache=await mkdtemp(path.join(tmpdir(),'snapboard-check-module-'))
  const server=await createServer({configFile:false,root:process.cwd(),cacheDir:cache,logLevel:'silent',appType:'custom',server:{middlewareMode:true,hmr:false}})
  try{return await server.ssrLoadModule('/'+entry)}
  finally{await server.close();if(!cache.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(cache).startsWith('snapboard-check-module-'))throw Error('Unsafe check cache');await rm(cache,{recursive:true,force:true,maxRetries:4,retryDelay:100})}
}
