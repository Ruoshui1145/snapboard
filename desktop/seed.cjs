const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID}=require('node:crypto');

// New installations and upgrades share this policy: add missing packages only.
// Existing package IDs/locations, custom calibration and saved projects win.
async function initializeSeed(seed, dataRoot) {
  await fs.mkdir(dataRoot, {recursive:true});
  const exists = file => fs.access(file).then(()=>true,()=>false);
  const marker = path.join(dataRoot,'.seed-complete');
  const added = [];
  if (!await exists(marker)) {
    for(const entry of await fs.readdir(seed,{withFileTypes:true})) {
      if(['配件资源包','装配资源包'].includes(entry.name))continue;
      await fs.cp(path.join(seed,entry.name),path.join(dataRoot,entry.name),{recursive:true,force:false,errorOnExist:false});
    }
  }
  for (const library of ['配件资源包','装配资源包']) {
    const source = path.join(seed,library), target = path.join(dataRoot,library);
    await fs.mkdir(target,{recursive:true});
    const ids = new Set();
    for (const entry of await fs.readdir(target,{withFileTypes:true})) {
      if (!entry.isDirectory()) continue;
      try {const meta=JSON.parse(await fs.readFile(path.join(target,entry.name,'pack.json'),'utf8'));if(meta.id)ids.add(meta.id);} catch {}
    }
    for (const entry of await fs.readdir(source,{withFileTypes:true}).catch(()=>[])) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const from=path.join(source,entry.name), to=path.join(target,entry.name);
      if (await exists(to)) continue;
      const meta=await fs.readFile(path.join(from,'pack.json'),'utf8').then(JSON.parse).catch(()=>null);
      if (meta?.id && ids.has(meta.id)) continue;
      const staging=path.join(target,`_seed-${randomUUID()}`);
      try {
        await fs.cp(from,staging,{recursive:true,errorOnExist:true});
        // Windows scanners may briefly hold a newly copied directory open.
        for(let attempt=0;;attempt++) {
          try {await fs.rename(staging,to);break;}
          catch(error) {if(!['EPERM','EBUSY'].includes(error.code)||attempt>=4)throw error;await new Promise(resolve=>setTimeout(resolve,50*2**attempt));}
        }
      } finally {
        if(!staging.startsWith(path.resolve(dataRoot)+path.sep))throw new Error('Invalid seed staging path');
        await fs.rm(staging,{recursive:true,force:true});
      }
      if(meta?.id)ids.add(meta.id);
      added.push(`${library}/${entry.name}`);
    }
  }
  await fs.writeFile(marker,'1');
  return {added};
}
module.exports={initializeSeed};
