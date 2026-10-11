import Module from 'manifold-3d'
import wasmUrl from 'manifold-3d/manifold.wasm?url'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { ExtrudeGeometry, Path, Shape, ShapeUtils, Vector2 } from 'three'
import type { SplitConfig, SplitPanel, HolePos } from '../types/geometry'
import { createSplitPanelShape } from './boardMesh'
import { findFootprintPlacement, getPrintBedBounds } from './printBed'
import type { SpatialMesh3MF } from './spatial3mf'
import { spatialHoleKey, type SpatialPanel } from './spatialPanels'
import { alignSpatialConnectionEdges, createSpatialLayout, faceAxes, faceToWorld, type SpatialFace, type SpatialLayout, type SpatialLayoutConfig } from './spatialLayout'
import { createBentFootprint } from './spatialBend'
import { generateEdgeHoles, recommendKnockouts, sweptCircleFitsMaterial } from './pegboardSplit'
import { pointInPolygon } from './holePattern'
import { applySpatialHoleTypes, originalPanelHoles } from './holeEditing'

let modulePromise: Promise<ManifoldToplevel> | null = null
export function spatialManifold(): Promise<ManifoldToplevel> {
  modulePromise ??= ((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
    ? Module() : Module({ locateFile: () => wasmUrl })).then(module => { module.setup(); return module })
  return modulePromise
}

/** Uses the same 2D manufacturing boundary/holes as ordinary split panels. */
export function panelToSolid(panel: SplitPanel, cfg: SplitConfig, wasm: ManifoldToplevel): Manifold {
  const shape = createSplitPanelShape(panel, { ...cfg, cornerRadius: 0 }, 20)
  const loops = [shape.getPoints(24), ...shape.holes.map(hole => hole.getPoints(24))]
    .map(points => points.map(point => [point.x, point.y] as [number, number]))
  const cross = new wasm.CrossSection(loops, 'EvenOdd')
  const extruded = cross.extrude(cfg.thickness)
  cross.delete()
  if (extruded.isEmpty()) { extruded.delete(); throw new Error(`${panel.id} 无有效板件实体`) }
  return extruded
}

/** Reuse the flat-panel extrusion bevel; reversed bevels form expanded hole mouths. */
function beveledExtrusion(polygons: [number, number][][], depth: number, chamfer: number,
  wasm: ManifoldToplevel, cutter = false): Manifold {
  const bevel = chamfer + (cutter ? 0.02 : 0)
  const section = new wasm.CrossSection(polygons, 'EvenOdd')
  let loops: Vector2[][]
  try { loops = section.toPolygons().map(loop => loop.map(([x, y]) => new Vector2(x, y))) }
  finally { section.delete() }
  const shapes = loops.filter(loop => !ShapeUtils.isClockWise(loop)).map(loop => new Shape(loop))
  for (const loop of loops.filter(loop => ShapeUtils.isClockWise(loop))) {
    const shape = shapes.find(shape => pointInPolygon(loop[0], shape.getPoints()))
    if (!shape) throw new Error('制造倒角截面的内孔缺少外轮廓')
    shape.holes.push(new Path(loop))
  }
  const geometry = new ExtrudeGeometry(shapes, {
    depth: depth - 2 * chamfer, bevelEnabled: true, bevelSegments: 1,
    bevelSize: cutter ? -bevel : bevel, bevelOffset: cutter ? bevel : -bevel,
    bevelThickness: bevel,
  })
  geometry.translate(0, 0, chamfer - (cutter ? depth / 2 : 0))
  try {
    const position = geometry.getAttribute('position')
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(position.array),
      triVerts: Uint32Array.from({ length: position.count }, (_, index) => index), tolerance: 1e-5 })
    mesh.merge()
    const solid = new wasm.Manifold(mesh)
    const status = solid.status()
    if (status !== 'NoError') { solid.delete(); throw new Error(`制造倒角网格未闭合：${status}`) }
    return solid
  } finally { geometry.dispose() }
}

function rect(minX: number, minY: number, maxX: number, maxY: number) {
  return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
}

