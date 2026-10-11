import type { MultiPolygon } from 'polygon-clipping'
import { texturePolygon as polygonClipping } from './texturePolygon'
import { buildTextureRegionContours, extrudeTextureRegions, type TextureContourDiagnostics, type TextureRegionPolygon } from './textureRegionContours'
import { extrudeTexturePartition } from './textureRegionExtrusion'

export interface RasterLayerInput {
  materials: Int16Array
  width: number
  height: number
  xBoundaries: number[]
  yBoundaries: number[]
  colorDomain: MultiPolygon
  panelId: string
  panelX: number
  panelY: number
  layer: number
  zMin: number
  zMax: number
  straightFit: boolean
  maxBoundaryEdges?: number
}

export interface RasterLayerMesh {
  name: string
  vertices: Array<[number, number, number]>
  triangles: Array<[number, number, number]>
}

export function buildRasterTextureLayer(input: RasterLayerInput): {
  meshes: Map<number, RasterLayerMesh>
  diagnostics: TextureContourDiagnostics
} {
  const built = buildTextureRegionContours({
    materials: input.materials,
    width: input.width,
    height: input.height,
    xBoundaries: input.xBoundaries,
    yBoundaries: input.yBoundaries,
    toleranceMm: 0.05,
    straightFit: input.straightFit,
    maxBoundaryEdges: input.maxBoundaryEdges,
  })
  const meshes = new Map<number, RasterLayerMesh>()
  for (const [material, polygons] of built.regions) {
    const multi: MultiPolygon = polygons.map(polygon => [polygon.outer, ...polygon.holes].map(ring => [...ring, ring[0]]))
    const exact = polygonClipping.intersection(multi, input.colorDomain)
    const local = exact.map(polygon => ({
      outer: polygon[0].slice(0, -1).map(([x, y]) => [x - input.panelX, y - input.panelY] as [number, number]),
      holes: polygon.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => [x - input.panelX, y - input.panelY] as [number, number])),
    }))
    if (!local.length) continue
    let geometry
    try { geometry = extrudeTextureRegions(local, input.zMin, input.zMax) }
    catch { geometry = extrudeTexturePartition(local as TextureRegionPolygon[], input.zMin, input.zMax) }
    const mesh: RasterLayerMesh = { name: `${input.panelId}-contour-${input.layer}-${material}`, vertices: [], triangles: [] }
    for (let i = 0; i < geometry.vertices.length; i += 3) mesh.vertices.push([geometry.vertices[i], geometry.vertices[i + 1], geometry.vertices[i + 2]])
    for (let i = 0; i < geometry.triangles.length; i += 3) mesh.triangles.push([geometry.triangles[i], geometry.triangles[i + 1], geometry.triangles[i + 2]])
    if (mesh.triangles.length) meshes.set(material, mesh)
  }
  return { meshes, diagnostics: built.diagnostics }
}

/** One worker per raster layer keeps cancellation and cleanup local to the export. */
export async function buildRasterTextureLayerResponsive(input: RasterLayerInput, signal?: AbortSignal): Promise<ReturnType<typeof buildRasterTextureLayer>> {
  if (typeof Worker === 'undefined') return buildRasterTextureLayer(input)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/textureRasterLayer.worker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => { signal?.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { cleanup(); reject(new DOMException('3MF 导出已取消', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    worker.onmessage = (event: MessageEvent<{ result?: ReturnType<typeof buildRasterTextureLayer>; error?: string }>) => {
      cleanup()
      if (event.data.error) reject(new Error(event.data.error))
      else if (event.data.result) resolve(event.data.result)
      else reject(new Error('纹理轮廓后台计算未返回结果'))
    }
    worker.onerror = event => { cleanup(); reject(new Error(event.message || '纹理轮廓后台计算失败')) }
    worker.postMessage(input)
  })
}
