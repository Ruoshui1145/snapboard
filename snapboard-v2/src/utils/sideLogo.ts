import * as THREE from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import type { ManifoldToplevel } from 'manifold-3d'
import { pixelTextPolygons, type AssemblyPanelMarkPlan, type AssemblyMarkingConfig } from './assemblyMarking'
import { createMarkingGeometry } from './markingShapes'
import { previewMeshTopology, rememberPreviewMeshTopology } from './previewMeshTopology'
import polygonClipping, { type Ring } from 'polygon-clipping'
import { createSplitPanelShape } from './boardMesh'

interface MeshData { vertices: Array<[number, number, number]>; triangles: Array<[number, number, number]> }

export async function applyPanelNumberMeshes(meshes:MeshData[],panel:SplitPanel,cfg:SplitConfig,plan:AssemblyPanelMarkPlan,config:AssemblyMarkingConfig):Promise<boolean>{
  const mark=plan.numberMark
  if(mark?.surface==='side')return engraveSideLogoMeshes(meshes,panel,cfg,mark.text,config.sideDepth??.24,mark.height,false)
  if(mark?.surface==='back')return engraveBackMarkMeshes(meshes,panel,mark.polygons,config.depth)
  return mark?.surface==='pocket' ? engraveBackMarkMeshes(meshes,panel,mark.polygons,mark.height,undefined,true,mark.z) : false
}
export async function applyPanelNumberPreview(root:THREE.Object3D,panel:SplitPanel,cfg:SplitConfig,plan:AssemblyPanelMarkPlan,config:AssemblyMarkingConfig):Promise<boolean>{
  const mark=plan.numberMark
  if(mark?.surface==='side')return engraveSideLogoPreview(root,panel,cfg,mark.text,config.sideDepth??.24,mark.height,false)
  if(mark?.surface==='back')return engraveBackMarkPreview(root,panel,mark.polygons,config.depth)
  return mark?.surface==='pocket' ? engraveBackMarkPreview(root,panel,mark.polygons,mark.height,mark.z) : false
}

/** A subtractive cutter, inside the nominal side and clear of both outer chamfers. */
export function createSideLogoCutterGeometry(panel: SplitPanel, cfg: SplitConfig, brand: string, depth = 0.24, textHeight = 3.5, brandFallback = true,
  rightLimit?: number): THREE.BufferGeometry | null {
  const chamfer = Math.max(0, Math.min(cfg.manufacturingChamfer, cfg.thickness / 3, cfg.slotWidth / 4))
  const bevel = 0.04
  const bevelExpansion = bevel * 2
  const height = Math.min(textHeight, cfg.thickness - 2 * (chamfer + 0.15 + bevelExpansion))
  if (cfg.thickness < 4 || height < 2.1) return null
  const contour = panel.contour ?? [
    { x: panel.x, y: panel.y }, { x: panel.x + panel.w, y: panel.y },
    { x: panel.x + panel.w, y: panel.y + panel.h }, { x: panel.x, y: panel.y + panel.h },
  ]
  const top = Math.max(...contour.map(point => point.y))
  const edges = contour.flatMap((point, index) => {
    const next = contour[(index + 1) % contour.length]
    return Math.abs(point.y - top) < 0.01 && Math.abs(next.y - top) < 0.01
      ? [{ left: Math.min(point.x, next.x), right: Math.max(point.x, next.x) }] : []
  }).sort((a, b) => (b.right - b.left) - (a.right - a.left))
  const edge = edges[0]
  if (!edge) return null
  const centerX = (edge.left + edge.right) / 2
  const margin = Math.max(2, cfg.cornerRadius + 0.5)
  const shape = createSplitPanelShape(panel, cfg, 12).extractPoints(24)
  const ring = (points: THREE.Vector2[]): Ring => {
    const result: Ring = points.map(p => [p.x, p.y]); result.push(result[0]); return result
  }
  const domain = [[ring(shape.shape), ...shape.holes.map(ring)]]
  let offsetX = 0
  const text = (brandFallback ? [brand, 'SB'] : [brand]).find(candidate => {
    const points = pixelTextPolygons(candidate, centerX, cfg.thickness / 2, height, 0, true).flat()
    if (!points.length) return false
    const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x))
    const offsets = rightLimit === undefined
      ? [0, ...Array.from({ length: Math.ceil(panel.w / 2) }, (_, i) => [(i + 1) * 2, -(i + 1) * 2]).flat()]
      : Array.from({ length: Math.ceil(panel.w / 2) }, (_, i) => rightLimit - right - i * 2)
    const found = offsets.find(offset => {
      const minX = left + offset - bevelExpansion, maxX = right + offset + bevelExpansion
      if (minX < edge.left + margin || maxX > Math.min(edge.right - margin, rightLimit ?? Infinity)) return false
      // The actual outline contains boundary half-holes. A continuous solid
      // side strip is required, rather than just a long nominal outside edge.
      const probe: Ring = [[minX, top - depth - 1e-4], [maxX, top - depth - 1e-4],
        [maxX, top - 1e-4], [minX, top - 1e-4], [minX, top - depth - 1e-4]]
      return polygonClipping.difference([[probe]], domain).length === 0
    })
    if (found === undefined) return false
    offsetX = found
    return true
  })
  if (!text) return null
  // Rounded font counters can make earcut cap T-junctions. Reuse the closed
  // marking extrusion used for back IDs; the board's outer chamfer stays intact.
  const geometry = createMarkingGeometry(pixelTextPolygons(text, centerX, cfg.thickness / 2, height, 0, true), depth + bevel)
  geometry.translate(0, 0, -bevel)
  // The mouth extends 0.04 mm outside only as a cutter; the finished board never grows.
  geometry.rotateX(Math.PI / 2)
  geometry.translate(offsetX, top, 0)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  if (box.min.z < chamfer + 0.15 || box.max.z > cfg.thickness - chamfer - 0.15 ||
      box.min.x < edge.left + margin || box.max.x > edge.right - margin) {
    geometry.dispose()
    return null
  }
  geometry.userData.engravingText = text
  return geometry
}