/** Flat holes share one cutter; cylindrical holes share a radial cutter at each column. */
function faceHoleCutters(loops: [number, number][][], face: SpatialFace, cfg: SplitConfig,
  bevel: number, wasm: ManifoldToplevel): Manifold[] {
  const columns = new Map<number, [number, number][][]>()
  for (const loop of loops) {
    const x = face.curve ? Math.round((Math.min(...loop.map(p => p[0])) + Math.max(...loop.map(p => p[0]))) * 5e5) / 1e6 : 0
    const group = columns.get(x) ?? []
    group.push(loop.map(([px, y]) => [px - x, y]))
    columns.set(x, group)
  }
  const cutters: Manifold[] = []
  try {
    for (const [x, polygons] of columns) {
      const halfWidth = Math.max(...polygons.flatMap(loop => loop.map(p => Math.abs(p[0]))))
      const innerRadius = (face.curve?.radius ?? 0) - cfg.thickness / 2
      const extra = face.curve ? 2 * (innerRadius - Math.sqrt(Math.max(0, innerRadius ** 2 - halfWidth ** 2))) : 0
      let raw: Manifold
      if (bevel > 0.001) raw = beveledExtrusion(polygons, cfg.thickness + extra, bevel, wasm, true)
      else {
        const section = new wasm.CrossSection(polygons, 'EvenOdd')
        try { raw = section.extrude(cfg.thickness + extra + 0.04, 0, 0, [1, 1], true) }
        finally { section.delete() }
      }
      const { u } = faceAxes(face, x)
      const rotated = raw.rotate(0, -Math.atan2(u[2], u[0]) * 180 / Math.PI, 0); raw.delete()
      try { cutters.push(rotated.translate(faceToWorld(face, x, 0))) } finally { rotated.delete() }
    }
    return cutters
  } catch (error) { cutters.forEach(cutter => cutter.delete()); throw error }
}

export interface SpatialPrintPart { solid: Manifold; faces: SpatialPanel[] }

/** Reuse flat seam candidates on each clipped face, with the original unfolded phase. */
function printFacePanels(solid: Manifold, sources: SpatialPanel[], cfg: SplitConfig,
  design: SpatialLayoutConfig, heightOffset: number): SpatialPanel[] {
  if (!sources.length) return []
  const box = solid.boundingBox()
  const layout = createSpatialLayout({ ...design, height: sources[0].face.height, thickness: cfg.thickness })
  const trims = createBentFootprint(layout, design).trims
  return sources.flatMap(({ face, panel }, index) => {
    let x0 = 0, x1 = face.width
    if (face.curve) {
      // ponytail: quarter arcs use 0.25mm bounds samples plus physical hole probes; refine analytically if tighter cutting tolerance is needed.
      const steps = Math.ceil(face.width / 0.25)
      const inside = Array.from({ length: steps + 1 }, (_, step) => step * face.width / steps).filter(x => {
        const point = faceToWorld(face, x, 0)
        return [0, 2].every(axis => point[axis] >= box.min[axis] - 0.01 && point[axis] <= box.max[axis] + 0.01)
      })
      if (!inside.length) return []
      x0 = inside[0]; x1 = inside.at(-1)!
    } else for (const axis of [0, 2]) {
      if (Math.abs(face.u[axis]) < 1e-6) {
        if (face.origin[axis] < box.min[axis] - 0.01 || face.origin[axis] > box.max[axis] + 0.01) return []
      } else {
        const a = (box.min[axis] - face.origin[axis]) / face.u[axis]
        const b = (box.max[axis] - face.origin[axis]) / face.u[axis]
        x0 = Math.max(x0, Math.min(a, b)); x1 = Math.min(x1, Math.max(a, b))
      }
    }
    const y0 = Math.max(0, box.min[1] - face.origin[1]), y1 = Math.min(face.height, box.max[1] - face.origin[1])
    if (x1 - x0 < 1 || y1 - y0 < 1) return []
    const clipped: SplitPanel = { ...panel, x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      contour: rect(x0, y0, x1, y1), slots: panel.slots.filter(slot => slot.x >= x0 && slot.x <= x1 && slot.y >= y0 && slot.y <= y1),
      round_holes: panel.round_holes.filter(hole => hole.x >= x0 && hole.x <= x1 && hole.y >= y0 && hole.y <= y1),
      ...(panel.closed_holes ? { closed_holes: panel.closed_holes.filter(hole => hole.x >= x0 && hole.x <= x1 && hole.y >= y0 && hole.y <= y1) } : {}),
      edge_holes: panel.edge_holes.map(hole => ({ ...hole })) }
    clipped.edge_holes = printEdgeHoles(face, clipped, sources, cfg, design, heightOffset, trims).filter(hole => {
      const clearance = cfg.jointDiameter / 2 + cfg.holeBoundaryClearance
      if (hole.x < (trims[(index + sources.length - 1) % sources.length] ?? 0) + clearance || hole.x > face.width - (trims[index] ?? 0) - clearance) return false
      const point = faceToWorld(face, hole.x, hole.y)
      const { u, normal } = faceAxes(face, hole.x)
      if (point.some((value, axis) => {
        const extent = clearance * (Math.abs(u[axis]) + (axis === 1 ? 1 : 0)) + cfg.thickness / 2 * Math.abs(normal[axis])
        return value - extent < box.min[axis] - 0.01 || value + extent > box.max[axis] + 0.01
      })) return false
      const probeX = hole.x + clearance
      return solid.rayCast(faceToWorld(face, probeX, hole.y, -cfg.thickness / 2 - 1),
        faceToWorld(face, probeX, hole.y, cfg.thickness / 2 + 1)).length > 0
    })
    return [{ face, panel: clipped }]
  })
}

