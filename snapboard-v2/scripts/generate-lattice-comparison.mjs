import fs from 'node:fs/promises'
import path from 'node:path'
import {createServer} from 'vite'
const dir=path.resolve('output/lattice-comparison');await fs.mkdir(dir,{recursive:true})
const s=await createServer({appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false}})
try{
  const [split,lattice,svg,mass,exporter,mark,texture]=await Promise.all([
    s.ssrLoadModule('/src/utils/pegboardSplit.ts'),s.ssrLoadModule('/src/utils/openLattice.ts'),s.ssrLoadModule('/src/utils/svgLattice.ts'),
    s.ssrLoadModule('/src/utils/latticeMass.ts'),s.ssrLoadModule('/src/utils/export3mf.ts'),s.ssrLoadModule('/src/utils/assemblyMarking.ts'),s.ssrLoadModule('/src/utils/boardTexture.ts')])
  const cfg={...split.PEGBOARD_DEFAULT_CONFIG,bedW:256,bedH:256,bedKeepouts:[],thickness:5,manufacturingChamfer:0}
  const original=split.splitOrthogonalPolygon({points:[{x:0,y:0},{x:200,y:0},{x:200,y:200},{x:0,y:200}],holes:[]},cfg).panels[0]
  const profiles={...mass.DEFAULT_LATTICE_MASS_PROFILE,layerHeightMm:.2,frontDenseMm:0}
  const rows=[]
  const labels={organic:'Voronoi 连筋',hex:'圆润连筋',diamond:'规则斜撑',honeycomb:'细分蜂窝（16mm）'}
  const cases=[{id:'baseline',name:'普通图案板 / 同样 1mm 连续正面 / 10% 芯材'}, {id:'plain-no-front',name:'素板对照 / 无图案贴面 / 10% 填充'},...['organic','hex','diamond','honeycomb'].flatMap(style=>[
    {id:style+'-open',name:labels[style]+' / 完全镂空',style,faceMm:0},
    {id:style+'-front',name:labels[style]+' / 保留 1mm 正面',style,faceMm:1}]),
    {id:'honeycomb-open-core',name:'细蜂窝 1mm 正面 / 骨架无封盖',style:'honeycomb',faceMm:1,caps:true},
    {id:'honeycomb-24-front',name:'24mm 蜂窝 / 1mm 正面',style:'honeycomb',faceMm:1,pitch:24},
    {id:'honeycomb-24-front08',name:'24mm 蜂窝 / 0.8mm 正面',style:'honeycomb',faceMm:.8,pitch:24},
    {id:'hex-front08',name:'圆润主骨架 / 0.8mm 正面',style:'hex',faceMm:.8},
    {id:'hex-front08-open-core',name:'保留圆润主骨架 / 0.8mm 正面 / 骨架无封盖',style:'hex',faceMm:.8,caps:true},
    {id:'hex-hybrid',name:'圆润主骨架 + 内部蜂窝 / 1mm 正面',style:'hex',faceMm:1,fill:true}]
  for(const c of cases){
    let p={...original,latticeOptions:{fillWindows:Boolean(c.fill),cellPitchMm:c.pitch??16,cellRibMm:1.26,openCoreCaps:Boolean(c.caps)}}
    if(c.style){const plan=svg.applyLatticeFrontLayer(p,cfg,lattice.generateOpenLattice(p,cfg,3.5,c.style),c.faceMm);p={...p,latticeCutouts:plan.holes,latticeFace:plan.face}}
    else {delete p.latticeOptions;if(c.id==='baseline'){const plan=svg.applyLatticeFrontLayer(p,cfg,{holes:[],style:'hex',ribMm:3.5,removedAreaMm2:0},1);p={...p,latticeCutouts:[],latticeFace:plan.face}}}
    const estimate=mass.estimateLatticeMass(p,cfg,profiles)
    const result=await exporter.createManufacturing3MF({panels:[p],cfg,boardTexture:{...texture.createDefaultBoardTexture(),enabled:false,baseInfillDensity:10},assemblyMarking:{...mark.createDefaultAssemblyMarking(),enabled:false},placedParts:[],partDefinitions:[],projectName:c.id})
    await fs.writeFile(path.join(dir,c.id+'.3mf'),result.data)
    if(c.style){const plan={holes:p.latticeCutouts,ribMm:3.5,style:c.style,removedAreaMm2:0};await fs.writeFile(path.join(dir,c.id+'.svg'),lattice.openLatticePlanSvg(p,plan,cfg));if(c.style==='honeycomb')await fs.writeFile('public/lattice-reference/honeycomb.svg',lattice.openLatticePlanSvg(p,plan,cfg))}
    rows.push({...c,estimatedGrams:estimate.grams,modelVolumeMm3:estimate.modelVolumeMm3,printedVolumeMm3:estimate.printedVolumeMm3,perimeterMm:estimate.perimeterMm,windows:p.latticeCutouts?.length??0})
    console.log(c.id,estimate.grams.toFixed(2),'g',p.latticeCutouts?.length??0,'windows')
  }
  const baseline=rows[0].estimatedGrams
  for(const row of rows){row.normalized138g=138*row.estimatedGrams/baseline;row.savingPercent=100*(1-row.estimatedGrams/baseline)}
  await fs.writeFile(path.join(dir,'comparison-estimates.json'),JSON.stringify({specimen:'200×200×5mm',profile:profiles,observedReference:{baseline:138,lattice:118,savingPercent:100*(1-118/138)},rows},null,2))
}finally{await s.close()}
