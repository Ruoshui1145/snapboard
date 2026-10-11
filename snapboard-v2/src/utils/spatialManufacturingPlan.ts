import type { SplitConfig } from '../types/geometry'
import { getBambuPrinterPreset } from './bambuPrinterPresets'
import { findFootprintPlacement, getPrintBedBounds, rotatePlanarPoints } from './printBed'
import { alignSpatialConnectionEdges, createSpatialLayout, faceToWorld, spatialHeightLimit, type SpatialLayoutConfig, type SpatialManufacturingMode } from './spatialLayout'
import { createBentFootprint } from './spatialBend'

export type ResolvedSpatialMode = Exclude<SpatialManufacturingMode, 'auto'>

function fitsBed(width: number, height: number, cfg: SplitConfig): number | null {
  const rectangle = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]
  for (const angle of [0, 90]) {
    if (findFootprintPlacement(rotatePlanarPoints(rectangle, angle), cfg)) return angle
  }
  return null
}

export function resolveSpatialManufacturing(config: SpatialLayoutConfig, cfg: SplitConfig) {
  config = alignSpatialConnectionEdges(config, cfg)
  const layout = createSpatialLayout({ ...config, thickness: cfg.thickness })
  const safe = config.printSafetyMarginMm
  const printCfg: SplitConfig = { ...cfg,
    bedMarginLeft: Math.max(cfg.bedMarginLeft, safe), bedMarginRight: Math.max(cfg.bedMarginRight, safe),
    bedMarginBottom: Math.max(cfg.bedMarginBottom, safe), bedMarginTop: Math.max(cfg.bedMarginTop, safe),
  }
  const printHeight = cfg.printerPreset === 'custom'
    ? config.customPrintHeight - safe
    : getBambuPrinterPreset(cfg.printerPreset).printableHeight - safe
  const coords = layout.faces.flatMap(face => [
    faceToWorld(face, 0, 0, -cfg.thickness / 2),
    faceToWorld(face, 0, 0, cfg.thickness / 2),
    faceToWorld(face, face.width, 0, -cfg.thickness / 2),
    faceToWorld(face, face.width, 0, cfg.thickness / 2),
  ])
  const xs = coords.map(point => point[0]), zs = coords.map(point => point[2])
  let bendError: string | null = null
  let bendTrims: number[] = []
  let footprint = [{ x: Math.min(...xs), y: -Math.min(...zs) }, { x: Math.max(...xs), y: -Math.min(...zs) },
    { x: Math.max(...xs), y: -Math.max(...zs) }, { x: Math.min(...xs), y: -Math.max(...zs) }]
  if (layout.template !== 'flat') {
    try {
      const bend = createBentFootprint(layout, config)
      footprint = bend.polygons[0].map(([x, y]) => ({ x, y }))
      bendTrims = bend.trims
    }
    catch (error) { bendError = error instanceof Error ? error.message : String(error) }
  }
  const onePieceRotation = !bendError
    ? [0, 90].find(angle => findFootprintPlacement(rotatePlanarPoints(footprint, angle), printCfg)) ?? null : null
  const sectionCount = printHeight >= 20 ? Math.ceil(layout.faces[0].height / spatialHeightLimit(printHeight, cfg)) : 0
  const faceRotations = layout.faces.map(face => fitsBed(face.width, face.height, printCfg))
  const allFacesFit = faceRotations.every(rotation => rotation !== null)
  const mode: ResolvedSpatialMode = config.manufacturingMode === 'auto' || layout.template === 'cylinder'
    ? 'monolithic' : config.manufacturingMode
  const holeClearance = Math.max(cfg.slotWidth, cfg.jointDiameter) / 2 + cfg.holeBoundaryClearance
  const cornerHoleError = layout.template !== 'L' ? null
    : config.cornerHoleInsetMm + holeClearance > Math.min(config.width, config.depth) + 1e-6
    ? `转角孔列距离过大：两侧臂长至少需要 ${(config.cornerHoleInsetMm + holeClearance).toFixed(1)} mm`
    : mode === 'monolithic' && config.cornerHoleInsetMm < (bendTrims[0] ?? 0) + holeClearance - 1e-6
    ? `转角孔列距离过小：当前圆角至少需要 ${((bendTrims[0] ?? 0) + holeClearance).toFixed(1)} mm`
    : null
  const bounds = getPrintBedBounds(printCfg)
  const error = bounds.width < 40 || bounds.height < 40 || printHeight < 20
    ? '安全留边后可用打印空间不足，请调小留边或更换打印机'
    : mode !== 'monolithic' && config.printedAngleConnector && layout.faces.some(face => face.width < 55)
    ? '临时 M3 连接件需要至少 55 mm 臂长；短角请用一体折弯，或关闭临时连接件'
    : mode !== 'monolithic' && config.printedAngleConnector && printHeight < 30
    ? '定角连接件打印高度约 30 mm，当前自定义打印高度不足'
    : mode === 'monolithic' && bendError ? bendError
    : cornerHoleError ? cornerHoleError
    : mode === 'per-face' && !allFacesFit
      ? '至少一个侧面无法整片放进当前热床；请选择按热床切分'
      : null
  return { layout, mode, error, printHeight, sectionCount, printCfg, printBounds: bounds,
    needsBedSplit: mode === 'monolithic' && onePieceRotation === null }
}
