import type { HolePos, Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import { crystalSlots, SKADIS_DEFAULTS } from './holePattern'
import { generateEdgeHoles, recommendKnockouts, sweptCircleFitsMaterial } from './pegboardSplit'
import { findFootprintPlacement, rotatePlanarPoints } from './printBed'
import { alignSpatialConnectionEdges, DEFAULT_SPATIAL_LAYOUT, spatialHeightLimit, type SpatialFace, type SpatialLayout, type SpatialLayoutConfig } from './spatialLayout'
import { createBentFootprint } from './spatialBend'
import { applySpatialHoleTypes } from './holeEditing'
import type { SplitWorkerRequest } from '../workers/splitEngineProtocol'
import { startSplitWorker } from './splitWorkerClient'

export interface SpatialPanel { face: SpatialFace; panel: SplitPanel }
export interface SpatialHeightSection {
  index: number; offsetY: number; height: number; layout: SpatialLayout; panels: SpatialPanel[]
}

const rectangle = (x: number, y: number, w: number, h: number): Point2D[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]

export const spatialHoleKey = (unfoldedX: number, y: number) =>
  `${Math.round(unfoldedX * 1000)},${Math.round(y * 1000)}`

export function spatialConnectorMountsOpen(layout: SpatialLayout, pieces: SpatialPanel[]): boolean {
  return layout.faces.every(face => cornerMounts(layout, face, true).every(mount =>
    pieces.some(piece => piece.face.id === face.id && piece.panel.edge_holes.some(hole =>
      Math.abs(hole.x - mount.x) < 0.01 && Math.abs(hole.y - mount.y) < 0.01 && hole.knocked))))
}

function cornerMounts(layout: SpatialLayout, face: SpatialFace, enabled: boolean): HolePos[] {
  if (!enabled) return []
  if (face.width < 55 || face.height < 45) throw new Error(`${face.id} 太窄或太矮，无法设置 M3 连接件固定孔`)
  const xs = layout.junctions.flatMap(junction =>
    junction.from === face.id ? [face.width - 20] : junction.to === face.id ? [20] : [])
  const ys = face.height >= 100 ? [25, face.height - 25] : [face.height / 2]
  return [...new Set(xs)].flatMap(x => ys.map(y => ({ x, y })))
}

function slotClashesMount(slot: HolePos, mount: HolePos, cfg: SplitConfig): boolean {
  const straightHalf = Math.max(0, (cfg.slotLength - cfg.slotWidth) / 2)
  const dy = Math.max(0, Math.abs(slot.y - mount.y) - straightHalf)
  return Math.hypot(slot.x - mount.x, dy) <= (cfg.slotWidth + cfg.jointDiameter) / 2 + 0.2
}

function slotPhase(layout: SpatialLayout, face: SpatialFace, cfg: SplitConfig, design: SpatialLayoutConfig): number {
  if (layout.template !== 'L') return cfg.slotGridX0 - face.phaseU
  const nearest = face.id === layout.faces[0].id
    ? face.width - design.cornerHoleInsetMm : design.cornerHoleInsetMm
  // crystalSlots starts at index zero; include the preceding B column when its phase is negative.
  return ((nearest % cfg.mx) + cfg.mx) % cfg.mx - cfg.mx
}

function cornerDistance(layout: SpatialLayout, face: SpatialFace, x: number): number {
  return face.id === layout.faces[0].id ? face.width - x : x
}

function fullFacePanels(layout: SpatialLayout, cfg: SplitConfig, connector: boolean,
  design: SpatialLayoutConfig): SpatialPanel[] {
  const run = layout.faces.reduce((sum, face) => sum + face.width, 0)
  const pattern = {
    ...SKADIS_DEFAULTS,
    slotLength: cfg.slotLength, slotWidth: cfg.slotWidth,
    spacingX: cfg.mx, spacingY: cfg.my * 2,
    slotGridX0: cfg.slotGridX0, slotGridY0: cfg.slotGridY0,
    slotStaggerX: cfg.slotStaggerX, slotStaggerY: cfg.slotStaggerY,
  }
  const allSlots = layout.template === 'L' ? [] : crystalSlots(run, layout.faces[0].height, pattern)
  return layout.faces.map(face => {
    const mountHoles = cornerMounts(layout, face, connector)
    const edgeBand = cfg.holeBoundaryClearance + cfg.slotWidth / 2
    const faceSlots = layout.template === 'L'
      ? crystalSlots(face.width, face.height, { ...pattern, slotGridX0: slotPhase(layout, face, cfg, design) })
      : allSlots
    const slots: HolePos[] = faceSlots.flatMap(slot => {
      const x = layout.template === 'L' ? slot.x : slot.x - face.phaseU
      const clashesMount = mountHoles.some(hole => slotClashesMount({ x, y: slot.y }, hole, cfg))
      return (face.curve ? x >= 0 && x < face.width : x >= edgeBand && x <= face.width - edgeBand) && !clashesMount &&
        (layout.template !== 'L' || cornerDistance(layout, face, x) >= design.cornerHoleInsetMm - 1e-6)
        ? [{ x, y: slot.y }] : []
    })
    return { face, panel: {
      id: `${face.id}-P1`, x: 0, y: 0, w: face.width, h: face.height,
      contour: rectangle(0, 0, face.width, face.height),
      roundIdx: [], outerCorners: [false, false, false, false],
      slots, round_holes: [], edge_holes: [],
    } }
  })
}

function splitInWorker(layout: SpatialLayout, cfg: SplitConfig, design: SpatialLayoutConfig, signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void): Promise<SpatialPanel[]> {
  const targets = layout.faces.map(face => ({
    contourId: face.id, name: face.id, sourceIds: [face.id],
    points: rectangle(0, 0, face.width, face.height),
    holes: [],
    cornerPolicy: 'preserve-source' as const,
    config: { ...cfg, cornerRadius: 0, slotGridX0: slotPhase(layout, face, cfg, design),
      minW: Math.min(cfg.minW, face.width), minH: Math.min(cfg.minH, face.height),
      minFeatureWidth: Math.min(cfg.minFeatureWidth, face.width) },
  }))
  const finish = (sources: Array<{ contourId: string; panels: SplitPanel[]; warnings: string[]; coverageRatio: number }>) =>
    sources.flatMap(source => {
      const face = layout.faces.find(item => item.id === source.contourId)!
      if (source.coverageRatio < 0.995 || !source.panels.length) {
        throw new Error(`${face.id} 热床切分未完整覆盖板面：${source.warnings[0] ?? '无有效板件'}`)
      }
      return source.panels.map((panel, index) => ({ face, panel: { ...panel, id: `${face.id}-P${index + 1}` } }))
    })
  const request: SplitWorkerRequest = { jobId: 1, targets, holes: [], config: cfg }
  return startSplitWorker(request, onProgress, signal).promise.then(finish)
}

export async function createSpatialPanels(layout: SpatialLayout, cfg: SplitConfig,
  mode: 'monolithic' | 'per-face' | 'bed-split', connector = false, signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
  design: SpatialLayoutConfig = DEFAULT_SPATIAL_LAYOUT): Promise<SpatialPanel[]> {
  design = alignSpatialConnectionEdges(design, cfg)
  const panels = mode === 'bed-split' ? await splitInWorker(layout, cfg, design, signal, onProgress) : fullFacePanels(layout, cfg, connector, design)
  const unfoldedWidth = layout.faces.reduce((sum, face) => sum + face.width, 0)
  const trims = mode === 'monolithic' && layout.template !== 'flat'
    ? createBentFootprint(layout, design).trims : []
  const mountsByFace = new Map(layout.faces.map(face => [face.id, cornerMounts(layout, face, connector)]))
  for (const { face, panel } of panels) {
    const mounts = mountsByFace.get(face.id) ?? []
    if (mounts.length) panel.slots = panel.slots.filter(slot =>
      !mounts.some(mount => slotClashesMount(slot, mount, cfg)))
    const contour = panel.contour ?? rectangle(panel.x, panel.y, panel.w, panel.h)
    const unfoldedContour = rectangle(-face.phaseU, 0, unfoldedWidth, face.height)
    const faceIndex = layout.faces.indexOf(face)
    const clearance = cfg.jointDiameter / 2 + cfg.holeBoundaryClearance
    if (layout.template === 'L') panel.slots = panel.slots.filter(slot =>
      cornerDistance(layout, face, slot.x) >= design.cornerHoleInsetMm - 1e-6)
    if (mode === 'monolithic' && trims.length) {
      const slotClearance = cfg.slotWidth / 2 + cfg.holeBoundaryClearance
      panel.slots = panel.slots.filter(slot =>
        slot.x >= (trims[(faceIndex + layout.faces.length - 1) % layout.faces.length] ?? 0) + slotClearance &&
        slot.x <= face.width - (trims[faceIndex] ?? 0) - slotClearance)
    }
    const localCfg = layout.template === 'L' ? { ...cfg, slotGridX0: slotPhase(layout, face, cfg, design) } : cfg
    const latticeX = layout.template === 'L' ? 0 : -face.phaseU
    panel.edge_holes = generateEdgeHoles(contour, { x: latticeX, y: 0 }, localCfg,
      panel.slots, panel.cutouts, contour, unfoldedContour).filter(hole =>
      (!face.curve || hole.y <= cfg.jointOffsetY + 0.01 || hole.y >= face.height - cfg.jointOffsetY - 0.01) &&
      (mode !== 'monolithic' ||
        (hole.x >= (trims[(faceIndex + layout.faces.length - 1) % layout.faces.length] ?? 0) + clearance &&
         hole.x <= face.width - (trims[faceIndex] ?? 0) - clearance)) &&
      (layout.template !== 'L' || cornerDistance(layout, face, hole.x) >= design.cornerHoleInsetMm - 1e-6) &&
      !mounts.some(mount => Math.hypot(hole.x - mount.x, hole.y - mount.y) < cfg.jointDiameter + cfg.gapTolerance))
    if (layout.template === 'L') {
      const x = faceIndex === 0 ? face.width - design.cornerHoleInsetMm : design.cornerHoleInsetMm
      panel.edge_holes = panel.edge_holes.filter(hole => Math.abs(hole.x - x) > 0.01)
      for (let y = cfg.slotGridY0 - cfg.slotStaggerY; y <= face.height - clearance; y += cfg.my * 2) {
        const circle = { x, y }
        if (sweptCircleFitsMaterial(circle, circle, cfg.jointDiameter / 2,
          cfg.holeBoundaryClearance, contour, panel.cutouts ?? []) &&
          !panel.slots.some(slot => slotClashesMount(slot, circle, cfg)) &&
          !mounts.some(mount => Math.hypot(x - mount.x, y - mount.y) < cfg.jointDiameter + cfg.gapTolerance)) {
          panel.edge_holes.push(circle)
        }
      }
    }
  }
  if (mode !== 'monolithic') {
    for (const face of layout.faces) {
      const facePanels = panels.filter(piece => piece.face.id === face.id).map(piece => piece.panel)
      recommendKnockouts(facePanels, cfg)
      for (const mount of mountsByFace.get(face.id) ?? []) {
        const owner = facePanels.find(panel => sweptCircleFitsMaterial(mount, mount,
          cfg.jointDiameter / 2, cfg.holeBoundaryClearance,
          panel.contour ?? rectangle(panel.x, panel.y, panel.w, panel.h), panel.cutouts ?? []))
        if (!owner) throw new Error(`${face.id} 的连接件固定孔落在分板缝上，请调整面片尺寸或热床设置`)
        owner.edge_holes.push({ ...mount, knocked: true })
      }
    }
  }
  for (const { face, panel } of panels) for (const hole of panel.edge_holes) {
    const override = design.holeOverrides[spatialHoleKey(face.phaseU + hole.x, hole.y)]
    if (override !== undefined) { hole.knocked = override; hole.manual = true }
  }
  for (const { face, panel } of panels) Object.assign(panel,
    applySpatialHoleTypes(panel, face.phaseU, 0, design.holeTypeOverrides, { ...cfg, cornerRadius: 0 }))
  if (mode !== 'monolithic') {
    for (const { panel } of panels) {
      const footprint = panel.contour?.length ? panel.contour : rectangle(panel.x, panel.y, panel.w, panel.h)
      if (!findFootprintPlacement(footprint, cfg) && !findFootprintPlacement(rotatePlanarPoints(footprint, 90), cfg)) {
        throw new Error(`${panel.id} 无法放入当前打印机有效热床`)
      }
    }
  }
  return panels
}

/** Split a tall bent part into printable-height modules without resetting the unfolded hole phase. */
export function splitSpatialHeight(layout: SpatialLayout, panels: SpatialPanel[], maxHeight: number,
  cfg: SplitConfig): SpatialHeightSection[] {
  if (!Number.isFinite(maxHeight) || maxHeight < 20) throw new Error('打印机安全可用高度不足，无法进行立体分节')
  const total = layout.faces[0].height
  const count = Math.max(1, Math.ceil(total / spatialHeightLimit(maxHeight, cfg)))
  if (count === 1) return [{ index: 0, offsetY: 0, height: total, layout, panels }]
  const base = Math.floor(total / count / cfg.my) * cfg.my
  const extra = Math.floor((total - base * count) / cfg.my)
  let offsetY = 0
  const slotInset = cfg.slotLength / 2 + cfg.holeBoundaryClearance
  const circleInset = cfg.jointDiameter / 2 + cfg.holeBoundaryClearance
  return Array.from({ length: count }, (_, index) => {
    const start = offsetY
    const height = index === count - 1 ? total - start : base + (index < extra ? cfg.my : 0)
    offsetY += height
    const sectionLayout: SpatialLayout = { ...layout,
      faces: layout.faces.map(face => ({ ...face, height })) }
    const sectionPanels = panels.map(({ face, panel }) => {
      const localFace = sectionLayout.faces.find(item => item.id === face.id)!
      const within = (y: number, inset: number) =>
        y >= start + inset - 1e-6 && y <= start + height - inset + 1e-6
      return { face: localFace, panel: { ...panel, y: 0, h: height,
        contour: rectangle(0, 0, face.width, height),
        slots: panel.slots.filter(slot => within(slot.y, slotInset))
          .map(slot => ({ ...slot, y: slot.y - start })),
        edge_holes: panel.edge_holes.filter(hole => within(hole.y, circleInset))
          .map(hole => ({ ...hole, y: hole.y - start })),
        round_holes: panel.round_holes.filter(hole => within(hole.y, circleInset))
          .map(hole => ({ ...hole, y: hole.y - start })),
        ...(panel.closed_holes ? { closed_holes: panel.closed_holes.filter(hole => within(hole.y, hole.editOrigin?.group === 'slots' ? slotInset : circleInset))
          .map(hole => ({ ...hole, y: hole.y - start })) } : {}),
      } }
    })
    return { index, offsetY: start, height, layout: sectionLayout, panels: sectionPanels }
  })
}