function printEdgeHoles(face: SpatialPanel['face'], panel: SplitPanel, sources: SpatialPanel[], cfg: SplitConfig,
  design: SpatialLayoutConfig, heightOffset: number, trims: number[]): HolePos[] {
  const first = sources[0].face.id === face.id
  const nearest = first ? face.width - design.cornerHoleInsetMm : design.cornerHoleInsetMm
  const localCfg = { ...cfg, slotGridY0: cfg.slotGridY0 - heightOffset,
    slotGridX0: design.template === 'L' ? ((nearest % cfg.mx) + cfg.mx) % cfg.mx - cfg.mx : cfg.slotGridX0 }
  const width = sources.reduce((sum, source) => sum + source.face.width, 0)
  const contour = panel.contour!
  const original = originalPanelHoles(panel)
  const candidates = [...original.edge_holes, ...generateEdgeHoles(contour,
    { x: design.template === 'L' ? 0 : -face.phaseU, y: 0 }, localCfg, original.slots, panel.cutouts, contour,
    rect(-face.phaseU, -heightOffset, width - face.phaseU, design.height - heightOffset))]
  const holes = new Map<string, HolePos>()
  const index = sources.findIndex(source => source.face.id === face.id)
  const clearance = cfg.jointDiameter / 2 + cfg.holeBoundaryClearance
  for (const hole of candidates) {
    if (design.template === 'L' && (first ? face.width - hole.x : hole.x) < design.cornerHoleInsetMm - 1e-6) continue
    if (hole.x < (trims[(index + sources.length - 1) % sources.length] ?? 0) + clearance || hole.x > face.width - (trims[index] ?? 0) - clearance) continue
    if (!sweptCircleFitsMaterial(hole, hole, cfg.jointDiameter / 2, cfg.holeBoundaryClearance, contour, panel.cutouts ?? [])) continue
    const key = spatialHoleKey(hole.x, hole.y)
    if (!holes.has(key) && ![...holes.values()].some(other =>
      Math.hypot(other.x - hole.x, other.y - hole.y) < Math.max(cfg.jointDiameter + cfg.gapTolerance, Math.min(cfg.mx, cfg.my)) - 1e-6)) {
      holes.set(key, { ...hole })
    }
  }
  return [...holes.values()]
}

