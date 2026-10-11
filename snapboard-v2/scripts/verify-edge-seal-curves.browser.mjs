import { createManufacturing3MF } from '/src/utils/export3mf.ts'
import { createDefaultBoardTexture } from '/src/utils/boardTexture.ts'
import { PEGBOARD_DEFAULT_CONFIG } from '/src/utils/pegboardSplit.ts'
import { strFromU8, unzipSync } from 'fflate'

const panel = {
  id: 'slot-seal', x: 0, y: 0, w: 30, h: 30,
  contour: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }],
  slots: [{ x: 15, y: 15 }], round_holes: [], edge_holes: [], cutouts: [],
  roundIdx: [], outerCorners: [false, false, false, false],
}

const sealMesh = data => {
  const xml = strFromU8(unzipSync(data)['3D/Objects/object_1.model'])
  const object = [...xml.matchAll(/<object id="\d+" type="model" name="([^"]+)">([\s\S]*?)<\/object>/g)]
    .find(match => match[1].includes('基材单线封边墙'))
  if (!object) throw new Error('Missing structural edge-seal object')
  const vertices = [...object[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)]
    .map(([, x, y, z]) => [Number(x), Number(y), Number(z)])
  const triangles = [...object[2].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)]
    .map(([, a, b, c]) => [Number(a), Number(b), Number(c)])
  const parent = vertices.map((_, index) => index)
  const root = index => parent[index] === index ? index : parent[index] = root(parent[index])
  for (const [a, b, c] of triangles) parent[root(a)] = root(b), parent[root(b)] = root(c)
  return { vertices, triangles: triangles.length, components: new Set(parent.map((_, index) => root(index))).size }
}

export async function run() {
  const base = {
    panels: [panel], cfg: { ...PEGBOARD_DEFAULT_CONFIG, thickness: 5, manufacturingChamfer: 0.35, slotLength: 14, slotWidth: 6 },
    placedParts: [], partDefinitions: [],
  }
  const texture = { ...createDefaultBoardTexture(), enabled: true, source: 'preset', manufacturingContours: true, edgeSealEnabled: true }
  const smooth = await createManufacturing3MF({ ...base, boardTexture: texture })
  const legacy = await createManufacturing3MF({ ...base, boardTexture: { ...texture, manufacturingContours: false } })
  const a = sealMesh(smooth.data), b = sealMesh(legacy.data)
  const curved = a.vertices.filter(([x, y]) => x > 12 && x < 18 && y > 19 && y < 23)
  const onSlotArc = vertices => vertices.filter(([x, y]) => y > 19 && Math.abs(Math.hypot(x - 15, y - 19) - 3) < 0.005).length
  if (smooth.warnings.length || a.components > 12 || a.components >= b.components || onSlotArc(a.vertices) <= onSlotArc(b.vertices) * 5) {
    throw new Error(`Seal continuity/curvature regression: ${JSON.stringify({ warnings: smooth.warnings, smooth: a.components, legacy: b.components, smoothArc: onSlotArc(a.vertices), legacyArc: onSlotArc(b.vertices) })}`)
  }
  return {
    artifacts: [{name:'round-slot-seal.3mf',data:Array.from(smooth.data)}],
    smooth: { triangles: a.triangles, vertices: a.vertices.length, components: a.components, curvedVertices: curved.length, arcVertices: onSlotArc(a.vertices), curvedSample: curved.slice(0, 8) },
    legacy: { triangles: b.triangles, vertices: b.vertices.length, components: b.components, arcVertices: onSlotArc(b.vertices) },
    warnings: smooth.warnings,
  }
}
