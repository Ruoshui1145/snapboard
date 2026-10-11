import {createBoardTextureCanvas,getSplitPanelTextureBounds} from '/src/utils/boardTexture.ts'
export async function run(){
 const file=await(await fetch('/已保存项目/拼装演示.snapboard')).json();const w=file.workspace;
 const panels=w.splitResult.sources.flatMap(s=>s.panels),bounds=getSplitPanelTextureBounds(panels);
 const before=await createBoardTextureCanvas({...w.boardTexture,cleanup:false},bounds.width/bounds.height,panels);
 const after=await createBoardTextureCanvas({...w.boardTexture,cleanup:true},bounds.width/bounds.height,panels);
 const a=before.getContext('2d').getImageData(0,0,before.width,before.height).data,b=after.getContext('2d').getImageData(0,0,after.width,after.height).data;
 let changed=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])changed++;
 const colorsInChin=data=>{const colors=new Set();for(let y=730;y<785;y++)for(let x=310;x<560;x++){const i=(y*before.width+x)*4;colors.add(`${data[i]},${data[i+1]},${data[i+2]}`)}return colors.size};
 const chinBefore=colorsInChin(a),chinAfter=colorsInChin(b);
 if(!(chinAfter<chinBefore))throw new Error(`Chin discontinuity not reduced: ${chinBefore}->${chinAfter}`);
 let darkCount=0,darkChanged=0;for(let i=0;i<a.length;i+=4)if(Math.max(a[i],a[i+1],a[i+2])<65){darkCount++;if(Math.max(b[i],b[i+1],b[i+2])>85)darkChanged++;}
 if(darkChanged>darkCount*.005)throw new Error(`Dark contour coverage changed excessively: ${darkChanged}/${darkCount}`);
 const artifacts=[];for(const[name,c]of [['face-before.png',before],['face-after.png',after]])artifacts.push({name,data:Array.from(new Uint8Array(await(await fetch(c.toDataURL())).arrayBuffer()))});
 return {changed,total:a.length/4,width:before.width,height:before.height,chinBefore,chinAfter,darkCount,darkChanged,artifacts};
}