/** Cut the actual folded solid into separate, closed print objects; never fuse the pieces again. */
export function splitSolidForPrint(solid: Manifold, cfg: SplitConfig, design: SpatialLayoutConfig,
  wasm: ManifoldToplevel, sources: SpatialPanel[] = [], heightOffset = 0): SpatialPrintPart[] {
  design = alignSpatialConnectionEdges(design, cfg)
  const bed = getPrintBedBounds(cfg)
  const pitch = Math.max(1, Math.min(cfg.mx, cfg.my))
  const maxSpan = Math.max(bed.width, bed.height), minSpan = Math.min(bed.width, bed.height)
  const pending = solid.decompose(), result: Manifold[] = []
  try {
    while (pending.length) {
      const piece = pending.pop()!
      if (piece.status() !== 'NoError' || piece.isEmpty()) {
        piece.delete(); throw new Error('立体切分未生成有效的闭合制造件')
      }
      const box = piece.boundingBox(), w = box.max[0] - box.min[0], d = box.max[2] - box.min[2]
      if (findFootprintPlacement(rect(0, 0, w, d), cfg) || findFootprintPlacement(rect(0, 0, d, w), cfg)) {
        result.push(piece); continue
      }
      const axis = w >= d ? 0 : 2
      const length = box.max[axis] - box.min[axis]
      const limit = length > maxSpan ? maxSpan : minSpan
      const guard = Math.min(limit / 2, Math.max(pitch, design.cornerHoleInsetMm + cfg.jointOffsetX))
      const phase = axis === 2 && design.template === 'L' && design.angleDegrees === 90
        ? -design.cornerHoleInsetMm + pitch / 2 : axis === 0 ? cfg.jointOffsetX - pitch / 2 : 0
      let cut = phase + Math.floor((Math.min(box.min[axis] + limit, box.max[axis] - guard) - phase) / pitch) * pitch
      if (cut <= box.min[axis] + 1e-4 || cut >= box.max[axis] - 1e-4) cut = (box.min[axis] + box.max[axis]) / 2
      if (length < 1 || result.length + pending.length > 10000) {
        piece.delete(); throw new Error('切分后仍无法避开当前热床禁放区，请调整打印空间设置')
      }
      const halves = piece.splitByPlane(axis === 0 ? [1, 0, 0] : [0, 0, 1], cut)
      piece.delete()
      try { for (const [index, half] of halves.entries()) {
          const finished = bevelCutFace(half, axis, cut, index === 0 ? 1 : -1, cfg, wasm)
          try { pending.push(...finished.decompose()) } finally { finished.delete() }
      } } finally { halves.forEach(half => half.delete()) }
    }
    result.sort((a, b) => a.boundingBox().min[0] - b.boundingBox().min[0] ||
      a.boundingBox().min[2] - b.boundingBox().min[2])
    const parts = result.map((piece, index) => ({ solid: piece,
      faces: printFacePanels(piece, sources, cfg, design, heightOffset).map(source => ({ ...source,
        panel: { ...source.panel, id: `${source.panel.id}-M${index + 1}` } })) }))
    const trims = sources.length
      ? createBentFootprint(createSpatialLayout({ ...design, thickness: cfg.thickness, height: sources[0].face.height }), design).trims : []
    for (const source of sources) {
      const panels = parts.flatMap(part => part.faces.filter(item => item.face.id === source.face.id).map(item => item.panel))
      const neighbors = panels.flatMap(panel => [-1, 1].flatMap(direction => {
        if (direction < 0 ? heightOffset <= 0 || panel.y > 0.01 :
          heightOffset + source.face.height >= design.height - 0.01 || panel.y + panel.h < source.face.height - 0.01) return []
        const height = cfg.my * 2
        const y = direction < 0 ? -height : source.face.height
        const ghost: SplitPanel = { ...panel, id: `${panel.id}-neighbor-${direction}`, y, h: height,
          contour: rect(panel.x, y, panel.x + panel.w, y + height), slots: [], edge_holes: [] }
        ghost.edge_holes = printEdgeHoles(source.face, ghost, sources, cfg, design, heightOffset, trims)
        return [ghost]
      }))
      recommendKnockouts([...panels, ...neighbors], cfg)
    }
    for (const [index, part] of parts.entries()) {
      const cutters: Manifold[] = []
      try {
        for (const { face, panel } of part.faces) {
          for (const hole of panel.edge_holes) {
            const override = design.holeOverrides[spatialHoleKey(face.phaseU + hole.x, hole.y + heightOffset)]
            if (override !== undefined) { hole.knocked = override; hole.manual = true }
          }
          Object.assign(panel, applySpatialHoleTypes(panel, face.phaseU, heightOffset, design.holeTypeOverrides, { ...cfg, cornerRadius: 0 }))
          const shape = createSplitPanelShape({ ...panel, cutouts: [], latticeCutouts: [], round_holes: [],
            slots: panel.slots.filter(hole => hole.editOrigin?.group === 'edge_holes'),
            edge_holes: panel.edge_holes.filter(hole => hole.knocked) }, { ...cfg, cornerRadius: 0 }, 12)
          const loops = shape.holes.map(path => path.getPoints(24).map(point => [point.x, point.y] as [number, number]))
          if (!loops.length) continue
          const bevel = Math.max(0, Math.min(cfg.manufacturingChamfer, cfg.thickness / 3, cfg.slotWidth / 4))
          cutters.push(...faceHoleCutters(loops, face, cfg, bevel, wasm))
        }
        if (cutters.length) {
          const drilled = wasm.Manifold.difference([part.solid, ...cutters])
          part.solid.delete(); part.solid = drilled; result[index] = drilled
          if (drilled.status() !== 'NoError' || drilled.isEmpty()) throw new Error('分件圆孔未生成闭合实体')
          const components = drilled.decompose()
          const connected = components.length === 1
          components.forEach(component => component.delete())
          if (!connected) throw new Error('该接缝圆孔会断开制造件，请关闭孔位或调整分件尺寸')
        }
      } finally { cutters.forEach(cutter => cutter.delete()) }
    }
    return parts
  } catch (error) { [...pending, ...result].forEach(piece => piece.delete()); throw error }
}

