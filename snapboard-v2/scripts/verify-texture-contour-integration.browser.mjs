import {createManufacturing3MF} from '/src/utils/export3mf.ts'
import {createDefaultBoardTexture,createBoardTextureCanvas,getSplitPanelTextureBounds} from '/src/utils/boardTexture.ts'
import {buildTextureVectorRegions} from '/src/utils/textureVectorRegions.ts'
import {loadSnapColorLut,matchSnapColor,snapColorMeasuredColor} from '/src/utils/snapColorLut.ts'
import {PEGBOARD_DEFAULT_CONFIG} from '/src/utils/pegboardSplit.ts'
import {unzipSync,strFromU8} from 'fflate'
const assert=(condition,message)=>{if(!condition)throw new Error(message)}
const panel={id:'contour-fixture',x:0,y:0,w:30,h:30,contour:[{x:0,y:0},{x:30,y:0},{x:30,y:30},{x:0,y:30}],slots:[],round_holes:[],edge_holes:[],cutouts:[],roundIdx:[],outerCorners:[false,false,false,false]}
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="30" height="30"><rect width="30" height="30" fill="#123466"/><circle cx="15" cy="15" r="10" fill="#ce8350"/></svg>'
const inspect=data=>{
 const files=unzipSync(data),xml=strFromU8(files['3D/Objects/object_1.model']);
 const doc=new DOMParser().parseFromString(xml,'text/xml');
 assert(!doc.querySelector('parsererror'),'valid exported XML');
 const optical=[...doc.querySelectorAll('object')].filter(object=>object.getAttribute('name')?.includes('SnapColor'));
 return {triangles:optical.reduce((n,o)=>n+o.querySelectorAll('triangle').length,0),allTriangles:doc.querySelectorAll('triangle').length,bytes:data.length,settings:strFromU8(files['Metadata/model_settings.config']),report:JSON.parse(strFromU8(files['Metadata/snapboard-export-report.json']))}
}
export async function run(){
 const texture={...createDefaultBoardTexture(),enabled:true,source:'image',imageDataUrl:'data:image/svg+xml;base64,'+btoa(svg),imageAspect:1,modelingMode:'vector',edgeSealEnabled:false,manufacturingContours:true};
 const base={panels:[panel],cfg:{...PEGBOARD_DEFAULT_CONFIG,thickness:5,manufacturingChamfer:0},placedParts:[],partDefinitions:[],boardTexture:texture};
 const vector=await buildTextureVectorRegions(texture,getSplitPanelTextureBounds([panel]),[panel]);
 assert(vector.eligible,'simple SVG actually uses direct route: '+JSON.stringify(vector));
 const canvas=await createBoardTextureCanvas(texture,1,[panel]),ctx=canvas.getContext('2d');
 const rgb=ctx.getImageData(512,512,1,1).data,lut=await loadSnapColorLut(texture.lutId),expected=snapColorMeasuredColor(lut,matchSnapColor([206,131,80],lut,texture.hueWeight));
 assert(expected.every((n,i)=>Math.abs(n-rgb[i])<=1),'preview matches direct source recipe');
 const result=await createManufacturing3MF(base),newStats=inspect(result.data);
 assert(result.warnings.length===0,'direct SVG exports without fallback: '+result.warnings);
 const legacy=await createManufacturing3MF({...base,boardTexture:{...texture,manufacturingContours:false}}),oldStats=inspect(legacy.data);
 assert(newStats.allTriangles<oldStats.allTriangles,'continuous SVG reduces geometry');
 const samples=await createManufacturing3MF({...base,textureSampling:{sizeMm:12,locations:[{panelIndex:0,x:15,y:15}]}});
 assert(samples.sampleCount===1&&samples.panelCount===1&&samples.samplePlateCount===1,'sample and original retained together');
 assert(!samples.warnings.some(w=>w.includes('失败')||w.includes('未通过')),'sample closed without fallback');
 assert(newStats.settings.includes('key="sparse_infill_line_width" value="0.8"'),'bulk preset remains');
 const bitmap=document.createElement('canvas');bitmap.width=96;bitmap.height=96;const b=bitmap.getContext('2d');b.fillStyle='#123466';b.fillRect(0,0,96,96);b.fillStyle='#ce8350';b.beginPath();b.arc(48,48,32,0,2*Math.PI);b.fill();
 const bitmapTexture={...texture,imageDataUrl:bitmap.toDataURL(),modelingMode:'high-fidelity'};
 const bitmapResult=await createManufacturing3MF({...base,boardTexture:bitmapTexture});
 const bitmapLegacy=await createManufacturing3MF({...base,boardTexture:{...bitmapTexture,manufacturingContours:false}});
 const bitmapStats=inspect(bitmapResult.data),bitmapOld=inspect(bitmapLegacy.data);
 const bitmapFine=await createManufacturing3MF({...base,boardTexture:{...bitmapTexture,manufacturingEdgeQuality:'fine'}});
 const fineStats=inspect(bitmapFine.data);
 assert(fineStats.report.textureSampling[0].recipeSource==='direct-palette-index'&&fineStats.report.textureSampling[0].canvas[0]===300,'fine bitmap export uses 0.1mm source sampling and direct recipes');
 assert(fineStats.report.textureContours.layers.every(layer=>layer.route==='shared-contours'||layer.route==='legacy-grid-fallback'),'fine geometry keeps checked shared contours or exact fallback');
 assert(bitmapStats.allTriangles<bitmapOld.allTriangles,`bitmap regions reduce geometry: ${bitmapStats.allTriangles} vs ${bitmapOld.allTriangles}`);
 const reports=bitmapStats.report.textureContours.layers;
 assert(reports.filter(r=>r.route==='shared-contours').length>=3,'most bitmap layers use continuous contours');
 if(reports.some(r=>r.route==='legacy-grid-fallback'))assert(bitmapResult.warnings.some(w=>w.includes('未通过')),'fallback must be visible');
 const withHole={...panel,cutouts:[[{x:13,y:12},{x:17,y:12},{x:17,y:18},{x:13,y:18}]]};
 const holeResult=await createManufacturing3MF({...base,panels:[withHole],boardTexture:{...texture,edgeSealEnabled:true}});
 assert(holeResult.warnings.length===0,'hole/edge seal remains closed: '+holeResult.warnings);
 const compact=stats=>{const {settings,...rest}=stats;return rest};
 return {svg:{optimized:compact(newStats),legacy:compact(oldStats)},bitmap:{optimized:compact(bitmapStats),legacy:compact(bitmapOld),fine:compact(fineStats)},sampleCount:samples.sampleCount,previewRecipeMatch:true,holeSealPassed:true,warnings:[...result.warnings,...bitmapResult.warnings,...bitmapFine.warnings],artifacts:[{name:'svg-hole-seal.3mf',data:Array.from(holeResult.data)},{name:'svg-contours.3mf',data:Array.from(result.data)},{name:'svg-legacy.3mf',data:Array.from(legacy.data)},{name:'bitmap-contours.3mf',data:Array.from(bitmapResult.data)},{name:'bitmap-legacy.3mf',data:Array.from(bitmapLegacy.data)},{name:'svg-samples-and-original.3mf',data:Array.from(samples.data)}]};
}