function geometryData(geometry: THREE.BufferGeometry): MeshData {
  const positions = geometry.getAttribute('position')
  const vertices: MeshData['vertices'] = Array.from({ length: positions.count }, (_, i) => [positions.getX(i), positions.getY(i), positions.getZ(i)])
  const ids = geometry.getIndex()?.array ?? Uint32Array.from({ length: positions.count }, (_, i) => i)
  const triangles: MeshData['triangles'] = []
  for (let i = 0; i < ids.length; i += 3) triangles.push([ids[i], ids[i + 1], ids[i + 2]])
  return { vertices, triangles }
}

function solidFromMesh(data: MeshData, wasm: ManifoldToplevel) {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(data.vertices.flat()),
    triVerts: Uint32Array.from(data.triangles.flat()), tolerance: 1e-5 })
  // Keep valid indexed fans separate; welding point contacts changes topology.
  try { return new wasm.Manifold(mesh) } catch {
    mesh.merge()
    try { return new wasm.Manifold(mesh) }
    catch(error) { throw new Error(`凹刻输入网格未闭合：${error instanceof Error ? error.message : String(error)}`) }
  }
}

/** Preview and export subtract the same cutter from every intersected layer, atomically. Coordinates are panel-local. */
export async function engraveSideLogoMeshes(meshes: MeshData[], panel: SplitPanel, cfg: SplitConfig, brand: string, depth = 0.24, textHeight = 3.5, brandFallback = true): Promise<boolean> {
  const geometry = createSideLogoCutterGeometry(panel, cfg, brand, depth, textHeight, brandFallback)
  return geometry ? subtractEngravingMeshes(meshes, panel, geometry) : false
}

/** All order fields cut in one boolean, avoiding repeated Float32 round-trips. */
export async function engraveSideTraceMeshes(meshes: MeshData[], panel: SplitPanel, cfg: SplitConfig,
  lines: Array<{ text: string; textHeightMm: number; rightLimitMm?: number }>, depth = .24,
  frontOnBedThickness?: number): Promise<boolean> {
  const cutters = lines.map(line => createSideLogoCutterGeometry(panel, cfg, line.text, depth, line.textHeightMm, false, line.rightLimitMm))
  try {
    if (cutters.some(cutter => !cutter)) return false
    const geometry = mergeGeometries(cutters as THREE.BufferGeometry[])
    if (!geometry) throw new Error('订单侧刻字模未生成完整闭合网格')
    if (frontOnBedThickness !== undefined)
      geometry.translate(-panel.x, 0, 0).rotateY(Math.PI).translate(panel.x + panel.w, 0, frontOnBedThickness)
    return await subtractEngravingMeshes(meshes, panel, geometry, depth / (depth + .04))
  } finally { cutters.forEach(cutter => cutter?.dispose()) }
}

export async function engraveBackMarkMeshes(meshes: MeshData[], panel: SplitPanel, polygons: Point2D[][], depth: number,
  frontOnBedThickness?: number, requireCompleteText = false, backSurfaceZ = 0): Promise<boolean> {
  if (!polygons.length) return false
  const geometry = createMarkingGeometry(polygons, depth + 0.02)
  geometry.translate(0, 0, backSurfaceZ - 0.02)
  if (frontOnBedThickness !== undefined) {
    // Transform only the cutter; untouched front optical layers retain their exact original coordinates.
    geometry.translate(-panel.x, 0, 0).rotateY(Math.PI).translate(panel.x + panel.w, 0, frontOnBedThickness)
  }
  return subtractEngravingMeshes(meshes, panel, geometry, requireCompleteText ? depth / (depth + .02) : 0)
}