function bevelCutFace(solid: Manifold, axis: number, cut: number, inward: number,
  cfg: SplitConfig, wasm: ManifoldToplevel): Manifold {
  const rotated = axis === 0 ? solid.rotate(0, -90, 0) : solid.translate(0, 0, 0)
  const shifted = rotated.translate(0, 0, -cut); rotated.delete()
  const local = inward > 0 ? shifted : shifted.rotate(180, 0, 0)
  if (inward < 0) shifted.delete()
  let shaped: Manifold | null = null
  try {
    const bevel = Math.max(0, Math.min(cfg.manufacturingChamfer, cfg.slotWidth / 4,
      cfg.thickness / 3, local.boundingBox().max[2] / 4))
    if (bevel <= 0.001) shaped = local.translate(0, 0, 0)
    else {
      const slice = local.slice(2 * bevel)
      const outlines = slice.toPolygons().filter(loop => loop.reduce((area, point, i) => {
        const next = loop[(i + 1) % loop.length]
        return area + point[0] * next[1] - next[0] * point[1]
      }, 0) > 0)
      slice.delete()
      const masks: Manifold[] = []
      // ponytail: cap masks use convex hulls and are clipped by the original solid; cavities stay open.
      for (const outline of outlines) {
        const profile = new wasm.CrossSection([outline], 'EvenOdd')
        const inset = profile.offset(-bevel, 'Miter')
        try {
          if (inset.isEmpty()) continue
          const innerRing = profile.extrude(0.001)
          const raised = innerRing.translate(0, 0, bevel); innerRing.delete()
          const outerRing = inset.extrude(0.001)
          try { masks.push(wasm.Manifold.hull([raised, outerRing])) }
          finally { raised.delete(); outerRing.delete() }
        } finally { profile.delete(); inset.delete() }
      }
      const inner = local.trimByPlane([0, 0, 1], bevel)
      if (!masks.length) shaped = inner
      else {
        const cap = wasm.Manifold.union(masks)
        masks.forEach(mask => mask.delete())
        const outer = local.intersect(cap); cap.delete()
        try { shaped = wasm.Manifold.union([outer, inner]) } finally { outer.delete(); inner.delete() }
      }
    }
    const flipped = inward > 0 ? shaped.translate(0, 0, 0) : shaped.rotate(180, 0, 0)
    const positioned = flipped.translate(0, 0, cut); flipped.delete()
    if (axis !== 0) return positioned
    const restored = positioned.rotate(0, 90, 0); positioned.delete()
    return restored
  } finally { local.delete(); shaped?.delete() }
}

/** Move assembled XYZ (Y up) into printer XYZ (Z up) and fit the effective bed. */
export function manifoldToPrinterMesh(solid: Manifold, cfg: SplitConfig, name: string): SpatialMesh3MF {
  const mesh = solid.getMesh()
  const count = mesh.vertProperties.length / mesh.numProp
  for (const angle of [0, 90]) {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < count; i++) {
      const offset = i * mesh.numProp
      const worldX = mesh.vertProperties[offset], worldZ = mesh.vertProperties[offset + 2]
      const x = angle === 0 ? worldX : worldZ
      const y = angle === 0 ? -worldZ : worldX
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, mesh.vertProperties[offset + 1])
    }
    const location = findFootprintPlacement(rect(minX, minY, maxX, maxY), cfg)
    if (!location) continue
    const vertices = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const offset = i * mesh.numProp
      const worldX = mesh.vertProperties[offset], worldZ = mesh.vertProperties[offset + 2]
      vertices[i * 3] = (angle === 0 ? worldX : worldZ) + location.x
      vertices[i * 3 + 1] = (angle === 0 ? -worldZ : worldX) + location.y
      vertices[i * 3 + 2] = mesh.vertProperties[offset + 1] - minZ
    }
    return { name, vertices, triangles: new Uint32Array(mesh.triVerts) }
  }
  throw new Error(`${name} 无法放入当前打印机有效热床`)
}

