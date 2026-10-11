// Run in a real browser/Electron renderer served by Vite. No DOM emulation.
import { buildTextureVectorRegions, flattenTextureVectorCurve } from '/src/utils/textureVectorRegions.ts'
import { createDefaultBoardTexture } from '/src/utils/boardTexture.ts'
import { CubicBezierCurve, Vector2 } from 'three'

export async function runTextureVectorRegionsRegression() {
  const passed = []
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const svg = body => `data:image/svg+xml,${encodeURIComponent(body)}`
  const wrap = (body, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" ${attrs}>${body}</svg>`
  const bounds = { minX: 10, minY: 20, width: 100, height: 100 }
  const config = source => ({ ...createDefaultBoardTexture(), enabled: true, source: 'image', imageDataUrl: svg(source), imageAspect: 1, fit: 'stretch', modelingMode: 'vector', baseColor: '#ffffff' })
  const build = async (source, extra = {}, b = bounds, panels = []) => {
    const result = await buildTextureVectorRegions({ ...config(source), ...extra }, b, panels)
    assert(result.eligible, `eligible SVG rejected: ${result.reason}`)
    return result
  }
  const inRing = (x, y, ring) => { let yes = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes } return yes }
  const at = (r, x, y) => r.regions.find(region => region.polygons.some(poly => inRing(x, y, poly[0]) && !poly.slice(1).some(h => inRing(x, y, h))))?.color
  const expect = (r, x, y, color, message) => assert(at(r, x, y) === color, `${message}: ${at(r,x,y)} != ${color}`)
  const rectangle = '<rect x="0" y="0" width="50" height="50" fill="#ff0000"/>'
  let r = await build(wrap(rectangle))
  expect(r, 35, 95, '#ff0000', 'image top-left maps to world top-left')
  expect(r, 85, 45, '#ffffff', 'base fills untouched image')
  passed.push('world coordinates / source sRGB / background')
  r = await build(wrap('<rect x="50" y="100" width="100" height="50" fill="#ff0000"/>', 'viewBox="50 100 200 100"'))
  expect(r, 35, 85, '#ff0000', 'viewBox offset and centered meet')
  expect(r, 35, 110, '#ffffff', 'viewBox letterbox')
  passed.push('viewBox offset / preserveAspectRatio meet')
  r = await build(wrap('<rect x="50" y="100" width="100" height="50" fill="#ff0000"/>', 'viewBox="50 100 200 100" preserveAspectRatio="none"'))
  expect(r, 35, 110, '#ff0000', 'viewBox none stretches')
  passed.push('viewBox preserveAspectRatio none')
  r = await build(wrap('<rect x="50" y="100" width="100" height="50" fill="#ff0000"/>', 'viewBox="50 100 200 100" preserveAspectRatio="xMidYMid slice"'))
  expect(r, 35, 110, '#ff0000', 'viewBox slice fills top-left')
  expect(r, 85, 110, '#ffffff', 'viewBox slice preserves right side')
  passed.push('viewBox preserveAspectRatio slice')
  r = await build(wrap('<path fill="#ff0000" fill-rule="evenodd" d="M0 0H100V100H0Z M25 25H75V75H25Z"/><circle cx="50" cy="50" r="10" fill="#0000ff"/>'))
  expect(r, 20, 30, '#ff0000', 'outer fill')
  expect(r, 80, 70, '#ffffff', 'evenodd hole')
  expect(r, 60, 70, '#0000ff', 'paint order over hole')
  passed.push('holes / circles / later paint')
  for (const [rule, color] of [['nonzero', '#ff0000'], ['evenodd', '#ffffff']]) {
    r = await build(wrap(`<path fill="#ff0000" fill-rule="${rule}" d="M0 0H60V60H0Z M40 40H100V100H40Z"/>`))
    expect(r, 60, 70, color, `${rule} overlapping subpaths`)
  }
  passed.push('overlapping subpath fill rules')
  const source = wrap('<rect width="100" height="100" fill="#ff0000"/><rect x="25" y="25" width="50" height="50" fill="#0000ff"/>')
  const asset = { id: 'a', name: 'a', mime: 'image/svg+xml', dataUrl: svg(source), width: 100, height: 100, aspect: 1, revision: 'a' }
  const composition = { schemaVersion: 1, assets: [asset], layers: [{ id: 'l', name: 'l', kind: 'image', assetId: 'a', visible: true, opacity: 1, locked: false, placement: { mode: 'free', fit: 'contain', crop: { x: .25, y: .25, width: .5, height: .5 }, transform: { xMm: 60, yMm: 70, widthMm: 100, heightMm: 50, rotationDeg: 0, flipX: false, flipY: false } } }] }
  r = await build(source, { source: 'composition', composition })
  expect(r, 60, 70, '#0000ff', 'crop center')
  expect(r, 20, 70, '#ffffff', 'crop excludes original outside content in contain margin')
  passed.push('crop / contain placement clipping')
  composition.assets[0] = { ...asset, dataUrl: svg(wrap(rectangle)) }
  composition.layers[0].placement.crop = { x: 0, y: 0, width: 1, height: 1 }
  Object.assign(composition.layers[0].placement.transform, { widthMm: 100, heightMm: 100, rotationDeg: 90 })
  r = await build(source, { source: 'composition', composition })
  expect(r, 35, 45, '#ff0000', 'composition positive rotation counterclockwise in world')
  composition.layers[0].placement.transform.flipX = true
  r = await build(source, { source: 'composition', composition })
  expect(r, 35, 95, '#ff0000', 'flip then rotation')
  r = await build(wrap(rectangle), { rotation: 90 })
  expect(r, 85, 95, '#ff0000', 'legacy rotation clockwise in world')
  passed.push('composition rotation / flip / exact legacy rotation')
  r = await build(wrap('<rect width="100" height="100" fill="#ff0000"/>'), { avoidZones: [{ enabled: true, x: .4, y: .4, width: .2, height: .2 }] })
  expect(r, 60, 70, '#ffffff', 'avoid zone world y')
  passed.push('avoid zone overlay')
  composition.assets[0] = { ...asset, dataUrl: svg(wrap('<rect width="100" height="100" fill="#ff0000"/>')) }
  composition.layers[0].placement = { mode: 'per-panel', panelIds: 'all', fit: 'stretch', crop: { x: 0, y: 0, width: 1, height: 1 }, insetMm: 0, rotationDeg: 0, flipX: false, flipY: false }
  r = await build(source, { source: 'composition', composition }, bounds, [{id:'triangle',x:10,y:20,w:100,h:100,contour:[{x:10,y:20},{x:110,y:20},{x:10,y:120}]}])
  expect(r, 30, 40, '#ff0000', 'per-panel inner contour')
  expect(r, 95, 105, '#ffffff', 'per-panel clips nonrectangular contour')
  passed.push('per-panel contour clipping')
  // Compare raw Canvas reference to vector output away from antialiasing, at a deliberately
  // anisotropic preview aspect (minimum Canvas dimension256), with legacy cover/rotation/scale.
  const wide = { minX: -40, minY: 15, width: 500, height: 60 }
  const raw = wrap('<circle cx="40" cy="45" r="30" fill="#ff0000"/>')
  const cfg = { ...config(raw), rotation: 31, scale: 145, fit: 'contain', offsetX: 8, offsetY: -5 }
  r = await buildTextureVectorRegions(cfg, wide, [])
  assert(r.eligible, `wide SVG rejected: ${r.reason}`)
  const image = await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=cfg.imageDataUrl})
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=256
  const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1024,256)
  ctx.translate(512+cfg.offsetX/100*1024,128-cfg.offsetY/100*256);ctx.rotate(cfg.rotation*Math.PI/180);ctx.scale(cfg.scale/100,cfg.scale/100);ctx.drawImage(image,-128,-128,256,256)
  const data=ctx.getImageData(0,0,1024,256).data;let comparisons=0
  for(let y=8;y<248;y+=8)for(let x=8;x<1016;x+=8){
    const pixel=(xx,yy)=>data[(yy*1024+xx)*4+1];const v=pixel(x,y)
    if(v!==0&&v!==255)continue
    if([[x-3,y],[x+3,y],[x,y-3],[x,y+3]].some(([xx,yy])=>pixel(xx,yy)!==v))continue
    expect(r,wide.minX+(x+.5)/1024*wide.width,wide.minY+(1-(y+.5)/256)*wide.height,v===0?'#ff0000':'#ffffff','raw Canvas parity');comparisons++
  }
  assert(comparisons>100,'insufficient Canvas parity samples')
  passed.push(`raw Canvas transform parity (${comparisons} samples)`)
  const curve = new CubicBezierCurve(new Vector2(0, 0), new Vector2(0, 100), new Vector2(100, -100), new Vector2(100, 0))
  const line = flattenTextureVectorCurve(curve, p => [p.x, p.y], .035)
  const distance = (p, a, b) => { const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p.x-a[0])*dx+(p.y-a[1])*dy)/(dx*dx+dy*dy))); return Math.hypot(p.x-a[0]-t*dx,p.y-a[1]-t*dy) }
  for (let i=0;i<=1000;i++) assert(Math.min(...line.slice(1).map((p,j)=>distance(curve.getPoint(i/1000),line[j],p)))<=.035001,'Bezier error exceeds mm tolerance')
  assert(line.length < 200, 'adaptive curve excessive segments')
  passed.push('Bezier physical error bound')
  const unsupported = [
    '<rect width="50" height="50" fill="rgba(255,0,0,0.5)"/>',
    '<rect width="50" height="50" fill="#ff000080"/>',
    '<rect width="50" height="50" fill="transparent"/>',
    '<rect width="50" height="50" stroke="red"/>', '<text>ABC</text>',
    '<defs><linearGradient id="g"/></defs><rect width="50" height="50" fill="url(#g)"/>',
    '<g opacity=".5"><rect width="50" height="50"/></g>',
  ]
  for (const body of unsupported) { const result = await buildTextureVectorRegions(config(wrap(body)), bounds, []); assert(!result.eligible, `unsupported accepted: ${body}`) }
  passed.push(`${unsupported.length} whole-image fallback cases`)
  r = await build(wrap('<metadata><rect width="100" height="100"/></metadata><defs/><rect width="30" height="30" fill="red"/>'))
  expect(r,85,45,'#ffffff','metadata must not paint')
  r = await build(wrap('<path fill="red" d="M0 0L100 100L0 100L100 0Z"/>'))
  expect(r,60,110,'#ff0000','SVG self-crossing nonzero fill resolved')
  const embedded = '<image width="100" height="100" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6v8AAAAASUVORK5CYII="/>'
  r = await build(wrap(embedded+'<rect width="100" height="100" fill="red"/>'))
  expect(r,60,70,'#ff0000','fully covered image can be omitted')
  const uncovered=await buildTextureVectorRegions(config(wrap(embedded+'<rect width="30" height="30" fill="red"/>')),bounds,[])
  assert(!uncovered.eligible,'visible embedded image must not be discarded')
  passed.push('editor metadata, self-intersection fill, covered and visible image handling')
  return { passed, count: passed.length, curveVertices: line.length }
}