async function subtractEngravingMeshes(meshes: MeshData[], panel: SplitPanel, geometry: THREE.BufferGeometry, requiredCutFraction = 0): Promise<boolean> {
  geometry.translate(-panel.x, -panel.y, 0)
  const cutterData = geometryData(geometry)
  geometry.dispose()
  const { spatialManifold } = await import('./spatialSolid')
  const wasm = await spatialManifold()
  const cutter = solidFromMesh(cutterData, wasm)
  const box = cutter.boundingBox()
  const replacements = new Map<MeshData, MeshData>()
  let removedVolume = 0
  try {
    for (const mesh of meshes) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
      for (const vertex of mesh.vertices) for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vertex[axis]); max[axis] = Math.max(max[axis], vertex[axis])
      }
      if (min.some((value, axis) => value >= box.max[axis] || max[axis] <= box.min[axis])) continue
      const original = solidFromMesh(mesh, wasm)
      let engraved
      try {
        engraved = original.subtract(cutter)
        if (engraved.status() !== 'NoError' || engraved.isEmpty()) throw new Error('侧边凹刻无法生成闭合板件')
        const removed = original.volume() - engraved.volume()
        if (removed < 1e-6) continue
        removedVolume += removed
        const result = engraved.getMesh()
        const vertices: MeshData['vertices'] = Array.from({ length: result.vertProperties.length / result.numProp }, (_, i) =>
          [result.vertProperties[i * result.numProp], result.vertProperties[i * result.numProp + 1], result.vertProperties[i * result.numProp + 2]])
        const triangles: MeshData['triangles'] = []
        for (let i = 0; i < result.triVerts.length; i += 3) triangles.push([result.triVerts[i], result.triVerts[i + 1], result.triVerts[i + 2]])
        replacements.set(mesh, { vertices, triangles })
      } finally { engraved?.delete(); original.delete() }
    }
    const requiredVolume = cutter.volume() * requiredCutFraction
    if (requiredCutFraction && removedVolume < requiredVolume * .999 - .001)
      throw new Error('订单字模未完整落在实体表面，不能交付缺字刻印；请调整可用刻字位置后重新确认订单')
    for (const [mesh, result] of replacements) Object.assign(mesh, result)
    return replacements.size > 0
  } finally { cutter.delete() }
}

export async function engraveSideLogoPreview(root: THREE.Object3D, panel: SplitPanel, cfg: SplitConfig, brand: string, depth = 0.24, textHeight = 3.5, brandFallback = true): Promise<boolean> {
  return engravePreview(root, panel, meshes => engraveSideLogoMeshes(meshes, panel, cfg, brand, depth, textHeight, brandFallback))
}

export async function engraveSideOrderNumberPreview(root: THREE.Object3D, panel: SplitPanel, cfg: SplitConfig,
  number: string, depth = .24, textHeight = 3.5): Promise<boolean> {
  return engravePreview(root,panel,meshes=>engraveSideTraceMeshes(meshes,panel,cfg,[{text:number,textHeightMm:textHeight}],depth))
}

export async function engraveBackMarkPreview(root: THREE.Object3D, panel: SplitPanel, polygons: Point2D[][], depth: number, backSurfaceZ = 0): Promise<boolean> {
  return engravePreview(root, panel, meshes => engraveBackMarkMeshes(meshes, panel, polygons, depth, undefined, false, backSurfaceZ))
}

async function engravePreview(root: THREE.Object3D, panel: SplitPanel, apply: (meshes: MeshData[]) => Promise<boolean>): Promise<boolean> {
  root.updateMatrixWorld(true)
  const objects: THREE.Mesh[] = []
  root.traverse(object => { if ((object as THREE.Mesh).isMesh && !object.userData.previewOnly) objects.push(object as THREE.Mesh) })
  const data = objects.map(object => {
    const original = previewMeshTopology(object.geometry)
    if(original) {
      const vertices: MeshData['vertices'] = [], triangles: MeshData['triangles'] = []
      for(let i=0;i<original.vertices.length;i+=3) {
        const point=new THREE.Vector3(original.vertices[i],original.vertices[i+1],original.vertices[i+2]).applyMatrix4(object.matrixWorld)
        vertices.push([point.x-panel.x,point.y-panel.y,point.z])
      }
      for(let i=0;i<original.triangles.length;i+=3)triangles.push([original.triangles[i],original.triangles[i+1],original.triangles[i+2]])
      return {vertices,triangles}
    }
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld).translate(-panel.x, -panel.y, 0)
    try { return geometryData(geometry) } finally { geometry.dispose() }
  })
  const before = data.map(mesh => mesh.vertices)
  const applied = await apply(data)
  if (!applied) return false
  for (let i = 0; i < objects.length; i++) {
    if (data[i].vertices === before[i]) continue
    const object = objects[i]
    const inverse=object.matrixWorld.clone().invert()
    const vertices=data[i].vertices.flatMap(vertex=>{
      const point=new THREE.Vector3(vertex[0]+panel.x,vertex[1]+panel.y,vertex[2]).applyMatrix4(inverse)
      return [point.x,point.y,point.z]
    })
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geometry.setIndex(data[i].triangles.flat())
    const creased=toCreasedNormals(geometry,Math.PI/6);geometry.dispose()
    rememberPreviewMeshTopology(creased,{vertices,triangles:data[i].triangles.flat()})
    object.geometry.dispose(); object.geometry = creased
  }
  return true
}