export async function createOnePieceSolid(layout: SpatialLayout, panels: SpatialPanel[], cfg: SplitConfig,
  config: SpatialLayoutConfig, onProgress?: (message: string, progress: number) => void): Promise<{ solid: Manifold; wasm: ManifoldToplevel }> {
  const wasm = await spatialManifold()
  if (layout.template !== 'flat') {
    const bend = createBentFootprint(layout, config)
    const height = layout.faces[0].height
    const chamfer = Math.max(0, Math.min(cfg.manufacturingChamfer, cfg.thickness / 3, cfg.slotWidth / 4, height / 3))
    let section = new wasm.CrossSection(bend.polygons, 'EvenOdd')
    if (chamfer > 0.001 && (layout.template === 'L' || layout.template === 'U')) {
      // Shave both corners of each free end, while retaining the nominal end plane and 10mm hole inset.
      const ends = [{ face: layout.faces[0], x: 0, inward: 1 },
        { face: layout.faces.at(-1)!, x: layout.faces.at(-1)!.width, inward: -1 }]
      const padding = 0.02
      const triangles = ends.flatMap(({ face, x, inward }) => [-1, 1].map(sign => [
        faceToWorld(face, x - inward * padding, 0, sign * (cfg.thickness / 2 + padding)),
        faceToWorld(face, x + inward * (chamfer + padding), 0, sign * (cfg.thickness / 2 + padding)),
        faceToWorld(face, x - inward * padding, 0, sign * (cfg.thickness / 2 - chamfer - padding)),
      ].map(point => [point[0], -point[2]] as [number, number])))
      const corners = new wasm.CrossSection(triangles, 'EvenOdd')
      const trimmed = section.subtract(corners)
      section.delete(); corners.delete(); section = trimmed
    }
    let upright: Manifold
    try { upright = chamfer > 0.001
      ? beveledExtrusion(section.toPolygons(), height, chamfer, wasm) : section.extrude(height) }
    finally { section.delete() }
    let body = upright.rotate(-90, 0, 0)
    upright.delete()
    onProgress?.('正在生成连续恒厚的圆润转角…', 0.35)
    const cutters: Manifold[] = []
    try {
      for (let index = 0; index < panels.length; index++) {
        const { face, panel } = panels[index]
        const inset = cfg.slotWidth / 2 + cfg.holeBoundaryClearance
        const safeStart = (bend.trims[(index + layout.faces.length - 1) % layout.faces.length] ?? 0) + inset
        const safeEnd = face.width - (bend.trims[index] ?? 0) - inset
        const slots = face.curve ? panel.slots : panel.slots.filter(slot => slot.x >= safeStart && slot.x <= safeEnd)
        const shape = createSplitPanelShape({ ...panel, slots }, { ...cfg, cornerRadius: 0 }, 20)
        if (!shape.holes.length) continue
        const holes = shape.holes.map(hole => hole.getPoints(24).map(point => [point.x, point.y] as [number, number]))
        cutters.push(...faceHoleCutters(holes, face, cfg, chamfer, wasm))
        onProgress?.(`正在开通孔 ${index + 1}/${panels.length} 面`, 0.45 + 0.3 * (index + 1) / panels.length)
      }
      if (cutters.length) {
        const drilled = wasm.Manifold.difference([body, ...cutters])
        body.delete()
        body = drilled
      }
      const components = body.decompose()
      const connected = components.length === 1
      components.forEach(component => component.delete())
      if (body.isEmpty() || !connected) throw new Error('圆润一体板未形成单个闭合实体')
      return { solid: body, wasm }
    } catch (error) { body.delete(); throw error }
    finally { cutters.forEach(cutter => cutter.delete()) }
  }
  const bodies: Manifold[] = []
  try {
    for (let index = 0; index < panels.length; index++) {
      const { face, panel } = panels[index]
      const raw = panelToSolid(panel, cfg, wasm)
      const centered = raw.translate(0, 0, -cfg.thickness / 2)
      raw.delete()
      const rotated = centered.rotate(0, -Math.atan2(face.u[2], face.u[0]) * 180 / Math.PI, 0)
      centered.delete()
      const placed = rotated.translate(face.origin)
      rotated.delete()
      bodies.push(placed)
      onProgress?.(`正在融合 ${index + 1}/${panels.length} 个立体面`, 0.35 + 0.4 * (index + 1) / panels.length)
    }
    const solid = wasm.Manifold.union(bodies)
    const components = solid.decompose()
    const connected = components.length === 1
    components.forEach(component => component.delete())
    if (solid.isEmpty() || !connected) {
      solid.delete()
      throw new Error('一体模式未形成单个连续闭合实体')
    }
    return { solid, wasm }
  } finally { bodies.forEach(body => body.delete()) }
}
