import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
const server=await createServer({appType:'custom',server:{middlewareMode:true}})
try {
 const {cleanTextureColorIslands}=await server.ssrLoadModule('/src/utils/textureColorCleanup.ts')
 const {rgbToLab,matchSnapColor}=await server.ssrLoadModule('/src/utils/snapColorLut.ts')
 const {continuousTextureRecipes}=await server.ssrLoadModule('/src/utils/texturePaletteContinuity.ts')
 const w=40,h=30
 const fill=(rgb)=>{const a=new Uint8ClampedArray(w*h*4);for(let i=0;i<a.length;i+=4)a.set([...rgb,255],i);return a}
 const patch=(a,x,y,size,rgb)=>{for(let yy=y;yy<y+size;yy++)for(let xx=x;xx<x+size;xx++)a.set([...rgb,255],(yy*w+xx)*4)}
 const source=fill([240,210,190]),mapped=fill([230,195,160])
 patch(source,5,5,4,[244,213,192]);patch(mapped,5,5,4,[255,255,255])
 patch(source,20,5,2,[30,20,20]);patch(mapped,20,5,2,[10,10,10])
 assert.equal(cleanTextureColorIslands(source,mapped,w,h),16,'remove a 4x4 low-source-contrast quantization island')
 assert.deepEqual([...mapped.slice((5*w+5)*4,(5*w+5)*4+3)],[230,195,160])
 assert.deepEqual([...mapped.slice((5*w+20)*4,(5*w+20)*4+3)],[10,10,10],'preserve small high-contrast eye/line details')
 const broad=fill([230,195,160]);patch(broad,10,10,8,[255,255,255]);assert.equal(cleanTextureColorIslands(source,broad,w,h),0,'do not conceal broad layer/palette errors')
 const transparent=fill([240,210,190]),edge=fill([230,195,160]);patch(edge,5,5,2,[255,255,255]);transparent[(5*w+4)*4+3]=0;assert.equal(cleanTextureColorIslands(transparent,edge,w,h),0,'preserve alpha boundaries')
 const pixels=await readFile('public/snapcolor/luts/snapcolor-petg-rybw.npy')
 const offset=pixels[6]===1 ? 10+pixels.readUInt16LE(8) : 12+pixels.readUInt32LE(8)
 const measured=new Uint8Array(pixels.subarray(offset));const colorCount=measured.length/3
 const labs=new Float32Array(measured.length)
 for(let i=0;i<colorCount;i++)labs.set(rgbToLab([...measured.slice(i*3,i*3+3)]),i*3)
 const lut={measured,labs,colorCount};let rematches=0,tested=0
 const palette=[[220,218,197],[222,220,199],[20,20,30],[35,60,180],[245,190,170]]
 const initial=palette.map(rgb=>matchSnapColor(rgb,lut,.35))
 assert.notEqual(initial[0],initial[1],'fixture crosses an actual LUT discontinuity')
 const stable=continuousTextureRecipes(palette,lut,.35)
 assert.equal(stable[0],stable[1],'nearby pale source colours must not split into distant recipes')
 assert.deepEqual(stable.slice(2),initial.slice(2),'eye, blue and strong blush colours must remain distinct')
 assert.deepEqual(continuousTextureRecipes(palette,lut,.35),stable,'deterministic mapping')
 assert.deepEqual(continuousTextureRecipes([],lut,.35),[])
 const ramp=Array.from({length:31},(_,i)=>[100+i*3,70+i*3,40+i*3])
 const rampRecipes=continuousTextureRecipes(ramp,lut,.35)
 assert.notEqual(rampRecipes[0],rampRecipes.at(-1),'do not chain-merge an entire gradient')
 for(let i=0;i<ramp.length;i++){
  const src=rgbToLab(ramp[i]);const error=r=>Math.hypot(...src.map((v,c)=>v-labs[r*3+c]))
  assert.ok(error(rampRecipes[i])<=error(matchSnapColor(ramp[i],lut,.35))+4+1e-6,'per-colour accuracy bound')
 }
 for(let r=220;r<=255;r+=5)for(let g=170;g<=255;g+=5)for(let b=150;b<=255;b+=5){
  const index=matchSnapColor([r,g,b],lut,.35)
  const next=matchSnapColor([...measured.slice(index*3,index*3+3)],lut,.35)
  if(index!==next)rematches++;tested++
 }
 for(const rgb of [[230,230,230],[232,230,231],[180,181,180]])assert.equal(matchSnapColor(rgb,lut,1),matchSnapColor(rgb,lut,0),'near-neutral colors must not depend on unstable hue angles')
 console.log(JSON.stringify({cleanup:'passed',skinRecipeAudit:{tested,rematches},nearNeutralHue:'passed'}))
} finally {await server.close()}
