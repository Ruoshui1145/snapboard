/** Count deposited XY line segments, keeping curve discretization distinct from a defect claim. */
export function linearExtrusionSegments(text){
  let x=0,y=0,e=0,relativeE=true,relativeXY=false,feature='',linearExtrusionMoves=0,shortLinearMoves=0,arcExtrusionMoves=0,totalLinearMm=0
  const shortByFeature={}
  for(const line of text.split('\n')){
    if(line.startsWith('; FEATURE:')){feature=line.slice(10).trim();continue}
    if(/^M82\b/.test(line))relativeE=false
    if(/^M83\b/.test(line))relativeE=true
    if(/^G90\b/.test(line))relativeXY=false
    if(/^G91\b/.test(line))relativeXY=true
    if(!/^(?:G0|G1|G2|G3|G92)\s/.test(line))continue
    const values=Object.fromEntries([...line.split(';')[0].matchAll(/\b([XYE])([-\d.]+)/g)].map(match=>[match[1],Number(match[2])]))
    if(/^G92\b/.test(line)){x=values.X??x;y=values.Y??y;e=values.E??e;continue}
    const nx=values.X===undefined?x:relativeXY?x+values.X:values.X,ny=values.Y===undefined?y:relativeXY?y+values.Y:values.Y
    const extrusion=values.E===undefined?0:relativeE?values.E:values.E-e,distance=Math.hypot(nx-x,ny-y)
    if(extrusion>0&&distance>1e-6&&feature&&!['Custom','Flush','Undefined'].includes(feature)){
      if(/^G[23]\s/.test(line))arcExtrusionMoves++
      else{
        linearExtrusionMoves++;totalLinearMm+=distance
        if(distance<.42){shortLinearMoves++;shortByFeature[feature]=(shortByFeature[feature]||0)+1}
      }
    }
    x=nx;y=ny;if(values.E!==undefined)e=relativeE?e+values.E:values.E
  }
  return {thresholdMm:.42,linearExtrusionMoves,shortLinearMoves,arcExtrusionMoves,totalLinearMm,shortByFeature,note:'正挤出G0/G1直线段，排除Custom/Flush/Undefined；G2/G3更新坐标但不把圆弧弦长计作直线。短曲线离散段也计入，不能直接等同有害色碎斑'}
}
