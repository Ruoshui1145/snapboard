import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { strToU8, zipSync, Zip, ZipDeflate, ZipPassThrough, AsyncZipDeflate } from 'fflate'
import type { BoardTextureConfig, Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import type { PartDefinition, PartLibraryIndex, PlacedPart } from '../partLibrary/types'
import { createSplitPanelShape, generateSplitPanelMesh, slotCapSegments } from './boardMesh'
import { extrudeLatticeFace, isPlainRetainedFront,clipLatticeTextureMeshes } from './latticeFaceMesh'
import { currentSvgFace } from './svgLattice'
import { sharedSvgStructureOnly } from './workshopSvgLattice'
import { applyPartParams, loadPrintablePartModel } from './glbLoader'
import { findFootprintPlacement, getEnabledKeepouts, getPrintBedBounds, polygonIntersectsRect } from './printBed.js'
import snapColorBambuConfigTemplate from '../assets/snapcolor-bambu-config-template.json?raw'
import { getBambuPrinterPreset } from './bambuPrinterPresets'
import { BAMBU_PROFILE_VERSION, Z_TOP_LAYER_HEIGHT_MM, Z_TOP_FINISH_DEPTH_MM, selectedBambuProjectTemplate, finalizeBambuProjectProfile, normalizeBambuFillPatterns, preparedOpticalPartSettings, applyPreparedOpticalProjectDefaults, PREPARED_OPTICAL_PATH_SETTINGS } from './bambuPrintProfile'
import { backBoardTexture, backTextureForRendering, createBoardTextureCanvas, createBoardTextureManufacturingData, createDefaultBoardTexture, getSplitPanelTextureBounds, hasBoardTextureSource, texturePanelsForSide } from './boardTexture'
import { computeManufacturingBudget, type ManufacturingBudget } from './manufacturingBudget'
import { markingShapes, createMarkingGeometry } from './markingShapes'
import { planTextureSamples, type TextureSample, type TextureSamplingOptions } from './textureSampling'
import { loadSnapColorLut, matchSnapColor, snapColorStackMaterial, type SnapColorLut, type SnapColorRgb } from './snapColorLut'
import { isTextureEdgeSealCell } from './textureEdgeSeal'
import { textureLayerDomains } from './textureManufacturingDomain'
import {textureLayerDepths,manufacturingHeightRanges,veneerLayerHeight} from './textureLayerDepths'
import type { MultiPolygon } from 'polygon-clipping'
import { texturePolygon as polygonClipping } from './texturePolygon'
import { type TextureContourDiagnostics } from './textureRegionContours'
import { extrudeTexturePartition } from './textureRegionExtrusion'
import { buildRasterTextureLayerResponsive } from './textureRasterLayer'
import { buildTextureVectorRegions, textureVectorBudgetError } from './textureVectorRegions'
import { engraveSideLogoMeshes, engraveSideTraceMeshes, engraveBackMarkMeshes, applyPanelNumberMeshes } from './sideLogo'
import { manufacturingCatalog, orderManufacturingCatalog } from './manufacturingCatalog'
import { orderSideEngravings, sideOrderNumberEngravings, orderTraceMetadata, validateOrderEngravingPlan, validateOrderPanel,
  type OrderEngravingPlan, type OrderEngravingInstance } from './orderEngraving'
import { createSnapBoardAttribution, serializeSnapBoardAttribution, type SnapBoardAttribution } from './snapboardAttribution'
import {
  assemblyMarkCavityPolygons,
  buildSurfaceMarkingPlan,
  isThroughLatticePanel,
  isBackEngravingEnabled,
  assemblyMarkPlanSignature,
  buildAssemblyMarkPlan,
  createDefaultAssemblyMarking,
  normalizeAssemblyMarking,
  pixelTextPolygons,
  placementFits,
  stablePanelIds,
  type AssemblyMarkingConfig,
  type AssemblyMarkPlan,
  type AssemblyPanelMarkPlan,
} from './assemblyMarking'

import { normalizeWoodGrain, normalizeWoodGrainTexture, woodGrainModifier, woodGrainPartSettings, woodGrainVeneerDepth, createWoodGrainPanelField } from './woodGrain'

interface PrintableMesh {
  name: string
  vertices: Array<[number, number, number]>
  triangles: Array<[number, number, number]>
}

interface LayoutPosition {
  x: number
  y: number
  rotation: number
}

/** Physical board edges/holes share one chord-error budget; SVG colour paths keep their own detail. */
export function manufacturingCurveSegments(cfg: SplitConfig): number {
  const maxSagittaMm = 0.025
  const divisions = (radius: number, sweepFactor: number) => radius > maxSagittaMm
    ? Math.ceil(Math.PI / (sweepFactor * Math.acos(1 - maxSagittaMm / radius))) : 1
  const holeRadius = Math.max(0.1, cfg.slotWidth / 2, cfg.jointDiameter / 2, cfg.cornerHoleDiameter / 2)
  return Math.min(128, Math.max(12, divisions(holeRadius, 2), divisions(Math.max(0, cfg.cornerRadius), 4)))
}

const number = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error('模型包含无效坐标')
  return String(Number(value.toFixed(6)))
}

const escapeXml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

/** 按热床宽度做简单货架排版；对象保持独立，切片软件仍可再次自动排版。 */
function layoutPanels(panels: SplitPanel[], bedW: number): LayoutPosition[] {
  const gap = 10
  const maxRowW = Math.max(1, bedW)
  let x = 0
  let y = 0
  let rowH = 0
  return panels.map(panel => {
    const rotation = ((panel.printRotation ?? 0) % 360 + 360) % 360
    const quarterTurn = rotation === 90 || rotation === 270
    const width = quarterTurn ? panel.h : panel.w
    const height = quarterTurn ? panel.w : panel.h
    if (x > 0 && x + width > maxRowW + 1e-6) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    const position = { x, y, rotation }
    x += width + gap
    rowH = Math.max(rowH, height)
    return position
  })
}

function rotateLocal(x: number, y: number, panel: SplitPanel, rotation: number): [number, number] {
  if (rotation === 90) return [y, panel.w - x]
  if (rotation === 180) return [panel.w - x, panel.h - y]
  if (rotation === 270) return [panel.h - y, x]
  if (rotation !== 0) {
    const angle = rotation * Math.PI / 180
    return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]
  }
  return [x, y]
}

/** 将一个板件 Object3D 压成仅含位置和索引的制造网格。 */
function collectPanelMesh(root: THREE.Object3D, panel: SplitPanel, layout: LayoutPosition): PrintableMesh {
  const vertices: Array<[number, number, number]> = []
  const triangles: Array<[number, number, number]> = []
  root.updateMatrixWorld(true)

  root.traverse(object => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry>
    if (!mesh.isMesh || object.userData.previewOnly || !mesh.geometry?.getAttribute('position')) return

    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(mesh.matrixWorld)
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position') geometry.deleteAttribute(name)
    }
    geometry.morphAttributes = {}
    const indexed = mergeVertices(geometry, 1e-5)
    const position = indexed.getAttribute('position') as THREE.BufferAttribute
    const base = vertices.length
    for (let i = 0; i < position.count; i++) {
      const localX = position.getX(i) - panel.x
      const localY = position.getY(i) - panel.y
      const [rx, ry] = rotateLocal(localX, localY, panel, layout.rotation)
      vertices.push([rx + layout.x, ry + layout.y, position.getZ(i)])
    }

    const index = indexed.getIndex()
    const count = index?.count ?? position.count
    for (let i = 0; i + 2 < count; i += 3) {
      const a = base + (index ? index.getX(i) : i)
      const b = base + (index ? index.getX(i + 1) : i + 1)
      const c = base + (index ? index.getX(i + 2) : i + 2)
      if (a !== b && b !== c && a !== c) triangles.push([a, b, c])
    }
    geometry.dispose()
    indexed.dispose()
  })

  if (!vertices.length || !triangles.length) throw new Error(`${panel.id.toUpperCase()} 没有可导出的实体网格`)
  validateClosedMesh(panel.id.toUpperCase(), triangles)
  return { name: panel.id.toUpperCase(), vertices, triangles }
}

/** 每条无向边必须恰好被两个三角形共享，防止把开放渲染面写入制造文件。 */
function validateClosedMesh(name: string, triangles: Array<[number, number, number]>): void {
  const edges = new Map<string, number>()
  const add = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  for (const [a, b, c] of triangles) {
    add(a, b)
    add(b, c)
    add(c, a)
  }
  const invalid = [...edges.values()].filter(count => count !== 2).length
  if (invalid) throw new Error(`${name} 网格未完全封闭（${invalid} 条异常边），已阻止导出`)
}

function isMeshClosureError(error: unknown): boolean {
  return error instanceof Error && /网格未完全封闭（\d+ 条异常边）/.test(error.message)
}

function chamferCandidates(requested: number): number[] {
  if (requested <= 0.001) return [0]
  const candidates = [requested, requested / 2, requested / 4, 0]
  return candidates.filter((value, index) => candidates.findIndex(other => Math.abs(other - value) < 1e-6) === index)
}

function pushUniqueWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message)
}

function modelXml(meshes: PrintableMesh[], attribution: SnapBoardAttribution): string {
  const objects = meshes.map((mesh, index) => `
    <object id="${index + 1}" type="model" name="${escapeXml(mesh.name)}">
      <mesh>
        <vertices>${mesh.vertices.map(([x, y, z]) => `
          <vertex x="${number(x)}" y="${number(y)}" z="${number(z)}"/>`).join('')}
        </vertices>
        <triangles>${mesh.triangles.map(([v1, v2, v3]) => `
          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`).join('')}
        </triangles>
      </mesh>
    </object>`).join('')
  const build = meshes.map((_, index) => `
    <item objectid="${index + 1}"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">SnapBoard 分割板件</metadata>
  <metadata name="Application">SnapBoard</metadata>
  <metadata name="Generator">SnapBoard</metadata>
  <metadata name="SnapBoard:Attribution">${escapeXml(attribution.attributionText)}</metadata>
  <metadata name="SnapBoard:PublicationNotice">${escapeXml(attribution.publicationNotice)}</metadata>
  <metadata name="SnapBoard:AttributionRequired">true</metadata>
  <metadata name="SnapBoard:Schema">${escapeXml(attribution.schema)}</metadata>
  <metadata name="SnapBoard:Version">${escapeXml(attribution.generatorVersion)}</metadata>
  <metadata name="SnapBoard:SourceRecordId">${escapeXml(attribution.sourceRecordId)}</metadata>
  <metadata name="SnapBoard:OriginUrl">${escapeXml(attribution.originUrl)}</metadata>
  <metadata name="SnapBoard:Authenticity">${attribution.authenticity}</metadata>
  <resources>${objects}
  </resources>
  <build>${build}
  </build>
</model>`
}

/** 生成标准 OPC/3MF 文件；每块分割板是一个独立可打印对象。 */
export function createSplitPanels3MF(
  panels: SplitPanel[],
  cfg: SplitConfig,
  projectName = 'SnapBoard',
  projectVersion = '0.0.0',
): Uint8Array {
  if (!panels.length) throw new Error('没有可导出的分割板件')
  const attribution = createSnapBoardAttribution({ projectName, projectVersion })
  const layouts = layoutPanels(panels, cfg.bedW)
  const meshes = panels.map((panel, index) => {
    const root = generateSplitPanelMesh({
      panel,
      cfg,
      color: 0x3ec6b0,
      curveSegments: manufacturingCurveSegments(cfg),
      slotCapSegments: slotCapSegments(cfg.slotWidth),
      includeGuides: false,
      manufacturingChamfer: cfg.manufacturingChamfer,
    })
    try {
      return collectPanelMesh(root, panel, layouts[index])
    } finally {
      root.traverse(object => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach(item => item.dispose())
        else material?.dispose()
      })
    }
  })

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="json" ContentType="application/json"/>
</Types>`
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    '3D/3dmodel.model': strToU8(modelXml(meshes, attribution)),
    'Metadata/snapboard-attribution.json': strToU8(serializeSnapBoardAttribution(attribution)),
  }, { level: 6 })
}

export function downloadSplitPanels3MF(
  panels: SplitPanel[],
  cfg: SplitConfig,
  projectName = 'SnapBoard',
  projectVersion = '0.0.0',
): void {
  const data = createSplitPanels3MF(panels, cfg, projectName, projectVersion)
  const blob = new Blob([data as BlobPart], { type: 'model/3mf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, '')
  const withoutControls = [...projectName.trim()].map(char => char.charCodeAt(0) < 32 ? '-' : char).join('')
  const safeName = withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '') || 'SnapBoard'
  link.href = url
  link.download = `${safeName}-${stamp}.3mf`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface ManufacturingObject {
  key: string
  name: string
  mesh: PrintableMesh
  parts: ManufacturingPart[]
  preferredRotation: number
  quantity: number
  kind: 'panel' | 'part' | 'sample'
  /** Explicit manufacturing process group; different groups never share a bed. */
  printGroup?: string
  printGroupName?: string
  backMarkingApplied?: boolean
  sideLogoEngraved?: boolean
  numberLocation?: 'back'|'side'|'pocket'
  sourcePanel?: SplitPanel
  numberId?: string
  /** Applied physical print orientation, independent of design-space back coordinates. */
  frontOnBed?: boolean
  /** Defaults on the editable parent object, rather than repeated volume overrides. */
  settings?: Record<string, string>
}

export interface ManufacturingPart {
  name: string
  mesh: PrintableMesh
  modelPath?: string
  extruder: number
  color: string
  /** Bambu Studio 的 part 级参数覆盖；用于把结构基材与 SnapColor/贴面层分开切片。 */
  settings?: Record<string, string>
  /** Kept after a streamed mesh has been released. */
  faceCount?: number
  /** Print-space Z bounds retained after streamed geometry is released. */
  printZ?: [number, number]
  subtype?: 'normal_part' | 'modifier_part'
  transform?: number[]
  sharedGeometryKey?: string
}

async function applyPhysicalNumber(parts:ManufacturingPart[],panel:SplitPanel,cfg:SplitConfig,plan:AssemblyPanelMarkPlan|undefined,config:AssemblyMarkingConfig,warnings:string[]) {
  if(!plan?.numberMark)return undefined
  try {
    const applied=await applyPanelNumberMeshes(parts.filter(p=>p.subtype!=='modifier_part').map(p=>p.mesh),panel,cfg,plan,config)
    if(!applied){warnings.push(`${plan.panelId} 编号未写入实体，请检查可用表面。`);return undefined}
    return plan.numberMark.surface
  }catch(error){warnings.push(`${plan.panelId} 编号制造失败：${error instanceof Error?error.message:String(error)}`);return undefined}
}

interface PackedInstance {
  objectKey: string
  objectId: number
  instanceId: number
  identifyId: number
  name: string
  plate: number
  rotation: number
  x: number
  y: number
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number }
}

interface BuildPlate {
  index: number
  kind: 'panel' | 'part' | 'sample'
  printGroup?: string
  name?: string
  instances: PackedInstance[]
}

export interface Manufacturing3MFSummary {
  data: Uint8Array
  /** Large exports spill the final ZIP to OPFS instead of retaining it in JS heap. */
  streamedFile?: File
  cleanup?: () => Promise<void>
  plateCount: number
  panelCount: number
  partCount: number
  sampleCount: number
  samplePlateCount: number
  uniqueObjectCount: number
  markingRequestedCount: number
  markingAppliedCount: number
  numbering?: { requested:number; applied:number; back:number; side:number; pocket:number; missing:string[] }
  warnings: string[]
  /** Per-panel browser fallback delivers a ZIP, while ordinary exports deliver 3MF. */
  fileName?: string
}

export interface Manufacturing3MFInput {
  /** Local-service reservation only; not a manufacturing parameter or cloud design payload. */
  exportQuotaTicket?: string
  panels: SplitPanel[]
  cfg: SplitConfig
  placedParts: PlacedPart[]
  projectName?: string
  projectVersion?: string
  partDefinitions?: PartDefinition[]
  boardTexture?: BoardTextureConfig
  /** Internal native-manufacturing input: one immutable, top-down recipe grid. */
  nativeRecipeRaster?: { width: number; height: number; pitchMm: number; recipeIds: Uint16Array }
  /**
   * 分板导出时传入**整单**纹理范围。方案 §3.1 要求全工程共用一个制造间距、所有板件从
   * 同一世界原点取样；逐板调用导出时必须显式带上它，否则每块板会各自按自身面积重算间距，
   * 跨板颜色与接缝就会因独立取整错位。
   */
  textureBounds?: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
  /** 输出方式：单个 3MF（默认）或每块板一个 3MF 再打包。 */
  outputMode?: 'single' | 'perPanel'
  /** Internal browser fallback: keep every board on the same texture sample grid. */
  sharedTextureContext?: TextureManufacturingContext
  /** Per-panel export reuses the independent back solve as well. */
  sharedBackTextureContext?: TextureManufacturingContext
  /** 板件背面永久凹刻；缺省时保持旧版无标识制造行为。 */
  assemblyMarking?: AssemblyMarkingConfig
  /** Frozen, production-only order trace; complete exports manufacture every numbered physical board. */
  orderEngraving?: OrderEngravingPlan
  /** Internal per-instance export. Never reuse this number for another physical board. */
  orderInstance?: OrderEngravingInstance
  /**
   * 逐板导出时传入**整单**板件集合，仅用于计算背面装配标识（板号与 J 接缝箭头都依赖
   * 全单邻接关系）；实际制造的仍是 panels 里的板。缺省时退回按 panels 计算——
   * 逐板调用若不传它，每块板都会被刻成 P01 且完全没有接缝标识。
   */
  markingPanels?: SplitPanel[]
  /** Original-scale color/veneer + backing coupons, without the structural base. */
  textureSampling?: TextureSamplingOptions
  signal?: AbortSignal
  onProgress?(message: string, progress?: number): void
}

function throwIfExportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('3MF 导出已取消', 'AbortError')
}

const round6 = (value: number): number => Number(value.toFixed(6))
const relativePoints = (points: Array<{ x: number; y: number }> | undefined, panel: SplitPanel) =>
  points?.map(point => [round6(point.x - panel.x), round6(point.y - panel.y)])
const relativeHoles = (points: Array<{ x: number; y: number; knocked?: boolean }> | undefined, panel: SplitPanel) =>
  points?.map(point => [round6(point.x - panel.x), round6(point.y - panel.y), Boolean(point.knocked)])

/** 只把真正影响制造网格的字段写入签名，相同板件会复用一个 3MF object。 */
function panelSignature(panel: SplitPanel, cfg: SplitConfig): string {
  return JSON.stringify({
    w: round6(panel.w), h: round6(panel.h),
    contour: relativePoints(panel.contour, panel),
    roundIdx: panel.roundIdx ?? [],
    slots: relativeHoles(panel.slots, panel),
    round: relativeHoles(panel.round_holes, panel),
    edge: relativeHoles(panel.edge_holes, panel),
    cutouts: panel.cutouts?.map(hole => relativePoints(hole, panel)),
    latticeCutouts: panel.latticeCutouts?.map(hole => relativePoints(hole, panel)),
    latticeFace: panel.latticeFace && { ...panel.latticeFace, layers: panel.latticeFace.layers.map(layer => ({
      ...layer, polygons: layer.polygons.map(polygon => polygon.map(ring => relativePoints(ring, panel))),
    })) },
    outerCorners: panel.outerCorners,
    cfg: {
      thickness: cfg.thickness,
      slotLength: cfg.slotLength,
      slotWidth: cfg.slotWidth,
      jointDiameter: cfg.jointDiameter,
      cornerRadius: cfg.cornerRadius,
      gapTolerance: cfg.gapTolerance,
    },
  })
}

interface TextureContourReport {
  panelId: string
  layer: number
  route: 'svg-paths' | 'shared-contours' | 'legacy-grid-fallback'
  vertices?: number
  triangles?: number
  reason?: string
  diagnostics?: TextureContourDiagnostics
}

interface TextureManufacturingContext {
  config: BoardTextureConfig
  canvas: { width: number; height: number }
  pixels: Uint8ClampedArray
  recipeIds: Uint16Array | null
  lut: SnapColorLut
  colors: string[]
  bounds: ReturnType<typeof getSplitPanelTextureBounds>
  structuralThickness: number
  textureThickness: number
  opticalStart: number
  samplePitch: number
  budget: ManufacturingBudget
  /** 矢量区域构建耗时；它决定浏览器导出是否被 SVG 布尔拖住。 */
  vectorRegionsMs: number
  recipeCache: Map<number, number>
  contourEdgeBudget?: number
  vectorRegions: Awaited<ReturnType<typeof buildTextureVectorRegions>> | null
  contourReports: TextureContourReport[]
  viewedFromBack?: boolean
}

async function createTextureManufacturingContext(input: Manufacturing3MFInput): Promise<TextureManufacturingContext | null> {
  if (input.boardTexture?.enabled && input.boardTexture.surfaceMode === 'woodgrain') return null
  if (input.sharedTextureContext) return { ...input.sharedTextureContext, contourReports: [] }
  throwIfExportAborted(input.signal)
  if (!input.boardTexture?.enabled || !input.panels.length) return null
  if (!hasBoardTextureSource(input.boardTexture)) throw new Error('请先添加图片或图案，或关闭纹理后导出普通板件')
  const config = { ...createDefaultBoardTexture(), ...input.boardTexture }
  // Check before Canvas/SVGLoader/booleans, for every entry (single, per-panel, streamed, samples and back face).
  const budgetError = !input.nativeRecipeRaster && textureVectorBudgetError(config)
  if (budgetError) throw new Error(budgetError)
  const bounds = input.textureBounds ?? getSplitPanelTextureBounds(input.panels)
  const native = input.nativeRecipeRaster
  if (native && (!Number.isInteger(native.width) || !Number.isInteger(native.height)
    || native.width < 2 || native.height < 2 || native.width * native.height > 80_000_000
    || native.recipeIds.length !== native.width * native.height || !Number.isFinite(native.pitchMm)
    // 间距下限是"比喷嘴线宽更密没有意义"，上限是纹理范围的短边（再大就连两个样点都放不下）。
    // 不能写死 0.5：阶段 A 的动态 PPI 在大工程上本来就大于 0.5mm。
    || native.pitchMm < 0.05 || native.pitchMm > Math.min(bounds.width, bounds.height)
    || Math.abs((native.width - 1) * native.pitchMm - bounds.width) > native.pitchMm
    || Math.abs((native.height - 1) * native.pitchMm - bounds.height) > native.pitchMm)) {
    throw new Error('原生制造配方网格的尺寸或间距与板件范围不符')
  }
  // 方案 §3.1：全工程共用一个制造间距，由当前线宽、整单面积、单热床面积与最长边共同决定。
  // 采样比线宽更密只会产生印不出来的格点，所以线宽是下限而不是另一个可选精度。
  const budget = computeManufacturingBudget({
    panels: input.panels,
    artAreaMm2: bounds.width * bounds.height,
    lineWidthMm: configuredLineWidthMm(),
    detail: config.samplingDetail,
  })
  if (!budget) return null
  const samplePitch = native?.pitchMm ?? (config.modelingMode === 'pixel'
    ? Math.max(0.4, config.pixelSize)
    : budget.pitchMm)
  const manufacturing = !native && config.manufacturingEdgeQuality === 'fine' && config.modelingMode !== 'pixel'
    ? await createBoardTextureManufacturingData(config, input.panels, samplePitch) : null
  throwIfExportAborted(input.signal)
  const canvas = native ? { width: native.width, height: native.height }
    : manufacturing?.canvas ?? await createBoardTextureCanvas(config, bounds.width / bounds.height, input.panels)
  throwIfExportAborted(input.signal)
  const ctx = native ? null : (canvas as HTMLCanvasElement | null)?.getContext('2d', { willReadFrequently: true })
  if (!canvas || (!native && !ctx)) return null
  const lut = await loadSnapColorLut(config.lutId)
  if (native && native.recipeIds.some(recipe => recipe >= lut.colorCount)) throw new Error('原生制造配方网格包含无效叠色配方')
  const {textureThickness,structuralThickness,opticalStart}=textureLayerDepths(config,input.cfg.thickness,lut)
  const vectorRegionsStarted = performance.now()
  const vectorRegions = !native && config.modelingMode === 'vector' && config.manufacturingContours !== false
    ? await buildTextureVectorRegions(config, bounds, input.panels) : null
  const vectorRegionsMs = performance.now() - vectorRegionsStarted
  return {
    config,
    canvas,
    pixels: native || manufacturing?.recipeIds ? new Uint8ClampedArray(0) : ctx!.getImageData(0, 0, canvas.width, canvas.height).data,
    recipeIds: native?.recipeIds ?? manufacturing?.recipeIds ?? null,
    lut,
    colors: lut.materials.map(material => material.color),
    bounds,
    structuralThickness,
    textureThickness,
    opticalStart,
    samplePitch,
    budget,
    vectorRegionsMs,
    recipeCache: new Map(),
    contourEdgeBudget: native ? 2_000_000 : undefined,
    vectorRegions,
    contourReports: [],
  }
}

async function createBackTextureManufacturingContext(input: Manufacturing3MFInput): Promise<TextureManufacturingContext | null> {
  const config = input.boardTexture
  if (!config?.enabled || !config.backEnabled) return null
  if (!config.enabled || !hasBoardTextureSource(config) || !backBoardTexture(config)) throw new Error('双面映射缺少正面或背面图片，请先在纹理工作室补齐')
  if (config.surfaceMode !== 'snapcolor') throw new Error('双面映射目前只支持 SnapColor 彩印')
  const back = backTextureForRendering(config, input.markingPanels ?? input.panels, input.cfg, input.assemblyMarking ?? createDefaultAssemblyMarking(), input.projectName)!
  const context = await createTextureManufacturingContext({ ...input,
    boardTexture: back, panels: texturePanelsForSide(input.panels, 'back'), nativeRecipeRaster: undefined,
    sharedTextureContext: input.sharedBackTextureContext })
  if (!context) throw new Error('背面图片无法生成制造纹理')
  if (!context.viewedFromBack && context.vectorRegions?.eligible) {
    const mirrorX = context.bounds.minX + context.bounds.maxX
    context.vectorRegions = { ...context.vectorRegions, regions: context.vectorRegions.regions.map(region => ({
      ...region, polygons: region.polygons.map(polygon => polygon.map(ring => ring.map(([x, y]) => [mirrorX - x, y] as [number, number]).reverse())),
    })) }
  }
  context.viewedFromBack = true
  return context
}

interface PanelMaterialProfile {
  outer: Point2D[]
  holes: Point2D[][]
}

function panelMaterialProfile(panel: SplitPanel, cfg: SplitConfig): PanelMaterialProfile {
  const points = createSplitPanelShape(panel, cfg, slotCapSegments(cfg.slotWidth)).extractPoints(manufacturingCurveSegments(cfg))
  return {
    outer: points.shape.map(point => ({ x: point.x, y: point.y })),
    holes: points.holes.map(hole => hole.map(point => ({ x: point.x, y: point.y }))),
  }
}

interface PanelMaterialRaster {
  width: number
  height: number
  mask: Uint8Array
  /** 3/4 chamfer distance，3 个单位约等于一个正交网格。 */
  distance: Uint16Array
}

function panelMaterialRaster(
  profile: PanelMaterialProfile,
  width: number,
  height: number,
  originX: number,
  originY: number,
  cell: number,
): PanelMaterialRaster {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建板件制造掩膜')
  const trace = (ring: Point2D[]) => {
    if (!ring.length) return
    ctx.moveTo((ring[0].x - originX) / cell, (ring[0].y - originY) / cell)
    for (let index = 1; index < ring.length; index++) ctx.lineTo((ring[index].x - originX) / cell, (ring[index].y - originY) / cell)
    ctx.closePath()
  }
  ctx.beginPath()
  trace(profile.outer)
  for (const hole of profile.holes) trace(hole)
  ctx.fillStyle = '#fff'
  ctx.fill('evenodd')
  const rgba = ctx.getImageData(0, 0, width, height).data
  const mask = new Uint8Array(width * height)
  for (let index = 0; index < mask.length; index++) mask[index] = rgba[index * 4 + 3] >= 128 ? 1 : 0

  // 一次性计算到最近孔壁/外缘的距离，五个光学层直接查表，不再逐格遍历所有孔。
  const stride = width + 2
  const padded = new Uint16Array((height + 2) * stride)
  const INF = 30_000
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (mask[y * width + x]) padded[(y + 1) * stride + x + 1] = INF
  }
  for (let y = 1; y <= height; y++) for (let x = 1; x <= width; x++) {
    const index = y * stride + x
    if (!padded[index]) continue
    padded[index] = Math.min(padded[index], padded[index - 1] + 3, padded[index - stride] + 3,
      padded[index - stride - 1] + 4, padded[index - stride + 1] + 4)
  }
  for (let y = height; y >= 1; y--) for (let x = width; x >= 1; x--) {
    const index = y * stride + x
    if (!padded[index]) continue
    padded[index] = Math.min(padded[index], padded[index + 1] + 3, padded[index + stride] + 3,
      padded[index + stride - 1] + 4, padded[index + stride + 1] + 4)
  }
  const distance = new Uint16Array(mask.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) distance[y * width + x] = padded[(y + 1) * stride + x + 1]
  return { width, height, mask, distance }
}

const yieldExportThread = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function appendBox(mesh: PrintableMesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  const base = mesh.vertices.length
  mesh.vertices.push(
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  )
  const faces: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  mesh.triangles.push(...faces.map(([a, b, c]) => [base + a, base + b, base + c] as [number, number, number]))
}

function appendPrintableMesh(target: PrintableMesh, source: PrintableMesh): void {
  const base = target.vertices.length
  // 不能使用 push(...巨大数组)：真实洞洞板可能有几十万顶点，会超过 JS 参数栈上限。
  for (const vertex of source.vertices) target.vertices.push(vertex)
  for (const [a, b, c] of source.triangles) target.triangles.push([base + a, base + b, base + c])
}

/** Bulk PETG process, separate from the thin optical-layer settings below. */
const BULK_PETG_PRINT_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  outer_wall_line_width: '0.42',
  inner_wall_line_width: '0.42',
  top_surface_line_width: '0.42',
  sparse_infill_line_width: '0.8',
  internal_solid_infill_line_width: '0.8',
  outer_wall_speed: '80',
  inner_wall_speed: '140',
  sparse_infill_speed: '270',
  internal_solid_infill_speed: '250',
  top_surface_speed: '80',
  small_perimeter_speed: '50%',
  small_perimeter_threshold: '0',
  enable_overhang_speed: '1',
})

function structuralPartSettings(config: BoardTextureConfig): Record<string, string> {
  const supportedBottom=config.enabled && config.surfaceFinish==='textured-pei'
  return {
    ...BULK_PETG_PRINT_SETTINGS,
    layer_height: '0.28',
    wall_loops: '2',
    top_shell_layers: config.enabled ? '4' : '3',
    bottom_shell_layers: supportedBottom ? '0' : '3',
    top_shell_thickness: '0.6',
    bottom_shell_thickness: supportedBottom ? '0' : '0.6',
    sparse_infill_density: `${Math.round(config.baseInfillDensity)}%`,
    sparse_infill_pattern: Math.round(config.baseInfillDensity) === 100 ? 'zig-zag' : 'gyroid',
    fuzzy_skin: 'none',
  }
}

function backingPartSettings(bulkPreset = true): Record<string, string> {
  return {
    ...(bulkPreset ? BULK_PETG_PRINT_SETTINGS : {}),
    // Buried carrier skins do not need the fine exposed-face top-surface path.
    ...(bulkPreset ? { top_surface_line_width:'0.8', top_surface_speed:'180' } : {}),
    layer_height: '0.28',
    wall_loops: '2',
    top_shell_layers: '3',
    bottom_shell_layers: '3',
    top_shell_thickness: '0.6',
    bottom_shell_thickness: '0.6',
    sparse_infill_density: '100%',
    sparse_infill_pattern: 'zig-zag',
    fuzzy_skin: 'none',
  }
}

function latticeCoreSettings(panel:SplitPanel,config:BoardTextureConfig):Record<string,string>{
  if(!panel.latticeFace&&!panel.latticeCutouts?.length)return structuralPartSettings(config)
  const open=panel.latticeOptions?.openCoreCaps===true
  return {...structuralPartSettings(config),top_shell_layers:open?'0':'3',top_shell_thickness:open?'0':'0.6',
    bottom_shell_layers:open||panel.latticeFace?'0':'3',bottom_shell_thickness:open||panel.latticeFace?'0':'0.6',
    ...(panel.latticeFace?.source?.templateStyle==='ribs'?{wall_loops:'3',sparse_infill_density:'100%',sparse_infill_pattern:'zig-zag',wall_generator:'arachne',bottom_shell_layers:'1',bottom_shell_thickness:'0'}:{})}
}

function veneerPrintProfile(config: BoardTextureConfig) {
  const goal = config.surfaceMaterialKind === 'transparent-petg' ? config.surfacePrintGoal : 'standard'
  const overrides = config.surfacePrintOverrides ?? {}
  for (const [key, min, max] of [
    ['nozzleTempC', 220, 270], ['flowRatio', 0.85, 1.15], ['maxFlowMm3s', 3, 30], ['fanPercent', 0, 100],
  ] as const) {
    const value = overrides[key]
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) throw new Error(`贴面料卷 ${key} 超出 ${min}–${max}，请检查高级校准值`)
  }
  return {
    goal,
    layerHeight: veneerLayerHeight(config),
    speed: goal === 'clear-experimental' ? 40 : goal === 'frosted' ? 70 : undefined,
    nozzleTempC: overrides.nozzleTempC ?? 245,
    flowRatio: overrides.flowRatio ?? 0.95,
    maxFlowMm3s: overrides.maxFlowMm3s ?? (goal === 'standard' ? 21 : 15),
    fanPercent: overrides.fanPercent ?? (goal === 'clear-experimental' ? 0 : goal === 'frosted' ? 20 : undefined),
    vendor: config.surfaceFilamentVendor?.trim() || 'Generic',
  }
}

function veneerPartSettings(config: BoardTextureConfig): Record<string, string> {
  const base = backingPartSettings(false)
  const profile = veneerPrintProfile(config)
  if (profile.goal === 'standard') return base
  return {
    ...base,
    layer_height: String(profile.layerHeight),
    sparse_infill_pattern: 'alignedrectilinear',
    outer_wall_line_width: '0.5',
    inner_wall_line_width: '0.5',
    sparse_infill_line_width: '0.5',
    internal_solid_infill_line_width: '0.5',
    outer_wall_speed: String(profile.speed),
    inner_wall_speed: String(profile.speed),
    sparse_infill_speed: String(profile.speed),
    internal_solid_infill_speed: String(profile.speed),
    top_surface_speed: String(profile.speed),
  }
}

function surfacePartSettings(layerHeight = 0.08): Record<string, string> {
  return {
    layer_height: String(round6(layerHeight)),
    wall_loops: '1',
    top_shell_layers: '0',
    // One contact skin lets Bambu classify bed-facing solid fill as BottomSurface.
    // With zero bottom skins, first-layer internal fill falls back to wall speed.
    bottom_shell_layers: '1',
    bottom_shell_thickness: '0',
    sparse_infill_density: '100%',
    sparse_infill_pattern: 'zig-zag',
    outer_wall_speed: '60',
    inner_wall_speed: '100',
    sparse_infill_speed: '140',
    internal_solid_infill_speed: '140',
    gap_infill_speed: '80',
    top_surface_speed: '100',
    fuzzy_skin: 'none',
  }
}

function translatePrintableMeshZ(mesh: PrintableMesh, delta: number): PrintableMesh {
  for (const vertex of mesh.vertices) vertex[2] += delta
  return mesh
}

/**
 * 复合板分层只在最外侧表面倒角，基材/贴面的内部拼接面保持平直。
 * 基材调用 bottom，质感贴面调用 top；组合后得到上下对称的外缘和孔口倒角。
 */
function createOneSidedBeveledLayer(
  panel: SplitPanel,
  cfg: SplitConfig,
  zOffset: number,
  depth: number,
  side: 'bottom' | 'top',
  name: string,
  warnings: string[] = [],
): PrintableMesh {
  const requested = Math.max(0, Math.min(cfg.manufacturingChamfer, depth / 3, cfg.slotWidth / 4))
  let lastClosureError: unknown = null
  for (const chamfer of chamferCandidates(requested)) {
    if (chamfer <= 0.001) {
      const prism = createPanelPrismMesh(panel, cfg, zOffset, depth, name)
      if (requested > 0.001) pushUniqueWarning(
        warnings,
        `${panel.id.toUpperCase()} 含尖角/窄边，${requested.toFixed(2)}mm 制造倒角会产生开口网格；已仅对该板关闭倒角`,
      )
      return prism
    }

    const bevelRoot = generateSplitPanelMesh({
      panel,
      cfg: { ...cfg, thickness: depth },
      color: 0x3ec6b0,
      curveSegments: manufacturingCurveSegments(cfg),
      slotCapSegments: slotCapSegments(cfg.slotWidth),
      includeGuides: false,
      manufacturingChamfer: chamfer,
      manufacturingBevelSide: side,
    })
    try {
      const result = translatePrintableMeshZ(collectPanelMesh(bevelRoot, panel, { x: 0, y: 0, rotation: 0 }), zOffset)
      result.name = name
      validateClosedMesh(result.name, result.triangles)
      if (chamfer < requested - 1e-6) pushUniqueWarning(
        warnings,
        `${panel.id.toUpperCase()} 含尖角/窄边，制造倒角已从 ${requested.toFixed(2)}mm 自动降至 ${chamfer.toFixed(2)}mm 以保持网格封闭`,
      )
      return result
    } catch (error) {
      if (!isMeshClosureError(error)) throw error
      lastClosureError = error
    } finally {
      disposeObject(bevelRoot)
    }
  }
  throw lastClosureError instanceof Error ? lastClosureError : new Error(`${panel.id.toUpperCase()} 无法生成封闭制造网格`)
}

function createBottomBeveledBase(
  panel: SplitPanel,
  cfg: SplitConfig,
  structuralThickness: number,
  warnings: string[],
): PrintableMesh {
  return createOneSidedBeveledLayer(panel, cfg, 0, structuralThickness, 'bottom', `${panel.id}-structural-base`, warnings)
}

function flipCompositePanelFaceDown(parts: ManufacturingPart[], totalThickness: number, panelWidth: number): void {
  for (const part of parts) {
    // A physical half-turn about Y reverses X and Z together (determinant +1).
    // Reflecting only Z mirrors the image and leaves back-side lettering reversed.
    for (const vertex of part.mesh.vertices) {
      vertex[0] = round6(panelWidth - vertex[0])
      vertex[2] = round6(totalThickness - vertex[2])
    }
  }
}

/** Copy the existing front thin layer to the opposite side without moving any outline or hole. */
function mirrorThinLayerToBack(parts: ManufacturingPart[], totalThickness: number): void {
  for (const part of parts) {
    for (const vertex of part.mesh.vertices) vertex[2] = round6(totalThickness - vertex[2])
    for (const triangle of part.mesh.triangles) [triangle[1], triangle[2]] = [triangle[2], triangle[1]]
  }
}

function textureRecipeAt(x: number, y: number, context: TextureManufacturingContext): number {
  const u = (x - context.bounds.minX) / context.bounds.width
  const v = (y - context.bounds.minY) / context.bounds.height
  const px = Math.max(0, Math.min(context.canvas.width - 1, Math.round((context.viewedFromBack ? 1 - u : u) * (context.canvas.width - 1))))
  const py = Math.max(0, Math.min(context.canvas.height - 1, Math.round((1 - v) * (context.canvas.height - 1))))
  if (context.recipeIds) return context.recipeIds[py * context.canvas.width + px]
  const offset = (py * context.canvas.width + px) * 4
  const color: SnapColorRgb = [context.pixels[offset], context.pixels[offset + 1], context.pixels[offset + 2]]
  const key = (color[0] << 16) | (color[1] << 8) | color[2]
  const cached = context.recipeCache.get(key)
  if (cached !== undefined) return cached
  const recipe = matchSnapColor(color, context.lut, context.config.hueWeight)
  context.recipeCache.set(key, recipe)
  return recipe
}

function createPanelPrismMesh(
  panel: SplitPanel,
  cfg: SplitConfig,
  zOffset: number,
  depth: number,
  name: string,
  blindEngraving: Point2D[][] = [],
): PrintableMesh {
  const root = generateSplitPanelMesh({
    panel,
    cfg: { ...cfg, thickness: depth },
    color: 0x3ec6b0,
    curveSegments: manufacturingCurveSegments(cfg),
    slotCapSegments: slotCapSegments(cfg.slotWidth),
    includeGuides: false,
    manufacturingChamfer: 0,
    blindEngraving,
  })
  root.position.z = zOffset
  try {
    const mesh = collectPanelMesh(root, panel, { x: 0, y: 0, rotation: 0 })
    mesh.name = name
    return mesh
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    disposeObject(root)
  }
}

/**
 * 在原始倒角板体上减去凹框背景，字形与原表面齐平；不填回孔口倒角。
 * 坐标仍在设计背面，后续将整块普通板旋转为正面贴床、背面朝上。
 */
async function createBackEngravedBase(
  panel: SplitPanel, cfg: SplitConfig, totalThickness: number, config: AssemblyMarkingConfig,
  plan: AssemblyPanelMarkPlan, warnings: string[], keepTopChamfer: boolean,
): Promise<PrintableMesh> {
  const normalized = normalizeAssemblyMarking(config)
  const depth = Math.max(.12, Math.min(normalized.depth, totalThickness * .22, totalThickness - .12))
  const base = keepTopChamfer
    ? createAdaptiveChamferPanelMesh(panel, { ...cfg, thickness: totalThickness }, warnings)
    : createBottomBeveledBase(panel, cfg, totalThickness, warnings)
  if (!plan.engravingPolygons.length || totalThickness <= depth + .1) return base
  // Preserve the recessed-frame/flush-letter appearance, but subtract it from
  // the original chamfered body instead of rebuilding its bottom as a prism.
  const rings = (points: Array<{x:number;y:number}>) => {
    const ring = points.map(p => [p.x, p.y] as [number,number]); ring.push(ring[0]); return ring
  }
  const glyphs: MultiPolygon = markingShapes(plan.engravingPolygons).map(shape => {
    const points = shape.extractPoints(16); return [rings(points.shape), ...points.holes.map(rings)]
  })
  const frames: MultiPolygon = assemblyMarkCavityPolygons(plan).map(ring => [rings(ring)])
  const background = polygonClipping.difference(frames, glyphs)
    .flatMap(polygon => polygon.map(ring => ring.slice(0,-1).map(([x,y]) => ({x,y}))))
  // Recess frames may meet a pre-existing hole/bevel; clip their background
  // to the original body. Glyphs themselves remain uncut, with no fill added.
  if (!await engraveBackMarkMeshes([base],panel,background,depth))
    throw new Error(`${plan.panelId} 背面装配凹刻没有形成完整减材`)
  base.name = `${panel.id}-back-engraved-base`
  return base
}

/** 齐平填回凹框的字形/箭头；各图元是独立闭合体，不参与多孔 earcut。 */
function createGlyphReliefMesh(panel: SplitPanel, polygons: Point2D[][], depth: number, name: string): PrintableMesh {
  const shapes = markingShapes(polygons)
  if (!shapes.length) return { name, vertices: [], triangles: [] }
  const geometry = createMarkingGeometry(polygons, depth)
  const material = new THREE.MeshBasicMaterial()
  const root = new THREE.Mesh(geometry, material)
  try {
    const mesh = collectPanelMesh(root, panel, { x: 0, y: 0, rotation: 0 })
    mesh.name = name
    return mesh
  } finally {
    geometry.dispose()
    material.dispose()
  }
}

/** Raised coupon ID on the back; the paired plate keeps its own recessed assembly marking. */
function createSampleBackNumber(panel: SplitPanel, cfg: SplitConfig, label: string): PrintableMesh {
  const centers = [{ x: panel.x + panel.w / 2, y: panel.y + panel.h / 2 }]
  for (let y = panel.y + 1; y < panel.y + panel.h - 1; y += 2)
    for (let x = panel.x + 1; x < panel.x + panel.w - 1; x += 2) centers.push({ x, y })
  for (const text of [label, label.slice(1)]) for (const height of (panel.w < 16 || panel.h < 16 ? [2.8] : [4.2, 2.8])) {
    const points = pixelTextPolygons(text, 0, 0, height).flat()
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x))
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y))
    const center = centers.find(({ x, y }) => placementFits(panel, cfg, x, y, maxX - minX + 0.5, maxY - minY + 0.5, 0, 0.6, []))
    if (!center) continue
    const polygons = pixelTextPolygons(text, center.x - (minX + maxX) / 2, center.y - (minY + maxY) / 2, height)
    return createGlyphReliefMesh(panel, polygons, 0.24, `${label}-raised-back-number`)
  }
  throw new Error(`${label} 试样背面没有可放置编号的平坦区域；请移动取样点或增大试样边长`)
}

function createAdaptiveChamferPanelMesh(
  panel: SplitPanel,
  cfg: SplitConfig,
  warnings: string[],
): PrintableMesh {
  const requested = Math.max(0, cfg.manufacturingChamfer)
  let lastClosureError: unknown = null
  for (const chamfer of chamferCandidates(requested)) {
    const root = generateSplitPanelMesh({
      panel,
      cfg,
      color: 0x3ec6b0,
      curveSegments: manufacturingCurveSegments(cfg),
      slotCapSegments: slotCapSegments(cfg.slotWidth),
      includeGuides: false,
      manufacturingChamfer: chamfer,
    })
    try {
      const mesh = collectPanelMesh(root, panel, { x: 0, y: 0, rotation: 0 })
      if (chamfer < requested - 1e-6) pushUniqueWarning(
        warnings,
        chamfer <= 0.001
          ? `${panel.id.toUpperCase()} 含尖角/窄边，${requested.toFixed(2)}mm 制造倒角会产生开口网格；已仅对该板关闭倒角`
          : `${panel.id.toUpperCase()} 含尖角/窄边，制造倒角已从 ${requested.toFixed(2)}mm 自动降至 ${chamfer.toFixed(2)}mm 以保持网格封闭`,
      )
      return mesh
    } catch (error) {
      if (!isMeshClosureError(error)) throw error
      lastClosureError = error
    } finally {
      disposeObject(root)
    }
  }
  throw lastClosureError instanceof Error ? lastClosureError : new Error(`${panel.id.toUpperCase()} 无法生成封闭制造网格`)
}

/** Build one layer transactionally, retaining recipe IDs and the original Z stack. */
async function createContinuousTextureLayer(
  materials: Int16Array, width: number, height: number,
  xBoundaries: number[], yBoundaries: number[],
  layer: number, panel: SplitPanel, colorDomain: MultiPolygon, context: TextureManufacturingContext, signal?: AbortSignal,
): Promise<{ meshes: Map<number, PrintableMesh>; diagnostics?: TextureContourDiagnostics }> {
  if (!context.vectorRegions?.eligible) {
    const result = await buildRasterTextureLayerResponsive({
      materials, width, height, xBoundaries, yBoundaries, colorDomain,
      panelId: panel.id, panelX: panel.x, panelY: panel.y, layer,
      zMin: context.opticalStart + layer * context.lut.layerHeight,
      zMax: context.opticalStart + (layer + 1) * context.lut.layerHeight,
      straightFit: context.config.manufacturingEdgeQuality === 'fine',
      maxBoundaryEdges: context.contourEdgeBudget,
    }, signal)
    for (const mesh of result.meshes.values()) validateClosedMesh(mesh.name, mesh.triangles)
    return result
  }
  const domainPolygons = colorDomain
  const byMaterial = new Map<number, MultiPolygon[]>()
  if (domainPolygons.length) for (const region of context.vectorRegions.regions) {
      const hex = Number.parseInt(region.color.slice(1), 16)
      const recipe = matchSnapColor([hex >> 16, (hex >> 8) & 255, hex & 255], context.lut, context.config.hueWeight)
      const material = snapColorStackMaterial(context.lut, recipe, layer)
      const clipped = polygonClipping.intersection(region.polygons, domainPolygons)
      if (!clipped.length) continue
      const previous = byMaterial.get(material) ?? []
      previous.push(clipped); byMaterial.set(material, previous)
  }
    // The vector painter already produced a disjoint partition. Adjacent
    // same-material shells can share faces in one material mesh (as legacy
    // rectangles do); another global union adds no coverage and is expensive
    // on high-detail traced scans.
  const result = new Map<number, PrintableMesh>()
  for (const [material, pieces] of byMaterial) {
    // Clip the sampled material partition to the same curved hole/outer profile as the structural board.
    const exact = pieces.flat()
    const local = exact.map(p => ({ outer: p[0].slice(0, -1).map(([x, y]) => [x - panel.x, y - panel.y] as [number, number]), holes: p.slice(1).map(ring => ring.slice(0, -1).map(([x, y]) => [x - panel.x, y - panel.y] as [number, number])) }))
    if (!local.length) continue
    const geometry = extrudeTexturePartition(local, context.opticalStart + layer * context.lut.layerHeight, context.opticalStart + (layer + 1) * context.lut.layerHeight)
    const mesh: PrintableMesh = { name: `${panel.id}-contour-${layer}-${material}`, vertices: [], triangles: [] }
    for (let i = 0; i < geometry.vertices.length; i += 3) mesh.vertices.push([geometry.vertices[i], geometry.vertices[i + 1], geometry.vertices[i + 2]])
    for (let i = 0; i < geometry.triangles.length; i += 3) mesh.triangles.push([geometry.triangles[i], geometry.triangles[i + 1], geometry.triangles[i + 2]])
    if (mesh.triangles.length) { validateClosedMesh(mesh.name, mesh.triangles); result.set(material, mesh) }
  }
  return { meshes: result }
}

async function createPanelTextureParts(
  panel: SplitPanel,
  cfg: SplitConfig,
  context: TextureManufacturingContext,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
  warnings: string[] = [],
  sourcePanel?: SplitPanel,
  onPart?: (part: ManufacturingPart) => Promise<void>,
): Promise<ManufacturingPart[]> {
  throwIfExportAborted(signal)
  if (context.config.surfaceMode === 'veneer') {
    const veneer = createOneSidedBeveledLayer(
      panel,
      sourcePanel ? { ...cfg, manufacturingChamfer: 0 } : cfg,
      context.structuralThickness,
      context.textureThickness,
      'top',
      `${panel.id}-surface-veneer`,
      warnings,
    )
    onProgress?.(1)
    return [{
      name: `${panel.id.toUpperCase()} · ${context.config.surfaceMaterialName} · ${context.textureThickness.toFixed(2)}mm 质感贴面`,
      mesh: veneer,
      extruder: 2,
      color: context.config.surfaceColor,
      settings: veneerPartSettings(context.config),
    }]
  }
  const meshes = context.lut.materials.map((_, index): PrintableMesh => ({ name: `${panel.id}-snapcolor-material-${index + 1}`, vertices: [], triangles: [] }))
  const edgeSealMesh: PrintableMesh = { name: `${panel.id}-base-edge-seal`, vertices: [], triangles: [] }
  const parts: ManufacturingPart[] = []
  const emit = async (part: ManufacturingPart) => { if (onPart) await onPart(part); else parts.push(part) }
  const fillerDepth = context.opticalStart - context.structuralThickness
  if (fillerDepth > 0.001) {
    const filler = createPanelPrismMesh(panel, cfg, context.structuralThickness, fillerDepth, `${panel.id}-surface-backing`)
    await emit({
      name: `${panel.id.toUpperCase()} · 顶部模具承托层 ${fillerDepth.toFixed(2)}mm`,
      mesh: filler,
      extruder: 2,
      color: context.colors[0],
      settings: backingPartSettings(),
    })
  }

  const cell = context.samplePitch
  const profile = panelMaterialProfile(panel, cfg)
  const startRow = Math.floor((panel.y - context.bounds.minY) / cell)
  const endRow = Math.ceil((panel.y + panel.h - context.bounds.minY) / cell)
  const startColumn = Math.floor((panel.x - context.bounds.minX) / cell)
  const endColumn = Math.ceil((panel.x + panel.w - context.bounds.minX) / cell)
  const columnCount = endColumn - startColumn
  const rowCount = endRow - startRow
  const rasterOriginX = context.bounds.minX + startColumn * cell
  const rasterOriginY = context.bounds.minY + startRow * cell
  const continuous = context.config.manufacturingContours !== false && context.config.modelingMode !== 'pixel'
  // Exact physical colour/seal domains clip every continuous layer later.
  // Its per-cell loop never consults the old mask or chamfer distance, so
  // rasterizing all holes here wastes work and prevents native execution.
  const raster = continuous ? null : panelMaterialRaster(profile, columnCount, rowCount, rasterOriginX, rasterOriginY, cell)
  if (sourcePanel && raster) {
    // Keep distances to ORIGINAL holes/edges, not the newly cut coupon boundary.
    const pad=Math.ceil((context.config.edgeSealWidth+cfg.manufacturingChamfer+2)/cell)+3
    const reference=panelMaterialRaster(panelMaterialProfile(sourcePanel,cfg),columnCount+2*pad,rowCount+2*pad,rasterOriginX-pad*cell,rasterOriginY-pad*cell,cell)
    for(let y=0;y<rowCount;y++)for(let x=0;x<columnCount;x++)raster.distance[y*columnCount+x]=reference.distance[(y+pad)*reference.width+x+pad]
  }
  const layerCount = context.lut.layerCount
  const sealMaterial = meshes.length
  const toDomain = (p: PanelMaterialProfile): MultiPolygon => [[p.outer, ...p.holes].map(r => [...r.map(v => [v.x,v.y] as [number,number]), [r[0].x,r[0].y]])]
  const physicalDomain = toDomain(profile)
  const originalDomain = sourcePanel ? toDomain(panelMaterialProfile(sourcePanel,cfg)) : physicalDomain
  const domains = continuous ? Array.from({length:layerCount},(_,layer) => textureLayerDomains(physicalDomain,originalDomain,Math.max(0,context.opticalStart+(layer+.5)*context.lut.layerHeight-(cfg.thickness-cfg.manufacturingChamfer)),context.config.edgeSealEnabled ? Math.max(0,context.config.edgeSealWidth) : 0)) : []
  const addExact = (mesh: PrintableMesh, polygons: MultiPolygon, layer: number) => {
    if (!polygons.length) return
    const local = polygons.map(p=>({outer:p[0].slice(0,-1).map(([x,y])=>[x-panel.x,y-panel.y] as [number,number]),holes:p.slice(1).map(r=>r.slice(0,-1).map(([x,y])=>[x-panel.x,y-panel.y] as [number,number]))}))
    const g=extrudeTexturePartition(local,context.opticalStart+layer*context.lut.layerHeight,context.opticalStart+(layer+1)*context.lut.layerHeight)
    const part:PrintableMesh={name:mesh.name,vertices:[],triangles:[]}
    for(let i=0;i<g.vertices.length;i+=3)part.vertices.push([g.vertices[i],g.vertices[i+1],g.vertices[i+2]])
    for(let i=0;i<g.triangles.length;i+=3)part.triangles.push([g.triangles[i],g.triangles[i+1],g.triangles[i+2]])
    validateClosedMesh(part.name,part.triangles);appendPrintableMesh(mesh,part)
  }
  // 矢量路线在 createContinuousTextureLayer 里直接读 SVG 区域，从不读 layerGrids；它还会在
  // 失败时整单报错而不是回退到栅格。所以给它零长占位：既不物化整块栅格，也不必在主循环和
  // 调用点到处加分支，而下面那段逐格预处理整段成为无效功耗。
  const vectorRoute = context.vectorRegions?.eligible === true
  const layerGrids = continuous
    ? Array.from({ length: layerCount }, () => vectorRoute ? new Int16Array(0) : new Int16Array(columnCount * rowCount).fill(-1))
    : null
  const xBoundaries = Array.from({ length: columnCount + 1 }, (_, i) => Math.max(panel.x, Math.min(panel.x + panel.w, rasterOriginX + i * cell)))
  const yBoundaries = Array.from({ length: rowCount + 1 }, (_, i) => Math.max(panel.y, Math.min(panel.y + panel.h, rasterOriginY + i * cell)))
  interface ActiveRect { material: number; x0: number; x1: number; y0: number; y1: number }
  const pendingRects: ActiveRect[][] = Array.from({ length: layerCount }, () => [])
  const pendingSealRects: ActiveRect[][] = Array.from({ length: layerCount }, () => [])
  const active = Array.from({ length: layerCount }, () => new Map<string, ActiveRect>())
  const edgeSealActive = Array.from({ length: layerCount }, () => new Map<string, ActiveRect>())
  const flushLegacy = (layer: number, rect: ActiveRect) => appendBox(
    meshes[rect.material],
    rect.x0 - panel.x,
    rect.y0 - panel.y,
    context.opticalStart + layer * context.lut.layerHeight,
    rect.x1 - panel.x,
    rect.y1 - panel.y,
    context.opticalStart + (layer + 1) * context.lut.layerHeight,
  )
  const flush = (layer: number, rect: ActiveRect) => continuous ? pendingRects[layer].push(rect) : flushLegacy(layer, rect)
  const flushEdgeSeal = (layer: number, rect: ActiveRect) => pendingSealRects[layer].push(rect)
  const flushLegacySeal = (layer: number) => {
    for (const rect of pendingSealRects[layer]) appendBox(edgeSealMesh,
      rect.x0 - panel.x, rect.y0 - panel.y, context.opticalStart + layer * context.lut.layerHeight,
      rect.x1 - panel.x, rect.y1 - panel.y, context.opticalStart + (layer + 1) * context.lut.layerHeight)
  }

  // 矢量路线把行区间取空：逐格配方采样、材料映射和封边矩形归并都不再执行。
  for (let row = vectorRoute ? endRow : startRow; row < endRow; row++) {
    const globalY0 = Math.max(panel.y, context.bounds.minY + row * cell)
    const globalY1 = Math.min(panel.y + panel.h, context.bounds.minY + (row + 1) * cell)
    const rowMaterials = Array.from({ length: layerCount }, () => {
      const values = new Int16Array(columnCount)
      values.fill(-1)
      return values
    })
    const rowEdgeSeal = Array.from({ length: layerCount }, () => new Uint8Array(columnCount))
    for (let column = startColumn; column < endColumn; column++) {
      const globalX0 = Math.max(panel.x, context.bounds.minX + column * cell)
      const globalX1 = Math.min(panel.x + panel.w, context.bounds.minX + (column + 1) * cell)
      const localIndex = (row - startRow) * columnCount + (column - startColumn)
      if (globalX1 <= globalX0 || globalY1 <= globalY0 || (!continuous && !raster!.mask[localIndex])) continue
      const distanceMm = continuous ? 0 : raster!.distance[localIndex] / 3 * cell
      let recipe = -1
      for (let layer = 0; layer < layerCount; layer++) {
        const zMid = context.opticalStart + (layer + 0.5) * context.lut.layerHeight
        const inset = Math.max(0, zMid - (cfg.thickness - cfg.manufacturingChamfer))
        if (!continuous && inset > 0 && distanceMm < inset + cell * 0.2) continue
        if (!continuous && isTextureEdgeSealCell(distanceMm, cell, context.config.edgeSealEnabled, context.config.edgeSealWidth)) {
          rowEdgeSeal[layer][column - startColumn] = 1
          continue
        }
        if (recipe < 0) recipe = sourcePanel
          ? textureRecipeAt(context.bounds.minX+(column+.5)*cell,context.bounds.minY+(row+.5)*cell,context)
          : textureRecipeAt((globalX0 + globalX1) / 2, (globalY0 + globalY1) / 2, context)
        rowMaterials[layer][column - startColumn] = snapColorStackMaterial(context.lut, recipe, layer)
      }
    }
    for (let layer = 0; layer < layerCount; layer++) {
      if (layerGrids) {
        const offset = (row - startRow) * columnCount
        for (let x = 0; x < columnCount; x++) layerGrids[layer][offset + x] = rowEdgeSeal[layer][x] ? sealMaterial : rowMaterials[layer][x]
      }
      const next = new Map<string, ActiveRect>()
      const values = rowMaterials[layer]
      let start = 0
      while (start < values.length) {
        const material = values[start]
        if (material < 0) { start++; continue }
        let end = start + 1
        while (end < values.length && values[end] === material) end++
        const x0 = Math.max(panel.x, context.bounds.minX + (startColumn + start) * cell)
        const x1 = Math.min(panel.x + panel.w, context.bounds.minX + (startColumn + end) * cell)
        const key = `${material}:${x0.toFixed(4)}:${x1.toFixed(4)}`
        const previous = active[layer].get(key)
        const rect = previous && Math.abs(previous.y1 - globalY0) < 1e-5
          ? { ...previous, y1: globalY1 }
          : { material, x0, x1, y0: globalY0, y1: globalY1 }
        next.set(key, rect)
        start = end
      }
      for (const [key, rect] of active[layer]) if (!next.has(key)) flush(layer, rect)
      active[layer] = next

      const nextSeal = new Map<string, ActiveRect>()
      const sealValues = rowEdgeSeal[layer]
      let sealStart = 0
      while (sealStart < sealValues.length) {
        if (!sealValues[sealStart]) { sealStart++; continue }
        let sealEnd = sealStart + 1
        while (sealEnd < sealValues.length && sealValues[sealEnd]) sealEnd++
        const x0 = Math.max(panel.x, context.bounds.minX + (startColumn + sealStart) * cell)
        const x1 = Math.min(panel.x + panel.w, context.bounds.minX + (startColumn + sealEnd) * cell)
        const key = `${x0.toFixed(4)}:${x1.toFixed(4)}`
        const previous = edgeSealActive[layer].get(key)
        const rect = previous && Math.abs(previous.y1 - globalY0) < 1e-5
          ? { ...previous, y1: globalY1 }
          : { material: 0, x0, x1, y0: globalY0, y1: globalY1 }
        nextSeal.set(key, rect)
        sealStart = sealEnd
      }
      for (const [key, rect] of edgeSealActive[layer]) if (!nextSeal.has(key)) flushEdgeSeal(layer, rect)
      edgeSealActive[layer] = nextSeal
    }
    if ((row - startRow) % 32 === 31) {
      await yieldExportThread()
      throwIfExportAborted(signal)
      onProgress?.(0.55 * (row - startRow + 1) / Math.max(1, rowCount))
    }
  }
  onProgress?.(0.55)
  for (let layer = 0; layer < layerCount; layer++) for (const rect of active[layer].values()) flush(layer, rect)
  for (let layer = 0; layer < layerCount; layer++) for (const rect of edgeSealActive[layer].values()) flushEdgeSeal(layer, rect)

  if (layerGrids) for (let layer = 0; layer < layerCount; layer++) {
    throwIfExportAborted(signal)
    const layerMeshes = onPart ? meshes.map(mesh => ({ name: mesh.name, vertices: [], triangles: [] } as PrintableMesh)) : meshes
    const layerSeal = onPart ? { name: edgeSealMesh.name, vertices: [], triangles: [] } as PrintableMesh : edgeSealMesh
    const alreadyClosed = new Set<PrintableMesh>()
    addExact(layerSeal, domains[layer].seal, layer)
    try {
      const generated = await createContinuousTextureLayer(layerGrids[layer], columnCount, rowCount, xBoundaries, yBoundaries, layer, panel, domains[layer].color, context, signal)
      for (const [material, mesh] of generated.meshes) {
        if (onPart && material !== sealMaterial) { layerMeshes[material] = mesh; alreadyClosed.add(mesh) }
        else appendPrintableMesh(material === sealMaterial ? layerSeal : layerMeshes[material], mesh)
      }
      context.contourReports.push({ panelId: panel.id, layer: layer + 1, route: context.vectorRegions?.eligible ? 'svg-paths' : 'shared-contours', vertices: [...generated.meshes.values()].reduce((n, m) => n + m.vertices.length, 0), triangles: [...generated.meshes.values()].reduce((n, m) => n + m.triangles.length, 0), diagnostics: generated.diagnostics })
      if (generated.diagnostics?.fallbackReason) pushUniqueWarning(warnings, `${panel.id} 第 ${layer + 1} 层保留未经平滑的连续轮廓：${generated.diagnostics.fallbackReason}`)
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      // A vector recipe must not silently fall back to the differently quantized bitmap preview.
      if (context.vectorRegions?.eligible) throw new Error(`${panel.id} 矢量轮廓制造失败：${error instanceof Error ? error.message : String(error)}`)
      // Keep raster colour fallback, but clip every rectangle to the exact colour domain.
      // Structural seal geometry must never fall back with a self-touching image region.
      for (const r of pendingRects[layer]) {
        const box: MultiPolygon = [[[[r.x0,r.y0],[r.x1,r.y0],[r.x1,r.y1],[r.x0,r.y1],[r.x0,r.y0]]]]
        addExact(layerMeshes[r.material],polygonClipping.intersection(box,domains[layer].color),layer)
      }
      context.contourReports.push({ panelId: panel.id, layer: layer + 1, route: 'legacy-grid-fallback', reason: error instanceof Error ? error.message : String(error) })
      pushUniqueWarning(warnings, `${panel.id} 第 ${layer + 1} 个叠色层连续轮廓未通过检查，已保留原始网格：${error instanceof Error ? error.message : String(error)}`)
    }
    if (onPart) {
      if (layerSeal.triangles.length) {
        validateClosedMesh(layerSeal.name, layerSeal.triangles)
        await emit({ name: `${panel.id.toUpperCase()} · 基材单线封边墙 · 第${layer + 1}层`, mesh: layerSeal,
          extruder: 1, color: context.config.baseColor, settings: surfacePartSettings(context.lut.layerHeight) })
      }
      for (let material = 0; material < layerMeshes.length; material++) {
        const mesh = layerMeshes[material]
        if (!mesh.triangles.length) continue
        if (!alreadyClosed.has(mesh)) validateClosedMesh(mesh.name, mesh.triangles)
        await emit({ name: `${panel.id.toUpperCase()} · SnapColor ${context.lut.materials[material].name} · 第${layer + 1}层`,
          mesh, extruder: material + 2, color: context.colors[material], settings: surfacePartSettings(context.lut.layerHeight) })
      }
      pendingRects[layer].length = 0
      layerGrids[layer] = new Int16Array(0)
    }
    await yieldExportThread()
    onProgress?.(0.55 + 0.45 * (layer + 1) / layerCount)
  }
  if (!layerGrids) for (let layer = 0; layer < layerCount; layer++) flushLegacySeal(layer)
  if (!layerGrids) onProgress?.(1)

  if (edgeSealMesh.triangles.length) {
    validateClosedMesh(edgeSealMesh.name, edgeSealMesh.triangles)
    parts.push({
      name: `${panel.id.toUpperCase()} · 基材单线封边墙 ${context.config.edgeSealWidth.toFixed(2)}mm`,
      mesh: edgeSealMesh,
      extruder: 1,
      color: context.config.baseColor,
      settings: surfacePartSettings(context.lut.layerHeight),
    })
  }

  parts.push(...meshes.flatMap((mesh, index) => {
    if (!mesh.triangles.length) return []
    validateClosedMesh(mesh.name, mesh.triangles)
    return [{
      name: `${panel.id.toUpperCase()} · SnapColor ${context.lut.materials[index].name} · ${context.lut.layerCount}×${context.lut.layerHeight.toFixed(2)}mm`,
      mesh,
      extruder: index + 2,
      color: context.colors[index],
      settings: surfacePartSettings(context.lut.layerHeight),
    }]
  }))
  return parts
}

function partSignature(instance: PlacedPart): string {
  const params = Object.fromEntries(Object.entries(instance.params).sort(([a], [b]) => a.localeCompare(b)))
  return `${instance.defId}:${JSON.stringify(params)}`
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(material)) material.forEach(item => item.dispose())
    else material?.dispose()
  })
}

function normalizePrintableMesh(root: THREE.Object3D, name: string): PrintableMesh {
  const vertices: Array<[number, number, number]> = []
  const triangles: Array<[number, number, number]> = []
  root.updateMatrixWorld(true)
  root.traverse(object => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry>
    if (!mesh.isMesh || object.userData.previewOnly || !mesh.geometry?.getAttribute('position')) return
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(mesh.matrixWorld)
    for (const attribute of Object.keys(geometry.attributes)) {
      if (attribute !== 'position') geometry.deleteAttribute(attribute)
    }
    geometry.morphAttributes = {}
    const indexed = mergeVertices(geometry, 1e-5)
    const position = indexed.getAttribute('position') as THREE.BufferAttribute
    const base = vertices.length
    for (let i = 0; i < position.count; i++) {
      vertices.push([position.getX(i), position.getY(i), position.getZ(i)])
    }
    const index = indexed.getIndex()
    const count = index?.count ?? position.count
    for (let i = 0; i + 2 < count; i += 3) {
      const a = base + (index ? index.getX(i) : i)
      const b = base + (index ? index.getX(i + 1) : i + 1)
      const c = base + (index ? index.getX(i + 2) : i + 2)
      if (a !== b && b !== c && a !== c) triangles.push([a, b, c])
    }
    geometry.dispose()
    indexed.dispose()
  })
  if (!vertices.length || !triangles.length) throw new Error(`${name} 没有可导出的实体网格`)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  for (const vertex of vertices) {
    minX = Math.min(minX, vertex[0])
    minY = Math.min(minY, vertex[1])
    minZ = Math.min(minZ, vertex[2])
  }
  for (const vertex of vertices) {
    vertex[0] -= minX
    vertex[1] -= minY
    vertex[2] -= minZ
  }
  validateClosedMesh(name, triangles)
  return { name, vertices, triangles }
}

function orientPartForPrinting(root: THREE.Object3D, definition: PartDefinition): THREE.Object3D {
  const wrapper = new THREE.Group()
  wrapper.add(root)
  const configured = definition.model.printOrientation
  if (configured) {
    wrapper.rotation.set(...configured.map(THREE.MathUtils.degToRad) as [number, number, number])
    return wrapper
  }
  root.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3())
  if (size.x <= size.y && size.x <= size.z) wrapper.rotation.y = -Math.PI / 2
  else if (size.y <= size.x && size.y <= size.z) wrapper.rotation.x = Math.PI / 2
  return wrapper
}

type PlanarPoint = [number, number]

function cross(origin: PlanarPoint, a: PlanarPoint, b: PlanarPoint) {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
}

/** 只保留 XY 投影的凸包顶点，避免为每个候选角度反复扫描板件孔洞产生的大量网格顶点。 */
function printableMeshFootprint(mesh: PrintableMesh): PlanarPoint[] {
  const unique = new Map<string, PlanarPoint>()
  for (const [x, y] of mesh.vertices) unique.set(`${x}:${y}`, [x, y])
  const points = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (points.length <= 2) return points

  const lower: PlanarPoint[] = []
  for (const point of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: PlanarPoint[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop()
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function printableMeshBounds(points: PlanarPoint[], rotation: number) {
  const angle = rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of points) {
    const rx = x * cos - y * sin
    const ry = x * sin + y * cos
    minX = Math.min(minX, rx)
    minY = Math.min(minY, ry)
    maxX = Math.max(maxX, rx)
    maxY = Math.max(maxY, ry)
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}

function rotationCandidates(preferred: number, allowDiagonal: boolean): number[] {
  const values = [preferred, 0, 90, 180, 270]
  if (allowDiagonal) {
    // 洞洞板允许利用热床对角线；0.25° 与分割引擎的搜索精度保持一致。
    for (let angle = 0; angle < 180; angle += 0.25) values.push(angle)
  }
  return [...new Set(values.map(value => Math.round((((value % 360) + 360) % 360) * 100) / 100))]
}

/**
 * 按有效打印边界排盘，并避开擦嘴/切刀等禁放区。板件可按 0.25° 搜索斜放；
 * 每个盘内仍使用保守包围盒防碰撞，保证第三方切片器读取实例变换后不会重叠。
 */
export function packManufacturingObjects(objects: ManufacturingObject[], cfg: SplitConfig): BuildPlate[] {
  const gap = 8
  const area = getPrintBedBounds(cfg)
  const usableW = area.width
  const usableH = area.height
  if (usableW <= 0 || usableH <= 0) throw new Error('热床尺寸过小，无法排盘')
  const plates: BuildPlate[] = []
  const instanceCounters = new Map<string, number>()
  const footprintCache = new WeakMap<PrintableMesh, PlanarPoint[]>()
  const candidateCache = new Map<string, Array<{
    rotation: number
    bounds: ReturnType<typeof printableMeshBounds>
    footprint: Point2D[]
    seed: { x: number; y: number }
  }>>()
  let identifyId = 1

  const getPlacementCandidates = (object: ManufacturingObject) => {
    const cached = candidateCache.get(object.key)
    if (cached) return cached
    let footprint = footprintCache.get(object.mesh)
    if (!footprint) {
      footprint = printableMeshFootprint(object.mesh)
      footprintCache.set(object.mesh, footprint)
    }
    const preferred = Math.round((((object.preferredRotation % 360) + 360) % 360) * 100) / 100
    const candidates = rotationCandidates(object.preferredRotation, object.kind === 'panel')
      .map(rotation => {
        const angle = rotation * Math.PI / 180
        const cos = Math.cos(angle), sin = Math.sin(angle)
        const rotated = footprint.map(([x, y]) => ({ x: x * cos - y * sin, y: x * sin + y * cos }))
        const seed = findFootprintPlacement(rotated, cfg)
        return { rotation, bounds: printableMeshBounds(footprint, rotation), footprint: rotated, seed }
      })
      .filter((candidate): candidate is typeof candidate & { seed: { x: number; y: number } } => candidate.seed !== null)
      .sort((a, b) => {
        // 已由分割器指定且仍满足边界的方向优先；否则选占用热床最长边比例最小的方向。
        if (a.rotation === preferred && b.rotation !== preferred) return -1
        if (b.rotation === preferred && a.rotation !== preferred) return 1
        const aScore = Math.max(a.bounds.width / usableW, a.bounds.height / usableH)
        const bScore = Math.max(b.bounds.width / usableW, b.bounds.height / usableH)
        return aScore - bScore
      })
    candidateCache.set(object.key, candidates)
    return candidates
  }

  const collidesWithInstance = (
    bounds: PackedInstance['worldBounds'],
    instance: PackedInstance,
  ) => !(bounds.maxX + gap <= instance.worldBounds.minX ||
    bounds.minX >= instance.worldBounds.maxX + gap ||
    bounds.maxY + gap <= instance.worldBounds.minY ||
    bounds.minY >= instance.worldBounds.maxY + gap)

  const tryPlace = (plate: BuildPlate, object: ManufacturingObject, objectId: number) => {
    for (const { rotation, bounds, footprint, seed } of getPlacementCandidates(object)) {
      const xs = [area.minX - bounds.minX, area.maxX - (bounds.minX + bounds.width), seed.x]
      const ys = [area.minY - bounds.minY, area.maxY - (bounds.minY + bounds.height), seed.y]
      for (const instance of plate.instances) {
        xs.push(instance.worldBounds.maxX + gap - bounds.minX)
        xs.push(instance.worldBounds.minX - gap - bounds.minX - bounds.width)
        ys.push(instance.worldBounds.maxY + gap - bounds.minY)
        ys.push(instance.worldBounds.minY - gap - bounds.minY - bounds.height)
      }
      for (const zone of getEnabledKeepouts(cfg)) {
        xs.push(zone.x - 0.01 - bounds.minX - bounds.width)
        xs.push(zone.x + zone.w + 0.01 - bounds.minX)
        ys.push(zone.y - 0.01 - bounds.minY - bounds.height)
        ys.push(zone.y + zone.h + 0.01 - bounds.minY)
      }
      const unique = (values: number[]) => [...new Set(values.map(value => Number(value.toFixed(6))))]
      const positions = unique(ys).flatMap(y => unique(xs).map(x => ({ x, y })))
        .sort((a, b) => a.y - b.y || a.x - b.x)
      for (const position of positions) {
        const worldBounds = {
          minX: bounds.minX + position.x,
          minY: bounds.minY + position.y,
          maxX: bounds.minX + bounds.width + position.x,
          maxY: bounds.minY + bounds.height + position.y,
        }
        if (worldBounds.minX < area.minX - 1e-6 || worldBounds.maxX > area.maxX + 1e-6 ||
            worldBounds.minY < area.minY - 1e-6 || worldBounds.maxY > area.maxY + 1e-6) continue
        if (plate.instances.some(instance => collidesWithInstance(worldBounds, instance))) continue
        const translated = footprint.map(point => ({ x: point.x + position.x, y: point.y + position.y }))
        const blocked = getEnabledKeepouts(cfg).some(zone => polygonIntersectsRect(translated, {
          minX: zone.x, minY: zone.y, maxX: zone.x + zone.w, maxY: zone.y + zone.h,
        }))
        if (blocked) continue
        const packed: PackedInstance = {
          objectKey: object.key, objectId,
          instanceId: instanceCounters.get(object.key) ?? 0,
          identifyId: identifyId++, name: object.name, plate: plate.index,
          rotation, x: position.x, y: position.y, worldBounds,
        }
        plate.instances.push(packed)
        return packed
      }
    }
    return null
  }

  const partCount = objects.reduce((sum, object) => sum + object.parts.length, 0)
  objects.forEach((object, objectIndex) => {
    // 前 partCount 个 id 是真实网格；后续 id 是每个可排盘装配对象。
    const rootObjectId = partCount + objectIndex + 1
    for (let copy = 0; copy < object.quantity; copy++) {
      let packed: PackedInstance | null = null
      for (const plate of plates) {
        if (plate.kind !== object.kind || plate.printGroup !== object.printGroup) continue
        packed = tryPlace(plate, object, rootObjectId)
        if (packed) break
      }
      if (!packed) {
        // 内部数组从 0 开始；写入 Bambu model_settings.config 时必须转换为 1 开始。
        const plate: BuildPlate = { index: plates.length, kind: object.kind,
          printGroup: object.printGroup, instances: [] }
        plates.push(plate)
        packed = tryPlace(plate, object, rootObjectId)
      }
      if (!packed) {
        const detail = object.kind === 'panel' ? '（已尝试 0.25° 精度斜放）' : ''
        throw new Error(`${object.name} 无法放入 ${usableW} × ${usableH} mm 有效打印区${detail}`)
      }
      instanceCounters.set(object.key, packed.instanceId + 1)
    }
  })
  // Pack compactly first, then center each whole plate without changing inter-part gaps.
  // Both a panel and its modifier receive this same root-instance transform.
  for (const plate of plates) {
    const minX = Math.min(...plate.instances.map(i => i.worldBounds.minX)), maxX = Math.max(...plate.instances.map(i => i.worldBounds.maxX))
    const minY = Math.min(...plate.instances.map(i => i.worldBounds.minY)), maxY = Math.max(...plate.instances.map(i => i.worldBounds.maxY))
    const dx = (area.minX + area.maxX - minX - maxX) / 2, dy = (area.minY + area.maxY - minY - maxY) / 2
    const shift = [[dx,dy],[dx,0],[0,dy],[0,0]].find(([x,y]) => plate.instances.every(instance => {
      const footprint = candidateCache.get(instance.objectKey)!.find(c => c.rotation === instance.rotation)!.footprint
      const translated = footprint.map(p => ({ x:p.x+instance.x+x, y:p.y+instance.y+y }))
      return !getEnabledKeepouts(cfg).some(zone => polygonIntersectsRect(translated, {
        minX:zone.x,minY:zone.y,maxX:zone.x+zone.w,maxY:zone.y+zone.h,
      }))
    }))!
    for (const instance of plate.instances) {
      instance.x += shift[0]; instance.y += shift[1]
      instance.worldBounds.minX += shift[0]; instance.worldBounds.maxX += shift[0]
      instance.worldBounds.minY += shift[1]; instance.worldBounds.maxY += shift[1]
    }
  }
  // Keep all beds of a process together even when a later object starts an
  // extra bed. Resource IDs and instance IDs remain tied to the original list.
  const groupOrder = [...new Set(objects.map(o => o.printGroup))]
  plates.sort((a, b) => groupOrder.indexOf(a.printGroup) - groupOrder.indexOf(b.printGroup))
  const sequences = new Map<string, number>()
  plates.forEach((plate, index) => {
    plate.index = index
    plate.instances.forEach(instance => { instance.plate = index })
    if (plate.printGroup) {
      const seq = (sequences.get(plate.printGroup) ?? 0) + 1
      sequences.set(plate.printGroup, seq)
      const label = objects.find(o => o.printGroup === plate.printGroup)?.printGroupName ?? plate.printGroup
      plate.name = `${label} ${String(seq).padStart(2, '0')} · ${plate.instances.map(i => i.objectKey).join('、')}`
    }
  })
  return plates
}

/**
 * Bambu Studio 在一个项目内用二维网格摆放多张虚拟热床。板内坐标仍由排盘器
 * 计算，但第二盘起必须叠加热床网格原点；否则配置读取失败或被忽略时，所有
 * build item 都会落回同一个坐标区域，看起来像是“零件全堆在一起”。
 */
function plateGridOffset(plate: number, plateCount: number, cfg: SplitConfig): { x: number; y: number } {
  // Match Bambu Studio PartPlateList: ceil(sqrt(count)) columns and a 20%
  // logical bed gap, independently on each axis (also for rectangular beds).
  const columns = Math.max(1, Math.ceil(Math.sqrt(plateCount)))
  const column = plate % columns
  const row = Math.floor(plate / columns)
  return {
    x: column * cfg.bedW * 1.2,
    y: -row * cfg.bedH * 1.2,
  }
}

function buildTransform(instance: PackedInstance, cfg: SplitConfig, plateCount: number): string {
  const angle = instance.rotation * Math.PI / 180
  const cos = number(Math.cos(angle))
  const sin = number(Math.sin(angle))
  const plateOffset = plateGridOffset(instance.plate, plateCount, cfg)
  return `${cos} ${sin} 0 ${number(-Math.sin(angle))} ${cos} 0 0 0 1 ${number(instance.x + plateOffset.x)} ${number(instance.y + plateOffset.y)} 0`
}

// Bambu Studio only loads its plate sidecars when the 3MF declares a Bambu
// application version. Keep this deliberately conservative: it is a format
// compatibility marker, while SnapBoard remains recorded as the generator.
const snapColorProjectTemplate = JSON.parse(snapColorBambuConfigTemplate) as Record<string, unknown>
export const BAMBU_COMPAT_VERSION = BAMBU_PROFILE_VERSION

/** 当前切片配置的线宽 mm：采样间距比它更密不会有可打印收益，模板缺失时按 0.4 喷嘴的常见值兜底。 */
export function configuredLineWidthMm(): number {
  const lineWidth = Number(snapColorProjectTemplate.line_width)
  return Number.isFinite(lineWidth) && lineWidth > 0 ? lineWidth : 0.42
}

interface IndexedManufacturingPart {
  objectIndex: number
  partId: number
  part: ManufacturingPart
}

function indexedManufacturingParts(objects: ManufacturingObject[]): IndexedManufacturingPart[] {
  let partId = 0
  const shared=new Map<string,number>()
  return objects.flatMap((object, objectIndex) => object.parts.map(part => {
    let id=part.sharedGeometryKey?shared.get(part.sharedGeometryKey):undefined
    if(id===undefined){id=++partId;if(part.sharedGeometryKey)shared.set(part.sharedGeometryKey,id)}
    return { objectIndex, partId:id, part }
  }))
}

function rootObjectId(objects: ManufacturingObject[], objectIndex: number): number {
  return objects.reduce((sum, object) => sum + object.parts.length, 0) + objectIndex + 1
}

/**
 * SnapColor 使用一个 object_1.model 容纳全部实际网格，主模型只保存装配引用。
 * 这种结构比“每个网格一个外部文件 + 自造 production UUID”兼容性更好，
 * Bambu Studio、OrcaSlicer 也更容易恢复 object/part 对应关系。
 */
function* manufacturingPartXmlChunks(partId: number, part: ManufacturingPart, preview?: { resourceId: number; material: number }): Generator<Uint8Array> {
  let buffer = ''
  const append = (text: string): Uint8Array | null => {
    buffer += text
    if (buffer.length < 64 * 1024) return null
    const chunk = strToU8(buffer)
    buffer = ''
    return chunk
  }
  let chunk = append(`
    <object id="${partId}" type="${part.subtype === 'modifier_part' ? 'other' : 'model'}" name="${escapeXml(part.name)}"${preview ? ` pid="${preview.resourceId}" pindex="${preview.material}"` : ''}>
      <mesh>
        <vertices>`)
  if (chunk) yield chunk
  for (const [x, y, z] of part.mesh.vertices) {
    chunk = append(`
          <vertex x="${number(x)}" y="${number(y)}" z="${number(z)}"/>`)
    if (chunk) yield chunk
  }
  chunk = append(`
        </vertices>
        <triangles>`)
  if (chunk) yield chunk
  for (const [v1, v2, v3] of part.mesh.triangles) {
    chunk = append(`
          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`)
    if (chunk) yield chunk
  }
  chunk = append(`
        </triangles>
      </mesh>
    </object>`)
  if (chunk) yield chunk
  if (buffer) yield strToU8(buffer)
}

function* manufacturingObjectsModelXmlChunks(objects: ManufacturingObject[], previewColors?: string[]): Generator<Uint8Array> {
  yield strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>`)
  const resourceId = objects.reduce((n, object) => n + object.parts.length, 0) + 1
  if (previewColors?.length) yield strToU8(`<basematerials id="${resourceId}">${previewColors.map((color, index) => `<base name="Filament ${index + 1}" displaycolor="${escapeXml(color.length === 7 ? color + 'FF' : color)}"/>`).join('')}</basematerials>`)
  const written=new Set<number>()
  for (const { partId, part } of indexedManufacturingParts(objects)) {
    if(written.has(partId))continue;written.add(partId);yield* manufacturingPartXmlChunks(partId, part, previewColors?.length ? { resourceId, material: part.extruder - 1 } : undefined)
  }
  yield strToU8(`
  </resources>
  <build/>
</model>`)
}

async function zipManufacturingPackage(files: Record<string, Uint8Array>, objects: ManufacturingObject[], signal?: AbortSignal, previewColors?: string[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  let failure: Error | null = null
  let wake: (() => void) | null = null
  let settle!: (error?: Error) => void
  const completed = new Promise<void>(resolve => {
    settle = error => { if (error) failure = error; resolve() }
  })
  const archive = new Zip((error, data, final) => {
    if (error) { settle(error); wake?.(); return }
    if (data.length) { chunks.push(data); size += data.length }
    if (final) settle()
  })
  const abort = () => {
    archive.terminate()
    settle(new DOMException('3MF 导出已取消', 'AbortError'))
    wake?.()
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (const [name, data] of Object.entries(files)) {
      const file = new ZipDeflate(name, { level: 6 })
      archive.add(file)
      file.push(data, true)
    }
    // Large mesh compression belongs off the UI thread; Node tests keep the synchronous stream.
    const asyncMesh = typeof Worker !== 'undefined'
    const meshFile = !asyncMesh
      ? new ZipDeflate('3D/Objects/object_1.model', { level: 6 })
      : new AsyncZipDeflate('3D/Objects/object_1.model', { level: 6 })
    archive.add(meshFile)
    // fflate queues every posted chunk in its worker. Bound that queue so a
    // multi-board model cannot accumulate hundreds of MB before compression catches up.
    let inFlight = 0
    const forward = meshFile.ondata
    meshFile.ondata = (error, data, final) => {
      forward(error, data, final)
      if (asyncMesh) {
        inFlight--
        if (inFlight < 8) { wake?.(); wake = null }
      }
    }
    let count = 0
    for (const chunk of manufacturingObjectsModelXmlChunks(objects, previewColors)) {
      if (asyncMesh && inFlight >= 8) await new Promise<void>(resolve => { wake = resolve })
      if (failure) throw failure
      throwIfExportAborted(signal)
      if (asyncMesh) inFlight++
      meshFile.push(chunk)
      if (++count % 64 === 0) { await yieldExportThread(); throwIfExportAborted(signal) }
    }
    meshFile.push(new Uint8Array(0), true)
    archive.end()
    await completed
    if (failure) throw failure
    throwIfExportAborted(signal)
    const output = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
    return output
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

/** Writes each finished part before the next layer is built. */
async function createStreamingManufacturingZip(signal?: AbortSignal, toDisk = false, extension = '3mf') {
  const chunks: Uint8Array[] = []
  const directory = toDisk ? await navigator.storage.getDirectory() : null
  const tempName = directory ? `snapboard-export-${crypto.randomUUID()}.${extension}` : ''
  const handle = directory ? await directory.getFileHandle(tempName, { create: true }) : null
  const sink = handle ? await handle.createWritable() : null
  let size = 0, failure: Error | null = null, wake: (() => void) | null = null, queuedDisk = 0, finished = false
  let writeTail = Promise.resolve()
  let settle!: (error?: Error) => void
  const completed = new Promise<void>(resolve => { settle = error => { if (error) failure = error; resolve() } })
  const archive = new Zip((error, data, final) => {
    if (error) { settle(error); wake?.(); return }
    if (data.length) {
      size += data.length
      if (sink) {
        queuedDisk++
        writeTail = writeTail.then(() => sink.write(data)).catch(error => {
          failure = error instanceof Error ? error : new Error(String(error))
          settle(failure)
        }).finally(() => { queuedDisk--; if (queuedDisk < 8) { wake?.(); wake = null } })
      } else chunks.push(data)
    }
    if (final) settle()
  })
  const asyncMesh = typeof Worker !== 'undefined'
  let meshFile: AsyncZipDeflate | ZipDeflate | null = null
  let modelDone: (() => void) | null = null
  let modelCompleted: Promise<void> | null = null
  let modelBytes = 0
  let inFlight = 0
  const abort = () => { archive.terminate(); settle(new DOMException('3MF 导出已取消', 'AbortError')); wake?.(); modelDone?.() }
  signal?.addEventListener('abort', abort, { once: true })
  const write = async (chunk: Uint8Array) => {
    if (!meshFile) throw new Error('3MF 模型条目尚未开始')
    while ((asyncMesh && inFlight >= 8) || queuedDisk >= 8) await new Promise<void>(resolve => { wake = resolve })
    if (failure) throw failure
    throwIfExportAborted(signal)
    modelBytes += chunk.length
    if (modelBytes > 3 * 1024 * 1024 * 1024) throw new Error('单块板的模型 XML 超过 3 GB 安全上限')
    if (asyncMesh) inFlight++
    meshFile.push(chunk)
  }
  return {
    write,
    async addStoredFile(name: string, data: Uint8Array): Promise<void> {
      if (meshFile) throw new Error('前一块板的 3MF 模型尚未完成')
      throwIfExportAborted(signal)
      const file = new ZipPassThrough(name)
      archive.add(file)
      file.push(data, true)
      await writeTail
      if (failure) throw failure
      throwIfExportAborted(signal)
    },
    async startModel(index: number): Promise<string> {
      if (meshFile) throw new Error('前一块板的 3MF 模型尚未完成')
      const path = `/3D/Objects/object_${index}.model`
      meshFile = asyncMesh
        ? new AsyncZipDeflate(path.slice(1), { level: 6 })
        : new ZipDeflate(path.slice(1), { level: 6 })
      archive.add(meshFile)
      modelBytes = 0
      inFlight = 0
      modelCompleted = new Promise<void>(resolve => { modelDone = resolve })
      const forward = meshFile.ondata
      meshFile.ondata = (error, data, final) => {
        forward(error, data, final)
        if (asyncMesh) { inFlight--; if (inFlight < 8) { wake?.(); wake = null } }
        if (error || final) modelDone?.()
      }
      await write(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>`))
      return path
    },
    async endModel(): Promise<void> {
      if (!meshFile || !modelCompleted) throw new Error('没有待完成的 3MF 模型条目')
      await write(strToU8(`
  </resources>
  <build/>
</model>`))
      while ((asyncMesh && inFlight >= 8) || queuedDisk >= 8) await new Promise<void>(resolve => { wake = resolve })
      if (asyncMesh) inFlight++
      meshFile.push(new Uint8Array(0), true)
      await modelCompleted
      await writeTail
      if (failure) throw failure
      throwIfExportAborted(signal)
      meshFile = null
      modelCompleted = null
      modelDone = null
    },
    async finish(files: Record<string, Uint8Array>): Promise<{ data: Uint8Array; file?: File; cleanup?: () => Promise<void> }> {
      if (meshFile) throw new Error('3MF 模型条目尚未关闭')
      for (const [name, data] of Object.entries(files)) {
        const file = new ZipDeflate(name, { level: 6 })
        archive.add(file)
        file.push(data, true)
      }
      archive.end()
      await completed
      await writeTail
      if (failure) throw failure
      throwIfExportAborted(signal)
      if (sink && handle && directory) {
        await sink.close()
        finished = true
        signal?.removeEventListener('abort', abort)
        return { data: new Uint8Array(0), file: await handle.getFile(),
          cleanup: () => directory.removeEntry(tempName) }
      }
      const result = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
      finished = true
      signal?.removeEventListener('abort', abort)
      return { data: result }
    },
    async dispose() {
      signal?.removeEventListener('abort', abort)
      archive.terminate()
      if (!finished && sink && directory) {
        await sink.abort().catch(() => {})
        await directory.removeEntry(tempName).catch(() => {})
      }
    },
  }
}

function manufacturingModelXml(
  objects: ManufacturingObject[],
  plates: BuildPlate[],
  title: string,
  cfg: SplitConfig,
  attribution: SnapBoardAttribution,
): string {
  const indexedParts = indexedManufacturingParts(objects)
  const resources = objects.map((object, index) => {
    const objectId = rootObjectId(objects, index)
    const parts = indexedParts.filter(part => part.objectIndex === index)
    return `
    <object id="${objectId}" type="model" name="${escapeXml(object.name)}">
      <components>${parts.map(({ partId, part }) => `
        <component p:path="${part.modelPath ?? '/3D/Objects/object_1.model'}" objectid="${partId}" transform="${part.transform?.join(' ') ?? '1 0 0 0 1 0 0 0 1 0 0 0'}"/>`).join('')}
      </components>
    </object>`
  }).join('')
  const build = plates.flatMap(plate => plate.instances).map(instance => `
    <item objectid="${instance.objectId}" transform="${buildTransform(instance, cfg, plates.length)}" printable="1"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <metadata name="Title">${escapeXml(title)}</metadata>
  <metadata name="Application">BambuStudio-${BAMBU_COMPAT_VERSION}</metadata>
  <metadata name="BambuStudio:3mfVersion">1</metadata>
  <metadata name="Generator">SnapBoard</metadata>
  <metadata name="SnapBoard:Attribution">${escapeXml(attribution.attributionText)}</metadata>
  <metadata name="SnapBoard:PublicationNotice">${escapeXml(attribution.publicationNotice)}</metadata>
  <metadata name="SnapBoard:AttributionRequired">true</metadata>
  <metadata name="SnapBoard:Schema">${escapeXml(attribution.schema)}</metadata>
  <metadata name="SnapBoard:Version">${escapeXml(attribution.generatorVersion)}</metadata>
  <metadata name="SnapBoard:SourceRecordId">${escapeXml(attribution.sourceRecordId)}</metadata>
  <metadata name="SnapBoard:OriginUrl">${escapeXml(attribution.originUrl)}</metadata>
  <metadata name="SnapBoard:Authenticity">${attribution.authenticity}</metadata>
  <resources>${resources}
  </resources>
  <build>${build}
  </build>
</model>`
}

function partPrintZ(part: ManufacturingPart): [number,number] {
  if (part.printZ) return part.printZ
  let lo=Infinity,hi=-Infinity
  for(const vertex of part.mesh.vertices){
    const t=part.transform,z=t?vertex[0]*t[2]+vertex[1]*t[5]+vertex[2]*t[8]+t[11]:vertex[2]
    lo=Math.min(lo,z);hi=Math.max(hi,z)
  }
  return [round6(lo),round6(hi)]
}

/** Layer height is an object/height-range setting in Bambu, not a volume setting.
 * IDs here are 1-based model-object ordinals, unlike the resource IDs in model_settings. */
function bambuLayerConfigRangesXml(objects:ManufacturingObject[], cfg:SplitConfig, marking:AssemblyMarkingConfig|undefined,
  orderCuts:ReturnType<typeof orderSideEngravings>=[], firstLayerHeight=.25):string {
  const blocks=objects.map((object,index)=>{
    const layers=object.parts.filter(p=>p.subtype!=='modifier_part').map(part=>{
      const [lo,hi]=partPrintZ(part)
      return {lo,hi,height:Number(part.settings?.layer_height??.28)}
    }).filter(p=>Number.isFinite(p.lo)&&Number.isFinite(p.hi)&&p.hi>p.lo&&p.height>0)
    if(object.kind==='panel'){
      for(const cut of orderCuts.filter(cut=>cut.surface==='side'))for(const segment of cut.segments){
        layers.push({lo:Math.max(0,cut.zMm-segment.textHeightMm/2),hi:cut.zMm+segment.textHeightMm/2,height:Z_TOP_LAYER_HEIGHT_MM})
      }
      if(object.sideLogoEngraved||object.numberLocation==='side'){
        const chamfer=Math.max(0,Math.min(cfg.manufacturingChamfer,cfg.thickness/3,cfg.slotWidth/4))
        const height=Math.min(marking?.sideTextHeight??3.5,cfg.thickness-2*(chamfer+.15+.08))
        if(height>=2.1)layers.push({lo:(cfg.thickness-height)/2,hi:(cfg.thickness+height)/2,height:Z_TOP_LAYER_HEIGHT_MM})
      }
    }
    const ranges=manufacturingHeightRanges(layers,{depth:Z_TOP_FINISH_DEPTH_MM,height:Z_TOP_LAYER_HEIGHT_MM},firstLayerHeight)
    if(!ranges.length)return ''
    return `<object id="${index+1}">${ranges.map(r=>`<range min_z="${number(r.lo)}" max_z="${number(r.hi)}"><option opt_key="layer_height">${number(r.height)}</option></range>`).join('')}</object>`
  }).filter(Boolean)
  return `<?xml version="1.0" encoding="UTF-8"?><objects>${blocks.join('')}</objects>`
}

function bambuFirstLayerHeight(objects:ManufacturingObject[],texture:BoardTextureConfig|undefined):number {
  let height=texture?.enabled&&texture.surfaceMode==='woodgrain'?.2:.25
  for(const object of objects)for(const part of object.parts){
    if(part.subtype==='modifier_part')continue
    const [lo,hi]=partPrintZ(part),requested=Number(part.settings?.layer_height??.28)
    if(lo<=1e-6&&hi>0&&requested>0)height=Math.min(height,requested)
  }
  return height
}

function bambuModelSettingsXml(objects: ManufacturingObject[], plates: BuildPlate[]): string {
  // model_settings.config is not merely a plate index: Bambu validates the
  // object/part table before accepting the plate-to-instance mapping. Our core
  // 3MF stores one mesh directly in every resource object, so the part id is
  // the same as that resource object id.
  const indexedParts = indexedManufacturingParts(objects)
  const objectSettings = objects.map((object, index) => {
    const objectId = rootObjectId(objects, index)
    const parts = indexedParts.filter(part => part.objectIndex === index)
    const faceCount = parts.filter(entry=>entry.part.subtype!=='modifier_part').reduce((sum, entry) => sum + (entry.part.faceCount ?? entry.part.mesh.triangles.length), 0)
    const woodRotation = object.parts.some(part => part.subtype === 'modifier_part')
      ? plates.flatMap(plate => plate.instances).find(instance => instance.objectId === objectId)?.rotation ?? 0 : 0
    return `
  <object id="${objectId}">
    <metadata key="name" value="${escapeXml(object.name)}"/>
    <metadata key="extruder" value="1"/>
    ${Object.entries(object.settings ?? {}).filter(([key]) => key !== 'name' && key !== 'extruder' && key !== 'layer_height').map(([key, value]) => `<metadata key="${escapeXml(key)}" value="${escapeXml(value)}"/>`).join('\n    ')}
    ${object.kind!=='part'?'<metadata key="layer_height" value="0.28"/>':''}
    ${object.settings?.wall_generator!=='arachne'&&object.parts.some(p=>p.settings?.wall_generator==='arachne')?'<metadata key="wall_generator" value="arachne"/>':''}
    <metadata face_count="${faceCount}"/>${parts.map(({ partId, part }) => `
    <part id="${partId}" subtype="${part.subtype ?? 'normal_part'}">
      <metadata key="name" value="${escapeXml(part.name)}"/>
      <metadata key="extruder" value="${part.extruder}"/>
      ${Object.entries(part.settings ?? {}).filter(([key])=>key!=='layer_height').map(([key, value]) => `<metadata key="${escapeXml(key)}" value="${escapeXml(key === 'infill_direction' && woodRotation ? String((Number(value) + woodRotation) % 180) : value)}"/>`).join('\n      ')}
      <metadata key="matrix" value="${part.transform ? [part.transform[0],part.transform[3],part.transform[6],part.transform[9],part.transform[1],part.transform[4],part.transform[7],part.transform[10],part.transform[2],part.transform[5],part.transform[8],part.transform[11],0,0,0,1].join(' ') : '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1'}"/>
      <mesh_stat face_count="${part.faceCount ?? part.mesh.triangles.length}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`).join('')}
  </object>`
  }).join('')
  // 盘名必须跟板件自己的编号走，不能按盘序编「第 N 盘」：一盘装不下整单板件时，
  // 盘序与 P 编号必然错位（例如盘 1 装 P01+P02 各一部分，盘 2 才是 P03），
  // 刻字 P01 的板子躺在「第 1 盘」还是「第 2 盘」里完全对不上，用户分不清。
  // 板件盘直接用盘内实例的 P 编号命名；配件盘不编号，多盘时才补序号。
  const plateNames = (() => {
    const sampleTotal = plates.filter(plate => plate.kind === 'sample').length
    const partTotal = plates.filter(plate => plate.kind === 'part').length
    let sampleSeq = 0
    let partSeq = 0
    return plates.map(plate => {
      if (plate.name) return plate.name
      if (plate.kind === 'panel') {
        const ids = [...new Set(plate.instances
          .map(instance => /^P\d+/.exec(instance.name)?.[0])
          .filter((id): id is string => Boolean(id)))]
        return ids.length ? `SnapBoard 板件 ${ids.join('、')}` : 'SnapBoard 板件'
      }
      if (plate.kind === 'sample') {
        sampleSeq += 1
        return `SnapBoard 试样（先打印）${sampleTotal > 1 ? ` ${sampleSeq}` : ''}`
      }
      partSeq += 1
      return `SnapBoard 配件${partTotal > 1 ? ` ${partSeq}` : ''}`
    })
  })()
  const plateSettings = plates.map((plate, plateIndex) => `
  <plate>
    <metadata key="plater_id" value="${plate.index + 1}"/>
    <metadata key="plater_name" value="${escapeXml(plateNames[plateIndex])}"/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>${plate.instances.map(instance => `
    <model_instance>
      <metadata key="object_id" value="${instance.objectId}"/>
      <metadata key="instance_id" value="${instance.instanceId}"/>
      <metadata key="identify_id" value="${instance.identifyId}"/>
    </model_instance>`).join('')}
  </plate>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>${objectSettings}${plateSettings}
  <assemble/>
</config>`
}

const filamentArrayKeys = new Set([
  'nozzle_temperature', 'nozzle_temperature_initial_layer',
  'nozzle_temperature_range_low', 'nozzle_temperature_range_high',
  'bed_temperature', 'bed_temperature_initial_layer',
  'activate_air_filtration', 'additional_cooling_fan_speed',
  'chamber_temperatures', 'close_fan_the_first_x_layers',
  'complete_print_exhaust_fan_speed', 'cool_plate_temp',
  'cool_plate_temp_initial_layer', 'during_print_exhaust_fan_speed',
  'eng_plate_temp', 'eng_plate_temp_initial_layer',
  'fan_cooling_layer_time', 'fan_max_speed', 'fan_min_speed',
  'hot_plate_temp', 'hot_plate_temp_initial_layer',
  'textured_plate_temp', 'textured_plate_temp_initial_layer',
  'supertack_plate_temp', 'supertack_plate_temp_initial_layer',
])

export function bambuProjectSettingsJson(cfg: SplitConfig, filamentColors: string[], texture?: BoardTextureConfig, firstLayerHeight?: number): string {
  const printer = getBambuPrinterPreset(cfg.printerPreset)
  const manufacturing = { ...createDefaultBoardTexture(), ...texture }
  const isWoodGrain = manufacturing.enabled && manufacturing.surfaceMode === 'woodgrain'
  const settings = selectedBambuProjectTemplate(cfg)
  const colors = filamentColors.length ? filamentColors : ['#3EC6B0']
  for (const [key, value] of Object.entries(settings)) {
    if (Array.isArray(value) && value.length && (key.startsWith('filament_') || filamentArrayKeys.has(key))) {
      settings[key] = Array.from({ length: colors.length }, () => value[0])
    }
  }

  settings.version = isWoodGrain ? '02.08.02.60' : BAMBU_COMPAT_VERSION
  settings.name = 'project_settings'
  settings.from = 'project'
  settings.filament_colour = colors
  settings.filament_multi_colour = colors
  settings.default_filament_colour = colors
  // Bambu 2.8 validates this against filament_extruder_variant before loading geometry.
  // Missing indices inherit [1] from FullPrintConfig, which rejects a two-filament project.
  settings.filament_self_index = colors.map((_, index) => String(index + 1))
  settings.filament_settings_id = [Array.isArray(settings.filament_settings_id) ? settings.filament_settings_id[0] : 'Generic PLA']
  // 全局采用洞洞板基材的常规 PETG 工艺；仅 1mm 表层在 model_settings 中覆盖为 SnapColor 慢速/实心参数。
  settings.layer_height = '0.28'
  if (!isWoodGrain) settings.line_width = '0.42'
  settings.initial_layer_print_height = manufacturing.enabled && manufacturing.surfaceMode === 'snapcolor' &&
    (manufacturing.surfaceFinish === 'textured-pei' || manufacturing.backEnabled)
    ? '0.08'
    : manufacturing.enabled && manufacturing.surfaceMode === 'veneer' && veneerPrintProfile(manufacturing).goal !== 'standard'
      ? String(veneerPrintProfile(manufacturing).layerHeight)
      : '0.25'
  settings.wall_loops = '2'
  settings.top_shell_layers = '3'
  settings.bottom_shell_layers = '3'
  settings.top_shell_thickness = '0.6'
  settings.bottom_shell_thickness = '0.6'
  settings.sparse_infill_density = `${Math.round(manufacturing.baseInfillDensity)}%`
  settings.sparse_infill_pattern = Math.round(manufacturing.baseInfillDensity) === 100 ? 'zig-zag' : 'gyroid'
  settings.fuzzy_skin = 'none'
  // Keep slow first-layer adhesion and colour detail, then use distinct wall/fill speeds.
  for(const key of ['outer_wall_speed','inner_wall_speed','sparse_infill_speed','internal_solid_infill_speed','top_surface_speed'] as const)
    settings[key]=colors.map(()=>BULK_PETG_PRINT_SETTINGS[key])
  settings.initial_layer_speed=colors.map(()=>'30')
  settings.initial_layer_infill_speed=colors.map(()=>manufacturing.enabled&&manufacturing.surfaceMode==='snapcolor'?'80':'50')
  settings.curr_bed_type = 'Textured PEI Plate'
  // 洞洞板与 SnapColor 彩色光学层统一按 PETG 制造；不能继承模板中的 PLA 温度/材料标记。
  settings.filament_type = colors.map(() => 'PETG')
  settings.filament_vendor = colors.map((_, index) => manufacturing.enabled && manufacturing.surfaceMode === 'veneer' && index === 1
    ? veneerPrintProfile(manufacturing).vendor : 'Generic')
  settings.filament_density = colors.map(() => '1.28')
  settings.filament_flow_ratio = colors.map(() => '0.95')
  settings.filament_max_volumetric_speed = colors.map(() => '21')
  settings.nozzle_temperature = colors.map(() => '245')
  settings.nozzle_temperature_initial_layer = colors.map(() => '230')
  settings.nozzle_temperature_range_low = colors.map(() => '230')
  settings.nozzle_temperature_range_high = colors.map(() => '270')
  settings.textured_plate_temp = colors.map(() => '70')
  settings.textured_plate_temp_initial_layer = colors.map(() => '70')
  settings.hot_plate_temp = colors.map(() => '70')
  settings.hot_plate_temp_initial_layer = colors.map(() => '70')
  settings.eng_plate_temp = colors.map(() => '70')
  settings.eng_plate_temp_initial_layer = colors.map(() => '70')
  if (manufacturing.enabled && manufacturing.surfaceMode === 'veneer' && colors.length > 1) {
    const profile = veneerPrintProfile(manufacturing)
    ;(settings.nozzle_temperature as string[])[1] = String(profile.nozzleTempC)
    ;(settings.nozzle_temperature_initial_layer as string[])[1] = String(profile.nozzleTempC)
    ;(settings.filament_flow_ratio as string[])[1] = String(profile.flowRatio)
    ;(settings.filament_max_volumetric_speed as string[])[1] = String(profile.maxFlowMm3s)
    if (profile.fanPercent !== undefined) {
      ;(settings.fan_min_speed as string[])[1] = String(profile.fanPercent)
      ;(settings.fan_max_speed as string[])[1] = String(profile.fanPercent)
    }
  }
  settings.single_extruder_multi_material = colors.length > 1 ? '1' : '0'
  settings.enable_prime_tower = '0'
  settings.printer_model = printer.model
  settings.printer_settings_id = printer.profile
  settings.print_compatible_printers = [printer.profile]
  settings.print_settings_id = printer.defaultPrintProfile
  settings.filament_settings_id = colors.map(() => printer.defaultFilamentProfile)
  settings.printable_height = String(printer.printableHeight)
  settings.nozzle_diameter = Array.from({ length: printer.extruderCount ?? 1 }, () => '0.4')
  settings.printable_area = [`0x0`, `${number(cfg.bedW)}x0`, `${number(cfg.bedW)}x${number(cfg.bedH)}`, `0x${number(cfg.bedH)}`]
  settings.extruder_printable_area = printer.extruderPrintableArea ?? [`0x0,${number(cfg.bedW)}x0,${number(cfg.bedW)}x${number(cfg.bedH)},0x${number(cfg.bedH)}`]
  settings.bed_exclude_area = getEnabledKeepouts(cfg).flatMap(zone => [
    `${number(zone.x)}x${number(zone.y)}`,
    `${number(zone.x + zone.w)}x${number(zone.y)}`,
    `${number(zone.x + zone.w)}x${number(zone.y + zone.h)}`,
    `${number(zone.x)}x${number(zone.y + zone.h)}`,
  ])
  settings.wrapping_exclude_area = []
  if (isWoodGrain) {
    const wood = normalizeWoodGrain(manufacturing.woodGrain)
    // This selected machine option is resolved by the GUI, not stored in the profile's inheritance chain.
    settings.nozzle_volume_type = structuredClone(settings.default_nozzle_volume_type)
    // Resource presets may leave this nullable vector empty. A project must supply
    // one height per physical extruder before Bambu's indexed option reads.
    const heights = settings.extruder_printable_height as string[]
    if (!heights.length) settings.extruder_printable_height = Array.from({ length: printer.extruderCount ?? 1 }, () => String(printer.printableHeight))
    // The cheap substrate retains its ordinary global process; fine wood paths are confined to the veneer part and height range.
    settings.initial_layer_print_height = '0.2'
    settings.filament_type = colors.map(() => wood.filamentType)
    settings.filament_settings_id = colors.map(() => wood.filamentType === 'PLA'
      ? (settings.default_filament_profile as string[])[0] : printer.defaultFilamentProfile)
    settings.filament_map = colors.map(() => '1')
    settings.filament_volume_map = colors.map(() => '0')
    settings.filament_nozzle_map = colors.map(() => '0')
    // Process speeds are indexed by nozzle variant, independently of the material slots.
    for (const key of ['outer_wall_speed', 'inner_wall_speed', 'sparse_infill_speed', 'internal_solid_infill_speed', 'top_surface_speed', 'initial_layer_speed', 'initial_layer_infill_speed']) {
      const values = settings[key]
      if (Array.isArray(values)) settings[key] = Array.from({ length: (settings.print_extruder_variant as string[]).length }, () => values[0])
    }
    // Preserve our recipe when Bambu refreshes the matching system presets on import.
    settings.different_settings_to_system = [
      'layer_height;initial_layer_print_height;wall_loops;top_shell_layers;bottom_shell_layers;top_shell_thickness;bottom_shell_thickness;sparse_infill_density;sparse_infill_pattern;fuzzy_skin;enable_prime_tower;outer_wall_speed;inner_wall_speed;sparse_infill_speed;internal_solid_infill_speed;top_surface_speed;initial_layer_speed;initial_layer_infill_speed',
      ...colors.map(() => 'filament_type;filament_vendor;filament_density;filament_flow_ratio;filament_max_volumetric_speed;nozzle_temperature;nozzle_temperature_initial_layer;nozzle_temperature_range_low;nozzle_temperature_range_high;textured_plate_temp;textured_plate_temp_initial_layer;hot_plate_temp;hot_plate_temp_initial_layer;eng_plate_temp;eng_plate_temp_initial_layer'),
      'printable_area;printable_height;extruder_printable_area;extruder_printable_height;bed_exclude_area;wrapping_exclude_area',
    ]
    if (wood.filamentType === 'PLA') {
      // Bambu PLA Basic @base; keep its identity consistent with the selected
      // PLA inheritance instead of retaining the PETG HF template's GFG02.
      settings.filament_id = 'GFA00'
      for (const key of ['nozzle_temperature', 'nozzle_temperature_initial_layer']) settings[key] = colors.map(() => '210')
      settings.nozzle_temperature_range_low = colors.map(() => '190')
      settings.nozzle_temperature_range_high = colors.map(() => '230')
      settings.filament_density = colors.map(() => '1.24')
      settings.filament_flow_ratio = colors.map(() => '1')
      for (const key of ['textured_plate_temp', 'textured_plate_temp_initial_layer', 'hot_plate_temp', 'hot_plate_temp_initial_layer']) settings[key] = colors.map(() => '55')
    }
  }
  if (firstLayerHeight !== undefined) settings.initial_layer_print_height = number(firstLayerHeight)
  return finalizeBambuProjectProfile(settings, cfg, colors)
}

function bambuSliceInfoXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${BAMBU_COMPAT_VERSION}"/>
  </header>
</config>`
}

function bambuFilamentSequenceJson(plates: BuildPlate[]): string {
  return JSON.stringify(Object.fromEntries(plates.map(plate => [
    `plate_${plate.index + 1}`,
    { sequence: [] },
  ])))
}

function bambuCutInformationXml(objects: ManufacturingObject[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<objects>${objects.map((_, index) => `
  <object id="${rootObjectId(objects, index)}">
    <cut_id id="0" check_sum="1" connectors_cnt="0"/>
  </object>`).join('')}
</objects>`
}

/** 防止生成会触发切片器越界的盘号/实例映射。Bambu 的 plater_id 是严格的 1..N。 */
function validateBambuPlateLayout(objects: ManufacturingObject[], plates: BuildPlate[]): void {
  if (!plates.length) throw new Error('3MF 没有生成任何热床')
  const instanceKeys = new Set<string>()
  const identifyIds = new Set<number>()
  const partCount = objects.reduce((sum, object) => sum + object.parts.length, 0)
  plates.forEach((plate, plateIndex) => {
    if (plate.index !== plateIndex || !plate.instances.length) {
      throw new Error(`3MF 第 ${plateIndex + 1} 盘的索引或实例为空`)
    }
    for (const instance of plate.instances) {
      if (instance.plate !== plateIndex || instance.objectId <= partCount || instance.objectId > partCount + objects.length) {
        throw new Error(`3MF 第 ${plateIndex + 1} 盘包含无效对象引用`)
      }
      const key = `${instance.objectId}:${instance.instanceId}`
      if (instanceKeys.has(key) || identifyIds.has(instance.identifyId) || instance.identifyId < 1) {
        throw new Error(`3MF 包含重复的对象实例标识：${key}`)
      }
      instanceKeys.add(key)
      identifyIds.add(instance.identifyId)
    }
  })
  const expected = objects.reduce((sum, object) => sum + object.quantity, 0)
  if (instanceKeys.size !== expected) throw new Error(`3MF 实例数量不一致：应为 ${expected}，实际 ${instanceKeys.size}`)
}

async function resolvePartDefinitions(provided?: PartDefinition[]): Promise<PartDefinition[]> {
  if (provided) return provided
  const response = await fetch('/partLibrary/index.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`配件库读取失败 (HTTP ${response.status})`)
  return ((await response.json()) as PartLibraryIndex).parts ?? []
}

function partAssetUrl(asset: string): string {
  if (/^https?:\/\//i.test(asset)) return asset
  const relative = asset.startsWith('/partLibrary/') ? asset : `/partLibrary/${asset.replace(/^\/+/, '')}`
  return new URL(relative, globalThis.location?.origin ?? 'http://localhost:5173').href
}

async function createManufacturingObjects(input: Manufacturing3MFInput): Promise<{
  objects: ManufacturingObject[]
  warnings: string[]
  markingPlan: AssemblyMarkPlan | null
  markingRequestedCount: number
  markingAppliedCount: number
  samples: TextureSample[] | null
  orderSideCuts?: ReturnType<typeof orderSideEngravings>
  contourReports: TextureContourReport[]
  textureSamplingDiagnostics: { gridPitchMm: number; canvas: [number, number]; canvasPitchMm: [number, number]; recipeSource: string; manufacturingBudget: ManufacturingBudget; timings: { vectorRegionsMs: number; textureContextMs: number; boardGeometryMs: number } } | null
}> {
  const objects = new Map<string, ManufacturingObject>()
  const warnings: string[] = []
  if (input.panels.some(panel => panel.latticeFace && !isPlainRetainedFront(panel)) && input.boardTexture?.enabled && hasBoardTextureSource(input.boardTexture))
    throw new Error('贴墙线稿保真暂不能与纹理工作室叠加导出；请关闭纹理后导出，或先移除图案保真')
  if (input.textureSampling && input.boardTexture?.backEnabled) throw new Error('双面映射的颜色试样尚未校准，请先导出小板件检查正反面')
  if (input.textureSampling && (!input.boardTexture?.enabled || !input.panels.length)) throw new Error('请先为板件启用叠色或纹理层，再导出试样')
  const samples=input.textureSampling ? planTextureSamples(input.panels,input.cfg,input.textureSampling) : null
  const doubleSided = Boolean(input.boardTexture?.enabled && input.boardTexture.backEnabled && !samples)
  if(samples)for(const sample of samples)if(sample.boundaryReliefMm)warnings.push(`${sample.panel.id} 孔与裁边相切，已局部减材退让 ${sample.boundaryReliefMm}mm 以形成闭合边界；取样位置不变。`)
  const panels=samples ? samples.map(sample=>sample.panel) : input.panels
  if(samples) warnings.push('试样保留原比例叠色/贴面并去除结构基材；背面增加0.24mm凸刻编号，彩色面朝向热床打印。无原承托时补0.24mm薄承托。完整原板不变。')
  const markingConfig = input.assemblyMarking && !samples
    ? normalizeAssemblyMarking(input.assemblyMarking)
    : { ...createDefaultAssemblyMarking(), enabled: false }
  const sideNumber = input.orderEngraving?.orderNumber ?? markingConfig.orderSideNumber
  if (input.orderEngraving && markingConfig.orderSideNumber && markingConfig.orderSideNumber !== input.orderEngraving.orderNumber)
    throw new Error('模型上的侧刻订单号与关联生产订单不一致，请选择同一订单后再导出')
  if(sideNumber && markingConfig.sideLogoEnabled)markingConfig.sideLogoEnabled=false
  const fullMarkingPanels = input.markingPanels ?? input.panels
  const woodConfig = input.boardTexture?.enabled && input.boardTexture.surfaceMode === 'woodgrain'
    ? normalizeWoodGrain(input.boardTexture.woodGrain) : null
  const woodBounds = input.textureBounds ?? getSplitPanelTextureBounds(fullMarkingPanels)
  const backRequested = isBackEngravingEnabled(markingConfig, input.boardTexture)
  if (doubleSided && backRequested && !markingConfig.reserveBackMarking) {
    const requested = buildAssemblyMarkPlan(fullMarkingPanels, input.cfg, { ...markingConfig, includeBrand: false, includeKitCode: false }, input.projectName)
    if (requested.panels.some(panel => panel.engravingPolygons.length)) throw new Error('双面背面凹刻需要先启用标识留白区；已停止导出以保留背图')
  }
  const markingPlan = buildSurfaceMarkingPlan(fullMarkingPanels, input.cfg, markingConfig, input.boardTexture, input.projectName)
  warnings.push(...markingPlan.warnings)
  const markingRequestedCount = backRequested ? input.panels.filter(panel => !isThroughLatticePanel(panel)).length : 0
  let markingAppliedCount = 0
  input.onProgress?.('正在准备 SnapColor 纹理与板件掩膜…', 0.03)
  const textureContextStarted = performance.now()
  const retained = input.panels.some(isPlainRetainedFront)
  const textureContext = await createTextureManufacturingContext(retained ? { ...input,
    panels: input.panels.map(panel => isPlainRetainedFront(panel) ? { ...panel, latticeFace: undefined, latticeCutouts: undefined } : panel) } : input)
  const backTextureContext = await createBackTextureManufacturingContext(retained ? { ...input,
    panels: input.panels.map(panel => isPlainRetainedFront(panel) ? { ...panel, latticeFace: undefined } : panel) } : input)
  // Explicit front-up decorative recipes cannot also print a rear cavity on the bed.
  const frontUpRecipe = woodConfig || textureContext && textureContext.config.surfaceFinish !== 'textured-pei'
  if (!samples && frontUpRecipe && input.panels.some(panel => !panel.latticeFace && markingPlan.panels.some(mark =>
    mark.sourcePanelId === panel.id && (mark.engravingPolygons.length || mark.numberMark?.polygons.length))))
    throw new Error(woodConfig
      ? '木纹工艺保持正面朝上；背面装配凹刻不能放在热床底面。请关闭背面装配凹刻后导出，订单号仍会侧刻。'
      : '当前工艺选择了正面朝上，背面装配凹刻会落到热床底面。请选择正面朝下的打印方式，或关闭背面装配凹刻；订单号仍会侧刻。')
  if (backTextureContext) warnings.push('双面彩印的朝上表面沿用当前耗材档案；顶面颜色与层间结合仍需实物小板校准。')
  if (backTextureContext && textureContext &&
      input.cfg.thickness - textureContext.textureThickness - backTextureContext.textureThickness < 2.5) {
    throw new Error('双面彩印后结构芯不足 2.5 mm；请增加板厚或减薄两面彩色层')
  }
  const textureContextMs = performance.now() - textureContextStarted
  if (textureContext?.vectorRegions && !textureContext.vectorRegions.eligible) {
    pushUniqueWarning(warnings, `SVG 使用图片轮廓流程：${textureContext.vectorRegions.reason}`)
  }
  if(samples && !textureContext) throw new Error('纹理上下文不可用，已停止抽样导出，避免生成无颜色的试样')
  let orderSideCuts: ReturnType<typeof orderSideEngravings> | undefined
  if (input.orderEngraving && input.orderInstance && !samples) {
    const panel = input.panels[0], instance = input.orderInstance
    validateOrderPanel(instance, panel)
    orderSideCuts = orderSideEngravings(panel, input.cfg, input.orderEngraving, instance, markingConfig)
    if (orderSideCuts[0]?.surface === 'side') {
      // Reserve this edge for the complete order number. Back assembly marks
      // remain independent; the stored branding preferences are unchanged.
      if (markingConfig.sideLogoEnabled) warnings.push(`${instance.panelCode} 侧壁用于完整订单追溯码，附加品牌未重复刻在同一位置。`)
      markingConfig.sideLogoEnabled = false
    }
  }
  input.onProgress?.('纹理预处理完成，开始生成板件…', 0.1)
  // 方案 §5.D：把各阶段耗时写进导出报告，"导出变快没变快"才有据可查。
  const geometryStarted = performance.now()
  for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
    throwIfExportAborted(input.signal)
    const panel = panels[panelIndex]
    const sourcePanel=samples ? input.panels[samples[panelIndex].sourcePanelIndex] : undefined
    const panelStart = 0.1 + panelIndex / Math.max(1, input.panels.length) * 0.62
    const panelSpan = 0.62 / Math.max(1, input.panels.length)
    const markIndex=fullMarkingPanels.findIndex(p=>p.id===panel.id&&p.x===panel.x&&p.y===panel.y&&p.w===panel.w&&p.h===panel.h)
    const panelMarkPlan = markingPlan?.panels.find(plan => plan.panelIndex===markIndex)
    const markSignature = assemblyMarkPlanSignature(panelMarkPlan, markingConfig)
    const manufacturingPanelId = panelMarkPlan?.panelId ?? panel.id.toUpperCase()
    input.onProgress?.(`正在生成第 ${panelIndex + 1}/${input.panels.length} 块板的制造网格…`, panelStart)
    const key = woodConfig
      ? `panel-wood-veneer:${panel.id}:${panel.x}:${panel.y}:${panelSignature(panel, input.cfg)}:mark:${markSignature}`
      : textureContext
      ? `panel-textured:${panel.id}:${panel.x}:${panel.y}:${panelSignature(panel, input.cfg)}:mark:${markSignature}:back:${!!backTextureContext}`
      : `panel:${panelSignature(panel, input.cfg)}:mark:${markSignature}`
    const existing = objects.get(key)
    if (existing) {
      existing.quantity++
      continue
    }
    if (panel.latticeFace) {
      if (isPlainRetainedFront(panel) && textureContext) {
        const face = currentSvgFace(panel, input.cfg)
        const retainedMm = face.source!.options.backingMm
        if (textureContext.textureThickness > retainedMm + 1e-6)
          throw new Error(`${manufacturingPanelId} 彩色层需要 ${textureContext.textureThickness.toFixed(2)}mm，请将正面保留厚度调至至少此值`)
        const coreMin = backTextureContext?.textureThickness ?? 0
        const coreMax = textureContext.structuralThickness
        const core = { ...face, layers: face.layers.map(layer => ({ ...layer,
          zMin: Math.max(layer.zMin, coreMin), zMax: Math.min(layer.zMax, coreMax),
        })).filter(layer => layer.zMax - layer.zMin > 1e-6) }
        const parts: ManufacturingPart[] = (await extrudeLatticeFace(core,undefined,undefined,false,face)).map(({ data, role }) => {
          const name = `${manufacturingPanelId} · ${role === 'structure' ? '背部连筋骨架' : '正面薄层承托'}`
          const mesh: PrintableMesh = { name, vertices: [], triangles: [] }
          for (let i = 0; i < data.vertices.length; i += 3) mesh.vertices.push([
            round6(data.vertices[i] - panel.x), round6(data.vertices[i + 1] - panel.y), round6(data.vertices[i + 2]),
          ])
          for (let i = 0; i < data.triangles.length; i += 3) mesh.triangles.push(data.triangles.slice(i, i + 3) as [number, number, number])
          validateClosedMesh(name, mesh.triangles)
          return { name, mesh, extruder: 1, color: textureContext.config.baseColor,
            settings:role==='structure'?latticeCoreSettings(panel,textureContext.config):backingPartSettings() }
        })
        const corePartCount=parts.length
        // Front colors cover the whole retained face; rear colors follow only the skeleton.
        const frontPanel = { ...panel, latticeFace: undefined, latticeCutouts: undefined }
        parts.push(...await createPanelTextureParts(frontPanel, input.cfg, textureContext, input.signal, undefined, warnings))
        if (backTextureContext) {
          const backParts = await createPanelTextureParts({ ...panel, latticeFace: undefined }, input.cfg, backTextureContext, input.signal, undefined, warnings)
          mirrorThinLayerToBack(backParts, input.cfg.thickness)
          parts.push(...backParts)
        }
        const surfaceParts=parts.slice(corePartCount)
        await clipLatticeTextureMeshes(surfaceParts.map(part=>part.mesh),face,[panel.x,panel.y])
        for(const part of surfaceParts)if(part.mesh.triangles.length)validateClosedMesh(part.name,part.mesh.triangles)
        for(let i=parts.length-1;i>=corePartCount;i--)if(!parts[i].mesh.triangles.length)parts.splice(i,1)
        const numberLocation=await applyPhysicalNumber(parts,panel,input.cfg,panelMarkPlan,markingConfig,warnings)
        if(numberLocation==='back')markingAppliedCount++
        flipCompositePanelFaceDown(parts, input.cfg.thickness, panel.w)
        const mesh: PrintableMesh = { name: manufacturingPanelId, vertices: [], triangles: [] }
        for (const part of parts) appendPrintableMesh(mesh, part.mesh)
        objects.set(key, { key, name: `${manufacturingPanelId} · 保留${retainedMm.toFixed(1)}mm图案正面 · 背面镂空（正面朝下）`,
          mesh, parts, preferredRotation: panel.printRotation ?? 0, quantity: 1, kind: 'panel', sourcePanel:panel, frontOnBed:true,backMarkingApplied: numberLocation==='back',numberLocation,numberId:numberLocation?manufacturingPanelId:undefined })
        continue
      }
      const faceBaseColor = panel.latticeFace.source?.options.sourceLayerId ? input.boardTexture?.baseColor ?? '#3EC6B0' : '#3EC6B0'
      const drawing = panel.latticeFace.layers.some(layer => layer.role === 'detail')
      const retainedMm = panel.latticeFace.source?.options.backingMm
      const faceLabel = drawing ? '线稿保真' : `保留${retainedMm?.toFixed(1) ?? ''}mm正面 · 背面镂空`
      const parts: ManufacturingPart[] = (await extrudeLatticeFace(panel.latticeFace, panel, input.cfg)).map(({ data, role, contrastColor }) => {
          const name = `${manufacturingPanelId} · ${{ structure: panel.latticeFace!.source?.templateStyle==='ribs'?'一体筋架与底面':'背部连筋骨架', backing: '局部细节托底',
            face: '正面底色', detail: panel.latticeFace!.contrastColor ? '双色镶嵌线稿' : '凹刻线稿' }[role] ?? role}`
          const mesh: PrintableMesh = { name, vertices: [], triangles: [] }
          for (let i = 0; i < data.vertices.length; i += 3) mesh.vertices.push([
            round6(data.vertices[i] - panel.x), round6(data.vertices[i + 1] - panel.y), round6(data.vertices[i + 2]),
          ])
          for (let i = 0; i < data.triangles.length; i += 3) mesh.triangles.push(data.triangles.slice(i, i + 3) as [number, number, number])
          validateClosedMesh(name, mesh.triangles)
          return { name, mesh, extruder: role === 'detail' && contrastColor ? 2 : 1,
            color: role === 'detail' ? contrastColor ?? faceBaseColor : faceBaseColor,
            settings: { ...(role==='structure'?latticeCoreSettings(panel,input.boardTexture??createDefaultBoardTexture()):role==='detail'?surfacePartSettings(.2):role==='face'?backingPartSettings(false):backingPartSettings()), outer_wall_line_width: '0.42',
              inner_wall_line_width: '0.42', top_surface_line_width: role==='backing'?'0.8':'0.42' } }
        })
      const numberLocation=await applyPhysicalNumber(parts,panel,input.cfg,panelMarkPlan,markingConfig,warnings)
        if(numberLocation==='back')markingAppliedCount++
        flipCompositePanelFaceDown(parts, input.cfg.thickness, panel.w)
      const mesh: PrintableMesh = { name: manufacturingPanelId, vertices: [], triangles: [] }
      for (const part of parts) appendPrintableMesh(mesh, part.mesh)
      objects.set(key, { key, name: `${manufacturingPanelId} · ${faceLabel}（正面朝下）`, mesh, parts,
        preferredRotation: panel.printRotation ?? 0, quantity: 1, kind: 'panel', sourcePanel:panel, frontOnBed:true,backMarkingApplied: numberLocation==='back',numberLocation,numberId:numberLocation?manufacturingPanelId:undefined })
      pushUniqueWarning(warnings, drawing
        ? '线稿保真使用薄底，双色为平齐镶嵌、单色为0.2mm凹刻；正面朝下打印，双色细节需配置第二料槽。'
        : `背面镂空保留 ${retainedMm?.toFixed(1)}mm 连续正面，功能孔贯通；正面朝下打印。`)
      pushUniqueWarning(warnings, '外露边采用受筋宽限制的倒角/圆角，筋根保留加强过渡；几何减材不代表承重额定值或实际切片耗料。')
      continue
    }
    if (woodConfig) {
      const texture = input.boardTexture!, depths = woodGrainVeneerDepth(input.cfg.thickness, texture.textureThickness)
      let base: PrintableMesh, markingApplied = false
      try {
        if (panelMarkPlan?.engravingPolygons.length) {
          base = await createBackEngravedBase(panel, input.cfg, depths.base, markingConfig, panelMarkPlan, warnings, false)
          markingApplied = true
        } else base = createBottomBeveledBase(panel, input.cfg, depths.base, warnings)
      } catch (error) {
        warnings.push(`${manufacturingPanelId} 背面标识生成失败，已保留无标识基材：${error instanceof Error ? error.message : String(error)}`)
        base = createBottomBeveledBase(panel, input.cfg, depths.base, warnings)
      }
      if (markingApplied) markingAppliedCount++
      const veneer = createOneSidedBeveledLayer(panel, input.cfg, depths.base, depths.surface, 'top', `${manufacturingPanelId}-wood-veneer`, warnings)
      const parts: ManufacturingPart[] = [
        { name:`${manufacturingPanelId} · ${texture.baseMaterialName} · 结构基材 ${depths.base.toFixed(2)}mm`,
          mesh:base,extruder:1,color:texture.baseColor,settings:latticeCoreSettings(panel,texture) },
        { name:`${manufacturingPanelId} · ${texture.surfaceMaterialName} · 木纹质感贴面 ${depths.surface.toFixed(2)}mm`,
          mesh:veneer,extruder:2,color:texture.surfaceColor,settings:woodGrainPartSettings(woodConfig) },
      ]
      input.onProgress?.(`正在生成 ${manufacturingPanelId} 表层木纹分区…`,panelStart+panelSpan*.8)
      const modifier = await woodGrainModifier(panel,input.cfg,woodConfig,woodBounds,input.signal,depths.surface)
      if (modifier.mesh) {
        const grain:PrintableMesh={name:`${manufacturingPanelId}-wood-surface-modifier`,vertices:[],triangles:[]}
        for(let i=0;i<modifier.mesh.vertices.length;i+=3)grain.vertices.push(modifier.mesh.vertices.slice(i,i+3) as [number,number,number])
        for(let i=0;i<modifier.mesh.triangles.length;i+=3)grain.triangles.push(modifier.mesh.triangles.slice(i,i+3) as [number,number,number])
        parts.push({name:`${manufacturingPanelId} · 仅木纹贴面的走线修改器`,mesh:grain,subtype:'modifier_part',
          extruder:2,color:texture.surfaceColor,settings:woodGrainPartSettings(woodConfig,true)})
      } else warnings.push(`${manufacturingPanelId} 的表面没有可用木纹分区，请调整纹距或位置`)
      const sideLogoEngraved = markingConfig.enabled && markingConfig.sideLogoEnabled
        ? await engraveSideLogoMeshes([base,veneer],panel,input.cfg,markingConfig.brand,markingConfig.sideDepth??.24,markingConfig.sideTextHeight??3.5) : false
      const numberLocation=panelMarkPlan?.numberMark?.surface!=='back'
        ?await applyPhysicalNumber(parts,panel,input.cfg,panelMarkPlan,markingConfig,warnings):markingApplied?'back':undefined
      objects.set(key,{key,name:`${manufacturingPanelId} · 普通基材 + 薄木纹贴面`,mesh:base,parts,
        preferredRotation:panel.printRotation??0,quantity:1,kind:'panel',sourcePanel:panel,frontOnBed:false,backMarkingApplied:markingApplied,sideLogoEngraved,
        numberLocation,numberId:numberLocation?manufacturingPanelId:undefined})
      continue
    }
    if (textureContext) {
      let mesh: PrintableMesh | null = null
      let markingApplied = false
      let sideLogoEngraved = false
      const parts: ManufacturingPart[] = []
      if (!sourcePanel) {
        try {
          if (backTextureContext) {
            mesh = createPanelPrismMesh(panel, input.cfg, backTextureContext.textureThickness,
              input.cfg.thickness - textureContext.textureThickness - backTextureContext.textureThickness,
              `${panel.id}-dual-side-structural-core`)
          } else if (panelMarkPlan?.engravingPolygons.length) {
            mesh = await createBackEngravedBase(panel, input.cfg, textureContext.structuralThickness, markingConfig, panelMarkPlan, warnings, false)
            markingApplied = true
          } else mesh = createBottomBeveledBase(panel, input.cfg, textureContext.structuralThickness, warnings)
        } catch (error) {
          warnings.push(`${manufacturingPanelId} 背面标识网格生成失败，已安全回退为无标识基材：${error instanceof Error ? error.message : String(error)}`)
          mesh = backTextureContext
            ? createPanelPrismMesh(panel, input.cfg, backTextureContext.textureThickness,
              input.cfg.thickness - textureContext.textureThickness - backTextureContext.textureThickness,
              `${panel.id}-dual-side-structural-core`)
            : createBottomBeveledBase(panel, input.cfg, textureContext.structuralThickness, warnings)
        }
        if (markingApplied) markingAppliedCount++
        parts.push({
          name: `${manufacturingPanelId} · ${textureContext.config.baseMaterialName} · 结构基材 ${(backTextureContext
            ? input.cfg.thickness - textureContext.textureThickness - backTextureContext.textureThickness
            : textureContext.structuralThickness).toFixed(1)}mm${markingApplied ? ' · 背面凹刻' : ''}`,
          mesh, extruder: 1, color: textureContext.config.baseColor,
          settings: latticeCoreSettings(panel,textureContext.config),
        })
      }
      const textureParts = await createPanelTextureParts(panel, input.cfg, textureContext, input.signal, fraction => {
        input.onProgress?.(`正在生成第 ${panelIndex + 1}/${input.panels.length} 块板的正面光学层…`,
          panelStart + panelSpan * (backTextureContext ? 0.5 : 1) * fraction)
      }, warnings, sourcePanel)
      for (const texturePart of textureParts) {
        if (backTextureContext) texturePart.name = `${manufacturingPanelId} · 正面 · ${texturePart.name}`
        parts.push(texturePart)
      }
      if (backTextureContext && !sourcePanel) {
        const backParts = await createPanelTextureParts(panel, input.cfg, backTextureContext,
          input.signal, fraction => input.onProgress?.(`正在生成第 ${panelIndex + 1}/${input.panels.length} 块板的背面光学层…`,
            panelStart + panelSpan * (0.5 + 0.5 * fraction)), warnings)
        if (!backParts.length) throw new Error(`${manufacturingPanelId} 背面没有生成有效彩色网格`)
        mirrorThinLayerToBack(backParts, input.cfg.thickness)
        for (const part of backParts) { part.name = `${manufacturingPanelId} · 背面 · ${part.name}`; parts.push(part) }
        if (backRequested && panelMarkPlan?.engravingPolygons.length) {
          const depth = Math.min(markingConfig.depth, backTextureContext.textureThickness - 0.12)
          markingApplied = await engraveBackMarkMeshes(parts.map(part => part.mesh), panel, panelMarkPlan.engravingPolygons, depth)
          if (!markingApplied) throw new Error(manufacturingPanelId + ' 背面凹刻没有生成有效凹槽')
          markingAppliedCount++
        }
      }
      if (!sourcePanel && markingConfig.enabled && markingConfig.sideLogoEnabled) {
        sideLogoEngraved = await engraveSideLogoMeshes(parts.map(part => part.mesh), panel, input.cfg,
          markingConfig.brand, markingConfig.sideDepth ?? .24, markingConfig.sideTextHeight ?? 3.5)
        if (!sideLogoEngraved) warnings.push(manufacturingPanelId + ' 侧边空间不足，跳过凹刻')
      }
      const numberLocation=!sourcePanel&&panelMarkPlan?.numberMark?.surface!=='back'
        ?await applyPhysicalNumber(parts,panel,input.cfg,panelMarkPlan,markingConfig,warnings)
        :markingApplied&&panelMarkPlan?.numberMark?'back':undefined
      if(sourcePanel) {
        if(!parts.length) throw new Error(`第 ${panelIndex+1} 块板没有可导出的颜色或承托层`)
        for(const part of parts)for(const vertex of part.mesh.vertices)vertex[2]=round6(vertex[2]-textureContext.structuralThickness)
        const backingDepth = textureContext.config.surfaceMode === 'veneer'
          || textureContext.opticalStart - textureContext.structuralThickness > 0.001 ? 0 : 0.24
        if (backingDepth) {
          parts.unshift({
            name: `${panel.id} · 试样薄承托层 0.24mm`,
            mesh: createPanelPrismMesh(panel, input.cfg, -backingDepth, backingDepth, `${panel.id}-sample-number-backing`),
            extruder: textureParts[0].extruder,
            color: textureParts[0].color,
            settings: surfacePartSettings(0.08),
          })
        }
        const label = panel.id.toUpperCase()
        const numberMesh = createSampleBackNumber(panel, input.cfg, label)
        for (const vertex of numberMesh.vertices) vertex[2] = round6(vertex[2] - backingDepth - 0.24)
        parts.push({
          name: `${label} · 背面凸刻编号 0.24mm`, mesh: numberMesh,
          extruder: parts[0].extruder, color: parts[0].color,
          settings: surfacePartSettings(0.08),
        })
        // The optical face contacts the bed; the raised back ID prints on top.
        flipCompositePanelFaceDown(parts, textureContext.textureThickness, panel.w)
        mesh=parts[0].mesh
      }
      if (!textureParts.length) warnings.push(`${panel.id.toUpperCase()} 的表层没有生成有效制造网格`)
      if (!mesh) throw new Error(`${panel.id} 没有可用的试样或板件网格`)
      if (!sourcePanel && textureContext.config.surfaceFinish === 'textured-pei') flipCompositePanelFaceDown(parts, input.cfg.thickness, panel.w)
      objects.set(key, {
        key, name: `${manufacturingPanelId}${sourcePanel ? ` · 原板${panelIndex+1}局部试样` : ''} · ${panel.w.toFixed(0)}×${panel.h.toFixed(0)} 复合板件（整体移动）${backRequested && !markingApplied ? ' · 背面标识未写入' : ''}`, mesh, parts,
        preferredRotation: panel.printRotation ?? 0, quantity: 1, kind: 'panel', sourcePanel:panel, frontOnBed:sourcePanel?true:textureContext.config.surfaceFinish==='textured-pei',backMarkingApplied: markingApplied,
        sideLogoEngraved,numberLocation,numberId:numberLocation?manufacturingPanelId:undefined,
      })
      continue
    }
    let mesh: PrintableMesh
    let markingApplied = false
    try {
      if (panelMarkPlan?.engravingPolygons.length) {
        mesh = await createBackEngravedBase(panel, input.cfg, input.cfg.thickness, markingConfig, panelMarkPlan, warnings, true)
        markingApplied = true
      } else mesh = createAdaptiveChamferPanelMesh(panel, input.cfg, warnings)
    } catch (error) {
      warnings.push(`${manufacturingPanelId} 背面标识网格生成失败，已安全回退为无标识板件：${error instanceof Error ? error.message : String(error)}`)
      mesh = createAdaptiveChamferPanelMesh(panel, input.cfg, warnings)
    }
    if (markingApplied) markingAppliedCount++
    let sideLogoEngraved = false
    if (markingConfig.enabled && markingConfig.sideLogoEnabled) sideLogoEngraved = await engraveSideLogoMeshes([mesh], panel, input.cfg,
      markingConfig.brand, markingConfig.sideDepth ?? .24, markingConfig.sideTextHeight ?? 3.5)
    const plainParts: ManufacturingPart[] = [{
      name: `${manufacturingPanelId} · 结构基材 ${input.cfg.thickness.toFixed(1)}mm${markingApplied ? ' · 背面凹刻' : ''}`,
      mesh, extruder: 1, color: '#3EC6B0',
      settings: latticeCoreSettings(panel,{...createDefaultBoardTexture(),...input.boardTexture,enabled:false}),
    }]
    const numberLocation=panelMarkPlan?.numberMark?.surface!=='back'
      ?await applyPhysicalNumber(plainParts,panel,input.cfg,panelMarkPlan,markingConfig,warnings)
      :markingApplied?'back':undefined
    // Design back is Z=0. Rotate the entire plain plate so its front rests on
    // the bed and rear engraving is open upward, never bridged over the bed.
    flipCompositePanelFaceDown(plainParts,input.cfg.thickness,panel.w)
    objects.set(key, {
      key, name: `${manufacturingPanelId} · ${panel.w.toFixed(0)}×${panel.h.toFixed(0)} 板件（正面贴床 · 背面朝上）${backRequested && !markingApplied && !isThroughLatticePanel(panel) ? ' · 背面标识未写入' : ''}`, mesh,
      parts: plainParts,
      preferredRotation: panel.printRotation ?? 0, quantity: 1, kind: 'panel', sourcePanel:panel, frontOnBed:true,backMarkingApplied: markingApplied, sideLogoEngraved,numberLocation,numberId:numberLocation?manufacturingPanelId:undefined,
    })
  }

  if (input.placedParts.length && !samples) {
    input.onProgress?.('正在整理配件并计算独立热床…', 0.74)
    const definitions = await resolvePartDefinitions(input.partDefinitions)
    const byId = new Map(definitions.map(definition => [definition.id, definition]))
    const grouped = new Map<string, { instance: PlacedPart; quantity: number }>()
    for (const instance of input.placedParts) {
      const key = partSignature(instance)
      const group = grouped.get(key)
      if (group) group.quantity++
      else grouped.set(key, { instance, quantity: 1 })
    }
    for (const [signature, group] of grouped) {
      throwIfExportAborted(input.signal)
      const definition = byId.get(group.instance.defId)
      if (!definition) {
        warnings.push(`找不到配件定义：${group.instance.defId}`)
        continue
      }
      const asset = definition.model.print
      if (!asset) {
        warnings.push(`${definition.name} 没有制造模型，未写入 3MF`)
        continue
      }
      try {
        const source = await loadPrintablePartModel(partAssetUrl(asset), definition.model)
        const parameterized = new THREE.Group()
        parameterized.add(source)
        applyPartParams(parameterized, group.instance.params, definition.params)
        const root = orientPartForPrinting(parameterized, definition)
        try {
          const key = `part:${signature}`
          const mesh = normalizePrintableMesh(root, definition.name)
          objects.set(key, {
            key, name: definition.name, mesh,
            parts: [{ name: definition.name, mesh, extruder: 1, color: '#3EC6B0' }],
            preferredRotation: 0, quantity: group.quantity, kind: 'part',
          })
        } finally {
          disposeObject(root)
        }
      } catch (error) {
        warnings.push(`${definition.name} 导入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (sideNumber && !samples) {
    const cuts: ReturnType<typeof sideOrderNumberEngravings> = []
    for (const object of objects.values()) {
      if (object.kind !== 'panel' || !object.sourcePanel) continue
      const panel = object.sourcePanel
      const currentCuts = sideOrderNumberEngravings(panel,input.cfg,sideNumber,markingConfig,object.numberId??panel.id)
      const parts = object.parts.filter(part=>part.subtype!=='modifier_part')
      const cut=currentCuts[0]
      if (!await engraveSideTraceMeshes(parts.map(part=>part.mesh),panel,input.cfg,
        [{text:sideNumber,textHeightMm:cut.marks[0].textHeightMm!}],cut.depthMm,object.frontOnBed?input.cfg.thickness:undefined))
        throw new Error(`${panel.id} 完整订单号侧刻未形成有效减材`)
      cuts.push(...currentCuts);object.mesh=parts[0].mesh
      object.name+=` · 侧刻订单号 ${sideNumber}`
    }
    orderSideCuts=cuts
  }

  return { objects: [...objects.values()], warnings, markingPlan, markingRequestedCount, markingAppliedCount, samples, orderSideCuts, contourReports: textureContext?.contourReports ?? [],
    textureSamplingDiagnostics: textureContext ? {
      gridPitchMm: textureContext.samplePitch,
      canvas: [textureContext.canvas.width, textureContext.canvas.height],
      canvasPitchMm: [textureContext.bounds.width / textureContext.canvas.width, textureContext.bounds.height / textureContext.canvas.height],
      recipeSource: textureContext.recipeIds ? 'direct-palette-index' : 'canvas-color-lookup',
      // 方案 §5：预算随打印配置记录在报告里，不额外增加用户必须理解的滑块。
      manufacturingBudget: textureContext.budget,
      timings: {
        vectorRegionsMs: Math.round(textureContext.vectorRegionsMs),
        textureContextMs: Math.round(textureContextMs),
        boardGeometryMs: Math.round(performance.now() - geometryStarted),
      },
    } : null,
  }
}

function serializeAssemblyMap(plan: AssemblyMarkPlan): string {
  return JSON.stringify({
    format: 'snapboard-assembly-map',
    schemaVersion: 1,
    kitCode: plan.kitCode,
    seams: plan.seams,
    panels: plan.panels.map(panel => ({
      panelId: panel.panelId,
      sourcePanelId: panel.sourcePanelId,
      numberMark: panel.numberMark,
      marks: panel.marks.map(({ polygons: _polygons, ...mark }) => mark),
    })),
    warnings: plan.warnings,
  }, null, 2)
}

/** Large composition: serialize each physical layer into the final 3MF, then release its mesh. */
export async function createManufacturing3MFStreamed(input: Manufacturing3MFInput, toDisk = false): Promise<Manufacturing3MFSummary> {
  const budgetError = input.boardTexture && !input.nativeRecipeRaster && textureVectorBudgetError(input.boardTexture)
  if (budgetError) throw new Error(budgetError)
  if (input.orderEngraving || input.assemblyMarking?.orderSideNumber) return createManufacturing3MF({ ...input, outputMode: 'single' })
  if (input.textureSampling || input.boardTexture?.backEnabled || input.assemblyMarking?.sideLogoEnabled || !input.boardTexture?.enabled || input.boardTexture.surfaceMode !== 'snapcolor'
    || input.boardTexture.modelingMode === 'pixel' || input.boardTexture.manufacturingContours === false) {
    throw new Error('当前配置不支持逐层流式导出')
  }
  if (!input.panels.length) throw new Error('没有可导出的板件')
  if (toDisk && !navigator.storage?.getDirectory) throw new Error('当前浏览器不支持大工程临时磁盘，已停止导出以保护内存')
  const writer = await createStreamingManufacturingZip(input.signal, toDisk)
  const objects: ManufacturingObject[] = []
  const warnings: string[] = []
  const markingConfig = input.assemblyMarking ? normalizeAssemblyMarking(input.assemblyMarking)
    : { ...createDefaultAssemblyMarking(), enabled: false }
  let markingAppliedCount = 0
  try {
    input.onProgress?.('正在准备一次性 3MF 的全局纹理与装配标识…', 0.02)
    const context = await createTextureManufacturingContext(input)
    if (!context) throw new Error('纹理制造上下文不可用')
    if (context.vectorRegions && !context.vectorRegions.eligible) pushUniqueWarning(warnings, `SVG 使用图片轮廓流程：${context.vectorRegions.reason}`)
    const markingPlan = buildSurfaceMarkingPlan(input.markingPanels ?? input.panels, input.cfg, markingConfig, input.boardTexture, input.projectName)
    if (context.config.surfaceFinish !== 'textured-pei' && markingPlan.panels.some(mark => mark.engravingPolygons.length || mark.numberMark?.polygons.length))
      throw new Error('当前工艺选择了正面朝上，背面装配凹刻会落到热床底面。请选择正面朝下的打印方式，或关闭背面装配凹刻；订单号仍会侧刻。')
    if (markingPlan) warnings.push(...markingPlan.warnings)
    let nextPartId = 0
    let currentModelPath = ''
    const appendPart = async (part: ManufacturingPart, summaries: ManufacturingPart[], flipWidth?: number) => {
      if (flipWidth !== undefined) flipCompositePanelFaceDown([part], input.cfg.thickness, flipWidth)
      const faceCount = part.mesh.triangles.length
      for (const chunk of manufacturingPartXmlChunks(++nextPartId, part)) await writer.write(chunk)
      summaries.push({ ...part, modelPath: currentModelPath, faceCount, printZ:partPrintZ(part),
        mesh: { name: part.mesh.name, vertices: [], triangles: [] } })
      part.mesh.vertices.length = 0
      part.mesh.triangles.length = 0
    }
    for (let index = 0; index < input.panels.length; index++) {
      throwIfExportAborted(input.signal)
      currentModelPath = await writer.startModel(index + 1)
      const panel = input.panels[index]
      const mark = markingPlan?.panels.find(plan => plan.sourcePanelId === panel.id)
      const panelId = mark?.panelId ?? panel.id.toUpperCase()
      const parts: ManufacturingPart[] = []
      let base: PrintableMesh
      let marked = false
      try {
        if (mark?.engravingPolygons.length) {
          base = await createBackEngravedBase(panel, input.cfg, context.structuralThickness, markingConfig, mark, warnings, false)
          marked = true
        } else base = createBottomBeveledBase(panel, input.cfg, context.structuralThickness, warnings)
      } catch (error) {
        warnings.push(`${panelId} 背面标识网格生成失败，已安全回退为无标识基材：${error instanceof Error ? error.message : String(error)}`)
        base = createBottomBeveledBase(panel, input.cfg, context.structuralThickness, warnings)
      }
      if (marked) markingAppliedCount++
      const flip = context.config.surfaceFinish === 'textured-pei' ? panel.w : undefined
      const basePart: ManufacturingPart = {
        name: `${panelId} · ${context.config.baseMaterialName} · 结构基材 ${context.structuralThickness.toFixed(1)}mm${marked ? ' · 背面凹刻' : ''}`,
        mesh: base, extruder: 1, color: context.config.baseColor, settings: structuralPartSettings(context.config),
      }
      if (flip !== undefined) flipCompositePanelFaceDown([basePart], input.cfg.thickness, flip)
      const footprint: PrintableMesh = { name: `${panel.id}-footprint`,
        vertices: printableMeshFootprint(basePart.mesh).map(([x, y]) => [x, y, 0]), triangles: [] }
      await appendPart(basePart, parts)
      let surfaceParts = 0
      await createPanelTextureParts(panel, input.cfg, context, input.signal, fraction => {
        input.onProgress?.(`正在生成第 ${index + 1}/${input.panels.length} 块板的光学层…`, 0.08 + (index + fraction) / input.panels.length * 0.69)
      }, warnings, undefined, async part => {
        if (part.extruder > 1) surfaceParts++
        await appendPart(part, parts, flip)
      })
      if (!surfaceParts) warnings.push(`${panelId} 的表层没有生成有效制造网格`)
      objects.push({
        key: `panel-streamed:${panel.id}:${index}`, name: `${panelId} · ${panel.w.toFixed(0)}×${panel.h.toFixed(0)} 复合板件（整体移动）${isBackEngravingEnabled(markingConfig, input.boardTexture) && !marked ? ' · 背面标识未写入' : ''}`,
        mesh: footprint, parts, preferredRotation: panel.printRotation ?? 0,
        quantity: 1, kind: 'panel', sourcePanel:panel, backMarkingApplied: marked,
      })
      await writer.endModel()
      await yieldExportThread()
    }
    if (input.placedParts.length) {
      input.onProgress?.('正在准备配件制造网格…', 0.78)
      const placed = await createManufacturingObjects({ ...input, panels: [], boardTexture: undefined,
        assemblyMarking: undefined, onProgress: undefined })
      warnings.push(...placed.warnings)
      if (placed.objects.length) currentModelPath = await writer.startModel(input.panels.length + 1)
      for (const [partIndex, object] of placed.objects.entries()) {
        input.onProgress?.(`正在写入第 ${partIndex + 1}/${placed.objects.length} 件配件…`,
          0.78 + 0.03 * (partIndex + 1) / placed.objects.length)
        const footprint: PrintableMesh = { name: `${object.key}-footprint`,
          vertices: printableMeshFootprint(object.mesh).map(([x, y]) => [x, y, 0]), triangles: [] }
        const parts: ManufacturingPart[] = []
        for (const part of object.parts) await appendPart(part, parts)
        objects.push({ ...object, mesh: footprint, parts })
      }
      if (placed.objects.length) await writer.endModel()
    }
    const plates = packManufacturingObjects(objects, input.cfg)
    validateBambuPlateLayout(objects, plates)
    input.onProgress?.('正在合并板件并写入 Bambu 工程配置…', 0.82)
    const title = input.projectName?.trim() || 'SnapBoard 制造项目'
    const attribution = createSnapBoardAttribution({ projectName: title, projectVersion: input.projectVersion })
    let maxExtruder = 1
    for (const object of objects) for (const part of object.parts) maxExtruder = Math.max(maxExtruder, part.extruder)
    const filamentColors = Array.from({ length: maxExtruder }, () => '#FFFFFF')
    for (const object of objects) for (const part of object.parts) filamentColors[part.extruder - 1] = part.color
    const modelPaths = [...new Set(objects.flatMap(object => object.parts.map(part => part.modelPath)).filter((path): path is string => !!path))]
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/><Default Extension="xml" ContentType="text/xml"/><Default Extension="json" ContentType="application/json"/></Types>`),
      '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
      '3D/3dmodel.model': strToU8(manufacturingModelXml(objects, plates, title, input.cfg, attribution)),
      '3D/_rels/3dmodel.model.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${modelPaths.map((path, index) => `<Relationship Target="${path}" Id="rel-${index + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('')}</Relationships>`),
      'Metadata/project_settings.config': strToU8(bambuProjectSettingsJson(input.cfg, filamentColors, input.boardTexture,bambuFirstLayerHeight(objects,input.boardTexture))),
      'Metadata/model_settings.config': strToU8(bambuModelSettingsXml(objects, plates)),
      'Metadata/layer_config_ranges.xml': strToU8(bambuLayerConfigRangesXml(objects,input.cfg,input.assemblyMarking,undefined,bambuFirstLayerHeight(objects,input.boardTexture))),
      'Metadata/slice_info.config': strToU8(bambuSliceInfoXml()),
      'Metadata/filament_sequence.json': strToU8(bambuFilamentSequenceJson(plates)),
      'Metadata/cut_information.xml': strToU8(bambuCutInformationXml(objects)),
      'Metadata/snapboard-attribution.json': strToU8(serializeSnapBoardAttribution(attribution)),
    }
    files['Metadata/snapboard-manufacturing-catalog.json'] = strToU8(JSON.stringify(manufacturingCatalog(input.panels,input.cfg,input.boardTexture)))
    if (markingPlan) files['Metadata/snapboard-assembly-map.json'] = strToU8(serializeAssemblyMap(markingPlan))
    files['Metadata/snapboard-export-report.json'] = strToU8(JSON.stringify({
      format: 'snapboard-export-report', schemaVersion: 1,
      textureContours: { requested: true, modelingMode: context.config.modelingMode, edgeSealGeometry: 'physical-offset', layers: context.contourReports },
      textureSampling: [{ gridPitchMm: context.samplePitch, canvas: [context.canvas.width, context.canvas.height],
        canvasPitchMm: [context.bounds.width / context.canvas.width, context.bounds.height / context.canvas.height],
        recipeSource: context.recipeIds ? 'direct-palette-index' : 'canvas-color-lookup',
        // 方案 §5：预算随打印配置写进 3MF 内的导出报告，便于事后对照试样结论。
        manufacturingBudget: context.budget,
        // 方案 §5.D：矢量区域构建是浏览器导出最可疑的耗时项，单独记一笔。
        vectorRegionsMs: Math.round(context.vectorRegionsMs) }],
      marking: { requested: isBackEngravingEnabled(markingConfig, input.boardTexture) ? input.panels.length : 0, applied: markingAppliedCount },
      plates: plates.map(plate => ({ plate: plate.index + 1, kind: plate.kind,
        instances: plate.instances.map(instance => { const object = objects.find(item => item.key === instance.objectKey)!; return {
          name: object.name, kind: object.kind, backMarkingApplied: object.backMarkingApplied ?? false } }) })),
      warnings,
    }, null, 2))
    input.onProgress?.('正在完成单个 3MF 工程包…', 0.92)
    const { data, file, cleanup } = await writer.finish(files)
    input.onProgress?.('3MF 工程包生成完成，正在保存…', 0.96)
    return { data, streamedFile: file, cleanup, plateCount: plates.length, panelCount: input.panels.length,
      partCount: objects.filter(object => object.kind === 'part').reduce((sum, object) => sum + object.quantity, 0),
      sampleCount: 0, samplePlateCount: 0, uniqueObjectCount: objects.length,
      markingRequestedCount: isBackEngravingEnabled(markingConfig, input.boardTexture) ? input.panels.length : 0, markingAppliedCount, warnings }
  } finally { await writer.dispose() }
}

/** Browser fallback for the same per-board ZIP selected in the export workspace. */
export async function createManufacturing3MFPerPanel(input: Manufacturing3MFInput): Promise<Manufacturing3MFSummary> {
  if (input.orderEngraving) return createManufacturing3MF({ ...input, outputMode: 'single' })
  if (input.textureSampling) throw new Error('颜色试样须与完整原板保存在同一个 3MF 中')
  if (!input.panels.length) throw new Error('没有可导出的板件')
  const bounds = getSplitPanelTextureBounds(input.panels)
  const sharedTextureContext = await createTextureManufacturingContext({ ...input, textureBounds: bounds })
  const sharedBackTextureContext = await createBackTextureManufacturingContext({ ...input, textureBounds: bounds })
  if (input.boardTexture?.enabled && input.boardTexture.surfaceMode !== 'woodgrain' && !sharedTextureContext) throw new Error('纹理上下文不可用，已停止逐板导出')
  const disk = typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory)
  const writer = await createStreamingManufacturingZip(input.signal, disk, 'zip')
  const codes = stablePanelIds(input.panels)
  const base = (input.projectName || 'SnapBoard').replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/, '').trim() || 'SnapBoard'
  let uniqueObjectCount = 0, markingAppliedCount = 0, markingRequestedCount = 0, partCount = 0
  const numbering={requested:0,applied:0,back:0,side:0,pocket:0,missing:[] as string[]}
  let bundledBytes = 0
  const warnings: string[] = []
  const store = async (name: string, data: Uint8Array) => {
    if (!disk && bundledBytes + data.byteLength > 256 * 1024 * 1024) {
      throw new Error('浏览器无临时磁盘支持，分板压缩包超过 256 MB 内存安全上限')
    }
    await writer.addStoredFile(name, data)
    bundledBytes += data.byteLength
  }
  try {
    const total = input.panels.length + (input.placedParts.length ? 1 : 0)
    for (const [index, panel] of input.panels.entries()) {
      throwIfExportAborted(input.signal)
      const code = codes[index] ?? `P${String(index + 1).padStart(2, '0')}`
      const result = await createManufacturing3MF({
        ...input, panels: [panel], placedParts: [], textureBounds: bounds,
        markingPanels: input.panels, sharedTextureContext: sharedTextureContext ?? undefined,
        sharedBackTextureContext: sharedBackTextureContext ?? undefined,
        outputMode: 'single',
        onProgress: (message, progress) => input.onProgress?.(`${code}：${message}`, (index + (progress ?? 0)) / total),
      })
      try {
        await store(`${base}-${code}.3mf`, result.streamedFile
          ? new Uint8Array(await result.streamedFile.arrayBuffer()) : result.data)
      } finally { await result.cleanup?.() }
      if(result.numbering){for(const key of ['requested','applied','back','side','pocket'] as const)numbering[key]+=result.numbering[key];numbering.missing.push(...result.numbering.missing)}
      uniqueObjectCount += result.uniqueObjectCount
      markingAppliedCount += result.markingAppliedCount
      markingRequestedCount += result.markingRequestedCount
      for (const warning of result.warnings) pushUniqueWarning(warnings,
        /^J\d+ /.test(warning) ? warning : `${code}：${warning}`)
    }
    if (input.placedParts.length) {
      const result = await createManufacturing3MF({
        ...input, panels: [], boardTexture: undefined, placedParts: input.placedParts,
        sharedTextureContext: undefined, sharedBackTextureContext: undefined,
        assemblyMarking: undefined, outputMode: 'single',
        onProgress: (message, progress) => input.onProgress?.(`配件：${message}`, (input.panels.length + (progress ?? 0)) / total),
      })
      try {
        if (result.partCount !== input.placedParts.length) throw new Error(`配件仅生成 ${result.partCount}/${input.placedParts.length} 件，已停止完整导出`)
        await store(`${base}-配件.3mf`, result.streamedFile
          ? new Uint8Array(await result.streamedFile.arrayBuffer()) : result.data)
      } finally { await result.cleanup?.() }
      partCount = result.partCount
      uniqueObjectCount += result.uniqueObjectCount
      warnings.push(...result.warnings.map(warning => `配件：${warning}`))
    }
    input.onProgress?.('正在打包分板压缩包…', 0.94)
    const result = await writer.finish({})
    return { data: result.data, streamedFile: result.file, cleanup: result.cleanup,
      fileName: `${base}-分板.zip`, plateCount: input.panels.length,
      panelCount: input.panels.length, partCount, uniqueObjectCount,
      markingRequestedCount, markingAppliedCount, numbering, sampleCount: 0, samplePlateCount: 0, warnings }
  } finally { await writer.dispose() }
}

/** A separate file per physical board keeps quantities and engraved instance numbers inseparable. */
async function createOrderManufacturingPackage(input: Manufacturing3MFInput): Promise<Manufacturing3MFSummary> {
  const plan = input.orderEngraving!
  validateOrderEngravingPlan(plan)
  const byId = new Map(input.panels.map(panel => [panel.id, panel]))
  if (byId.size !== input.panels.length || new Set(plan.panels.map(instance => instance.sourcePanelId)).size !== byId.size)
    throw new Error('订单板件清单与当前设计不一致，请保存并重新确认订单')
  for (const instance of plan.panels) {
    const panel = byId.get(instance.sourcePanelId)
    if (!panel) throw new Error(`${instance.panelCode} 未找到当前工程板件`)
    validateOrderPanel(instance, panel)
  }
  const bounds = getSplitPanelTextureBounds(input.panels)
  const sharedTextureContext = await createTextureManufacturingContext({ ...input, textureBounds: bounds })
  const sharedBackTextureContext = await createBackTextureManufacturingContext({ ...input, textureBounds: bounds })
  const disk = typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory)
  const writer = await createStreamingManufacturingZip(input.signal, disk, 'zip')
  let bytes = 0, plateCount = 0, uniqueObjectCount = 0, markingRequestedCount = 0, markingAppliedCount = 0, partCount = 0
  const warnings: string[] = []
  const store = async (name: string, result: Manufacturing3MFSummary) => {
    try {
      const data = result.streamedFile ? new Uint8Array(await result.streamedFile.arrayBuffer()) : result.data
      // ponytail: OPFS streams large browser jobs; Node/in-memory jobs stop at the existing 256 MB safety ceiling.
      if (!disk && bytes + data.byteLength > 256 * 1024 * 1024) throw new Error('订单制造 ZIP 超过 256 MB 内存上限，请将订单拆为较小生产批次')
      await writer.addStoredFile(name, data); bytes += data.byteLength
      plateCount += result.plateCount; uniqueObjectCount += result.uniqueObjectCount
      markingRequestedCount += result.markingRequestedCount; markingAppliedCount += result.markingAppliedCount
      warnings.push(...result.warnings)
    } finally { await result.cleanup?.() }
  }
  try {
    for (const instance of plan.panels) {
      throwIfExportAborted(input.signal)
      const code = `套${String(instance.setIndex).padStart(2, '0')}/${instance.panelCode}-${String(instance.instanceIndex).padStart(3, '0')}`
      const result = await createManufacturing3MF({ ...input, panels: [byId.get(instance.sourcePanelId)!], placedParts: [],
        projectName: plan.orderNumber, orderInstance: instance, markingPanels: input.panels, textureBounds: bounds,
        sharedTextureContext: sharedTextureContext ?? undefined, sharedBackTextureContext: sharedBackTextureContext ?? undefined,
        outputMode: 'single', onProgress: (message, progress) => input.onProgress?.(`${code}：${message}`,
          (instance.instanceIndex - 1 + (progress ?? 0)) / (plan.totalPanelCount + 1)) })
      await store(`${code}.3mf`, result)
    }
    if (input.placedParts.length) {
      const placedParts = Array.from({ length: plan.kitQuantity }, () => input.placedParts).flat()
      const result = await createManufacturing3MF({ ...input, panels: [], placedParts, boardTexture: undefined,
        orderEngraving: undefined, orderInstance: undefined, assemblyMarking: undefined, projectName: plan.orderNumber,
        sharedTextureContext: undefined, sharedBackTextureContext: undefined, outputMode: 'single' })
      if (result.partCount !== placedParts.length) { await result.cleanup?.(); throw new Error('订单配件未完整生成，已停止整单导出') }
      partCount = result.partCount
      await store('全单配件.3mf', result)
    }
    input.onProgress?.('正在写入订单逐实物追溯清单…', .98)
    const result = await writer.finish({ '订单制造追溯.json': strToU8(JSON.stringify(orderTraceMetadata(plan), null, 2)),
      '制造信息.json':strToU8(JSON.stringify(orderManufacturingCatalog(input.panels,input.cfg,input.boardTexture,plan))) })
    return { data: result.data, streamedFile: result.file, cleanup: result.cleanup,
      fileName: `${plan.orderNumber}-R${String(plan.revision).padStart(2, '0')}-订单制造.zip`,
      plateCount, panelCount: plan.totalPanelCount, partCount, uniqueObjectCount,
      markingRequestedCount, markingAppliedCount, sampleCount: 0, samplePlateCount: 0,
      warnings: [...new Set(warnings)] }
  } finally { await writer.dispose() }
}

/** 生成包含板件与已放置配件的多热床 3MF；重复模型复用 object，仅增加实例。 */
export async function createManufacturing3MF(input: Manufacturing3MFInput): Promise<Manufacturing3MFSummary> {
  throwIfExportAborted(input.signal)
  if (input.boardTexture?.enabled && input.boardTexture.surfaceMode === 'woodgrain') {
    if (input.textureSampling) throw new Error('木纹走线使用完整板件导出，不使用彩色图片抽样')
    if (input.panels.some(panel=>panel.latticeFace)) throw new Error('木纹薄贴面暂不支持独立薄面镂空实体，请先使用普通板件或通孔镂空板件')
    input = { ...input, boardTexture: normalizeWoodGrainTexture(input.boardTexture) }
    woodGrainVeneerDepth(input.cfg.thickness,input.boardTexture!.textureThickness)
  }
  if (input.orderEngraving) {
    if (input.textureSampling) throw new Error('订单凹刻使用完整制造板件，请选择“完整原板导出”；颜色试样不是本单编号成品')
    if (!input.orderInstance) return createOrderManufacturingPackage(input)
    if (input.panels.length !== 1 || !input.orderEngraving.panels.some(instance =>
      JSON.stringify(instance) === JSON.stringify(input.orderInstance))) throw new Error('订单导出必须使用本单清单中的唯一实物编号')
  }
  const linkedIds = input.panels.map(panel => panel.latticeFace?.source?.options.sourceLayerId)
  if (input.boardTexture?.enabled && linkedIds.length && linkedIds.every((id): id is string => Boolean(id)) &&
    sharedSvgStructureOnly(input.boardTexture, input.panels, linkedIds as string[])) {
    input = { ...input, boardTexture: { ...input.boardTexture, enabled: false }, nativeRecipeRaster: undefined,
      sharedTextureContext: undefined, sharedBackTextureContext: undefined }
  }
  if (input.panels.some(panel => panel.latticeFace && !isPlainRetainedFront(panel)) && input.boardTexture?.enabled && hasBoardTextureSource(input.boardTexture))
    throw new Error('贴墙线稿保真暂不能与纹理工作室叠加导出；请关闭纹理后导出，或先移除图案保真')
  if (input.textureSampling && input.panels.some(isPlainRetainedFront)) throw new Error('保留图案正面的镂空板请使用完整板件导出；此组合尚不支持颜色试样')
  if (!input.textureSampling && (input.outputMode ?? input.boardTexture?.manufacturingOutput) === 'perPanel') {
    return createManufacturing3MFPerPanel(input)
  }
  if (!input.panels.length && !input.placedParts.length) throw new Error('没有可导出的板件或配件')
  const generated = await createManufacturingObjects(input.textureSampling ? {
    ...input,onProgress:(message,progress)=>input.onProgress?.(message,(progress??0)*.3),
  } : input)
  const { samples } = generated
  let { objects, warnings, markingPlan, markingRequestedCount, markingAppliedCount, contourReports } = generated
  const numbered=objects.filter(o=>o.kind==='panel'&&o.numberLocation)
  const countAt=(surface:'back'|'side'|'pocket')=>numbered.filter(o=>o.numberLocation===surface).reduce((s,o)=>s+o.quantity,0)
  const requestedNumbers=input.assemblyMarking && isBackEngravingEnabled(input.assemblyMarking,input.boardTexture) && input.assemblyMarking.includePanelIds ? input.panels.filter(panel=>!isThroughLatticePanel(panel)).length : 0
  const written=new Set(numbered.map(o=>o.numberId))
  const numbering={requested:requestedNumbers,applied:numbered.reduce((s,o)=>s+o.quantity,0),back:countAt('back'),side:countAt('side'),pocket:countAt('pocket'),
    missing:requestedNumbers?markingPlan?.panels.filter(p=>!written.has(p.panelId)&&input.panels.some(panel=>{
      const source=(input.markingPanels??input.panels)[p.panelIndex];return !isThroughLatticePanel(panel)&&source?.id===panel.id&&source.x===panel.x&&source.y===panel.y&&source.w===panel.w&&source.h===panel.h
    })).map(p=>p.panelId)??[]:[]}
  const textureSamplingDiagnostics = generated.textureSamplingDiagnostics ? [generated.textureSamplingDiagnostics] : []
  if(samples) {
    const original=await createManufacturingObjects({...input,textureSampling:undefined,
      onProgress:(message,progress)=>input.onProgress?.(`原板：${message}`,.25+(progress??0)*.7)})
    for(const object of objects){object.kind='sample';object.key=`sample:${object.key}`}
    objects=[...objects,...original.objects]
    warnings=[...warnings,...original.warnings]
    contourReports=[...contourReports,...original.contourReports]
    if (original.textureSamplingDiagnostics) textureSamplingDiagnostics.push(original.textureSamplingDiagnostics)
    markingPlan=original.markingPlan
    markingRequestedCount=original.markingRequestedCount
    markingAppliedCount=original.markingAppliedCount
  }
  throwIfExportAborted(input.signal)
  if (!objects.length) throw new Error(warnings[0] || '没有可导出的制造模型')
  const plates = packManufacturingObjects(objects, input.cfg)
  const samplePlateCount=plates.filter(plate=>plate.kind==='sample').length
  if(samples)warnings.unshift(`本3MF包含试样与完整原板。请先仅打印前 ${samplePlateCount} 个“试样（先打印）”盘；后续盘为完整原板/配件。`)
  input.onProgress?.(`正在写入 ${plates.length} 个热床和 Bambu 工程配置…`, 0.82)
  await yieldExportThread()
  throwIfExportAborted(input.signal)
  validateBambuPlateLayout(objects, plates)
  let maxExtruder = 1
  for (const object of objects) for (const part of object.parts) maxExtruder = Math.max(maxExtruder, part.extruder)
  const filamentColors = Array.from({ length: maxExtruder }, () => '#FFFFFF')
  for (const object of objects) for (const part of object.parts) filamentColors[part.extruder - 1] = part.color
  const title = input.projectName?.trim() || 'SnapBoard 制造项目'
  const attribution = createSnapBoardAttribution({
    projectName: title,
    projectVersion: input.projectVersion,
  })
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`
  const modelRelationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`
  input.onProgress?.('正在压缩 3MF 工程包…', 0.92)
  await yieldExportThread()
  throwIfExportAborted(input.signal)
  const packageFiles: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    '3D/3dmodel.model': strToU8(manufacturingModelXml(objects, plates, title, input.cfg, attribution)),
    '3D/_rels/3dmodel.model.rels': strToU8(modelRelationships),
    'Metadata/project_settings.config': strToU8(bambuProjectSettingsJson(input.cfg, filamentColors, input.boardTexture,bambuFirstLayerHeight(objects,input.boardTexture))),
    'Metadata/model_settings.config': strToU8(bambuModelSettingsXml(objects, plates)),
    'Metadata/layer_config_ranges.xml': strToU8(bambuLayerConfigRangesXml(objects,input.cfg,input.assemblyMarking,generated.orderSideCuts,bambuFirstLayerHeight(objects,input.boardTexture))),
    'Metadata/slice_info.config': strToU8(bambuSliceInfoXml()),
    'Metadata/filament_sequence.json': strToU8(bambuFilamentSequenceJson(plates)),
    'Metadata/cut_information.xml': strToU8(bambuCutInformationXml(objects)),
    'Metadata/snapboard-attribution.json': strToU8(serializeSnapBoardAttribution(attribution)),
  }
  packageFiles['Metadata/snapboard-manufacturing-catalog.json'] = strToU8(JSON.stringify(manufacturingCatalog(input.panels,input.cfg,input.boardTexture)))
  if (markingPlan) packageFiles['Metadata/snapboard-assembly-map.json'] = strToU8(serializeAssemblyMap(markingPlan))
  if (input.orderEngraving && input.orderInstance) packageFiles['Metadata/snapboard-order-engraving.json'] = strToU8(JSON.stringify(
    orderTraceMetadata(input.orderEngraving, [input.orderInstance], generated.orderSideCuts)))
  packageFiles['Metadata/snapboard-export-report.json'] = strToU8(JSON.stringify({
    format:'snapboard-export-report',schemaVersion:1,
    engraving: { backRequestedCount: markingRequestedCount, backAppliedCount: markingAppliedCount,
      sideAppliedCount: objects.filter(object => object.sideLogoEngraved).length,
      backReserved: input.assemblyMarking?.reserveBackMarking === true },
    doubleSided: input.boardTexture?.enabled && input.boardTexture.backEnabled ? {
      frontImage: input.boardTexture.imageName ?? '正面图层',
      backImage: backBoardTexture(input.boardTexture)?.imageName ?? '背面图层',
      layerThicknessMm: input.boardTexture.textureThickness,
      sideLogoAppliedCount: objects.filter(object => object.sideLogoEngraved).length,
      sideLogoMode: 'engraved',
      topFaceColorCalibration: 'pending-print-test',
    } : undefined,
    veneer: input.boardTexture?.enabled && input.boardTexture.surfaceMode === 'veneer' ? {
      material: input.boardTexture.surfaceMaterialName,
      profileVersion: input.boardTexture.surfaceProfileVersion ?? 1,
      ...veneerPrintProfile(input.boardTexture),
      surfaceFinish: input.boardTexture.surfaceFinish,
      note: '打印前请在切片器核对实际料卷、首层、温度、冷却、用时和孔位公差；透明目标仍为试验参数。',
    } : undefined,
    woodGrain: input.boardTexture?.enabled && input.boardTexture.surfaceMode === 'woodgrain' ? {
      ...normalizeWoodGrain(input.boardTexture.woodGrain),
      baseThicknessMm:input.cfg.thickness-input.boardTexture.textureThickness,
      surfaceThicknessMm:input.boardTexture.textureThickness,
      baseInfillDensity:input.boardTexture.baseInfillDensity,
      materialSlots:{base:1,woodVeneer:2},surfaceSingleFilament:true,
      panelVariants:input.panels.map(panel=>({id:panel.id,variantSeed:createWoodGrainPanelField(input.boardTexture!.woodGrain,panel,
        input.textureBounds??getSplitPanelTextureBounds(input.markingPanels??input.panels)).variantSeed})),
      modifierCount: objects.flatMap(object => object.parts).filter(part => part.subtype === 'modifier_part').length,
      preview: 'toolpath-region-illustration', physicalPrintValidation: 'pending',
    } : undefined,
    textureContours: {
      requested: input.boardTexture?.manufacturingContours !== false,
      modelingMode: input.boardTexture?.modelingMode,
      edgeSealGeometry: input.boardTexture?.manufacturingContours !== false && input.boardTexture?.modelingMode !== 'pixel' ? 'physical-offset' : 'legacy-grid',
      layers: contourReports,
    },
    textureSampling: textureSamplingDiagnostics,
    marking:{requested:markingRequestedCount,applied:markingAppliedCount},numbering,
    plates:plates.map(plate=>({plate:plate.index+1,kind:plate.kind,instances:plate.instances.map(instance=>{
      const object=objects.find(item=>item.key===instance.objectKey)!
      return {name:object.name,kind:object.kind,backMarkingApplied:object.backMarkingApplied ?? false,printOrientation:object.frontOnBed?'front-down-back-up':undefined}
    })})),warnings,
  },null,2))
  if (samples) packageFiles['Metadata/snapboard-texture-samples.json'] = strToU8(JSON.stringify({
    format:'snapboard-texture-samples',schemaVersion:1,projectName:input.projectName,
    scale:1,layerScope:'surface-and-backing-only',includesOriginals:true,sourceBoardThicknessMm:input.cfg.thickness,
    samplePlates:plates.filter(p=>p.kind==='sample').map(p=>p.index+1),originalPlates:plates.filter(p=>p.kind!=='sample').map(p=>p.index+1),
    boardTexture: {surfaceMode:input.boardTexture?.surfaceMode,lutId:input.boardTexture?.lutId,surfaceFinish:input.boardTexture?.surfaceFinish,requestedSurfaceThicknessMm:input.boardTexture?.textureThickness},
    samples:samples.map(({panel,...sample})=>({...sample,sampleId:panel.id,contour:panel.contour,cutouts:panel.cutouts})),
  },null,2))
  if(input.assemblyMarking?.orderSideNumber && !input.orderEngraving && generated.orderSideCuts?.length)
    packageFiles['Metadata/snapboard-order-side-number.json']=strToU8(JSON.stringify({
      format:'snapboard-order-side-number',schemaVersion:1,surface:'side',operation:'engrave',
      orderNumber:input.assemblyMarking.orderSideNumber,sourceOrderId:input.assemblyMarking.orderSideSourceId,
      appliedPanelCount:objects.filter(o=>o.kind==='panel').reduce((sum,o)=>sum+o.quantity,0),
    }))
  const data = await zipManufacturingPackage(packageFiles, objects, input.signal)
  input.onProgress?.('3MF 工程包生成完成，正在保存…', 0.96)
  return {
    data,
    plateCount: plates.length,
    panelCount: objects.filter(object => object.kind === 'panel').reduce((sum, object) => sum + object.quantity, 0),
    partCount: objects.filter(object => object.kind === 'part').reduce((sum, object) => sum + object.quantity, 0),
    sampleCount: objects.filter(object => object.kind === 'sample').reduce((sum, object) => sum + object.quantity, 0),
    samplePlateCount,
    uniqueObjectCount: objects.length,
    markingRequestedCount,
    markingAppliedCount,
    numbering,
    warnings,
  }
}

export function manufacturing3MFFileName(input: Manufacturing3MFInput, plateCount: number): string {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, '')
  const withoutControls = [...(input.projectName ?? '').trim()].map(char => char.charCodeAt(0) < 32 ? '-' : char).join('')
  const safeName = withoutControls.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '') || 'SnapBoard'
  return `${safeName}${input.textureSampling ? '-纹理抽样' : ''}-排盘-${plateCount}盘-${stamp}.3mf`
}

export async function downloadManufacturing3MF(input: Manufacturing3MFInput): Promise<Manufacturing3MFSummary> {
  const result = await createManufacturing3MF(input)
  const fileName = result.fileName ?? manufacturing3MFFileName(input, result.plateCount)
  const blob = result.streamedFile ?? new Blob([result.data as BlobPart], { type: fileName.endsWith('.zip') ? 'application/zip' : 'model/3mf' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => { URL.revokeObjectURL(url); void result.cleanup?.() }, 60_000)
  return result
}

/** Prepared, closed meshes reuse the same profile, packing and package writer.
 * Standee panels are already bed-facing, so their optical recipes are not flipped again. */
export async function createPreparedManufacturing3MF(input: {
  objects: ManufacturingObject[]; cfg: SplitConfig; colors: string[]; title: string;
  metadata?: Record<string, unknown>; signal?: AbortSignal; primeTower?: boolean;
}) {
  const { objects, cfg, colors, title, signal } = input
  if (!objects.length || !colors.length) throw new Error('没有可导出的零件或耗材')
  for (const object of objects) for (const part of object.parts) {
    if (!part.mesh.vertices.length || !part.mesh.triangles.length) throw new Error(`${part.name} 没有有效网格`)
    if (!Number.isInteger(part.extruder) || part.extruder < 1 || part.extruder > colors.length) throw new Error(`${part.name} 的耗材槽位无效`)
    validateClosedMesh(part.name, part.mesh.triangles)
  }
  const primeTower = input.primeTower ?? colors.length > 1
  const towerZone = { id:'prepared-prime-tower', name:'擦料塔预留', enabled:true,
    x:cfg.bedW-80, y:cfg.bedH-70, w:75, h:65 }
  const packingCfg = primeTower ? { ...cfg, bedKeepouts:[...cfg.bedKeepouts,towerZone] } : cfg
  const plates = packManufacturingObjects(objects, packingCfg)
  validateBambuPlateLayout(objects, plates)
  const first = Math.min(...objects.flatMap(o => o.parts.map(p => Number(p.settings?.layer_height ?? .2))))
  const isOpticalObject = (object: ManufacturingObject) => object.frontOnBed === true && object.parts.some(part => {
    const [lo, hi] = partPrintZ(part)
    return part.settings?.layer_height === '0.08' && lo >= -1e-6 && hi <= .400001
  })
  const hasOpticalObjects = objects.some(isOpticalObject)
  const settings = JSON.parse(bambuProjectSettingsJson(cfg, colors, {
    ...createDefaultBoardTexture(), enabled: first === .08, surfaceMode: 'snapcolor',
    surfaceFinish: 'textured-pei', baseInfillDensity: 15,
  }, first)) as Record<string, unknown>
  // Every object shares one Z schedule. Per-object skin/top transitions can
  // otherwise make Bambu reject the prime tower on a mixed mechanical/art plate.
  settings.layer_height = '0.2'
  settings.initial_layer_print_height = String(first)
  settings.adaptive_layer_height = '0'
  settings.precise_z_height = '0'
  settings.enable_prime_tower = primeTower ? '1' : '0'
  if (primeTower) {
    settings.prime_tower_width = '35'
    settings.wipe_tower_rotation_angle = '0'
    settings.wipe_tower_x = plates.map(() => String(towerZone.x+10))
    settings.wipe_tower_y = plates.map(() => String(towerZone.y+10))
    const changes = settings.different_settings_to_system as string[]
    changes[0] += ';adaptive_layer_height;precise_z_height;wipe_tower_x;wipe_tower_y;wipe_tower_rotation_angle;prime_tower_width'
  }
  // Preserve ordinary mechanical body paths and the template's bed-contact
  // width independently from the optical body path settings.
  const mechanicalPathSettings = Object.fromEntries(Object.keys(PREPARED_OPTICAL_PATH_SETTINGS)
    .filter(key => key !== 'initial_layer_line_width' && settings[key] !== undefined)
    .map(key => [key, String(settings[key])]))
  if (hasOpticalObjects) applyPreparedOpticalProjectDefaults(settings)
  settings.print_settings_id = '0.20mm Standard @BBL X1C'
  ;(settings.inherits_group as string[])[0] = settings.print_settings_id as string
  for (let i = 1; i <= colors.length; i++) (settings.different_settings_to_system as string[])[i] += ';filament_colour;filament_multi_colour'
  // A one-material object should inherit its own spool, including in viewers
  // that choose the parent object's colour instead of inspecting each volume.
  const editableObjects = objects.map(object => {
    const single = object.parts.length === 1
    const structural = object.parts.find(p => p.name.includes('结构背托')) ?? object.parts[0]
    const parentSettings = normalizeBambuFillPatterns({ ...structural.settings, ...object.settings })
    const optical = isOpticalObject(object)
    if (optical) {
      Object.assign(parentSettings, PREPARED_OPTICAL_PATH_SETTINGS)
      parentSettings.sparse_infill_density = '100%'
      parentSettings.sparse_infill_pattern = 'zig-zag'
      parentSettings.internal_solid_infill_pattern = 'zig-zag'
    } else if (hasOpticalObjects) {
      for (const [key, value] of Object.entries(mechanicalPathSettings)) parentSettings[key] ??= value
      parentSettings.sparse_infill_density ??= '15%'
      parentSettings.sparse_infill_pattern ??= 'gyroid'
    }
    delete parentSettings.layer_height
    delete parentSettings.initial_layer_line_width
    delete parentSettings.initial_layer_infill_line_width
    if (object.key === 'base' && !hasOpticalObjects) {
      delete parentSettings.sparse_infill_density; delete parentSettings.sparse_infill_pattern
    }
    const parts = object.parts.map(part => {
      const [lo, hi] = partPrintZ(part)
      const colourLayer = optical && part.settings?.layer_height === '0.08' && lo >= -1e-6 && hi <= .400001
      const settings = colourLayer ? preparedOpticalPartSettings(part.settings ?? {}) : normalizeBambuFillPatterns(part.settings ?? {})
      delete settings.initial_layer_line_width
      delete settings.initial_layer_infill_line_width
      if (optical && !colourLayer && lo >= 1 - 1e-6) {
        for (const [key, value] of Object.entries(mechanicalPathSettings)) settings[key] ??= value
      }
      if (settings.sparse_infill_density === '100%') {
        settings.sparse_infill_pattern ??= 'zig-zag'
        settings.internal_solid_infill_pattern ??= 'zig-zag'
      }
      for (const key of Object.keys(settings)) if (key.includes('speed') || key === 'small_perimeter_threshold') delete settings[key]
      if (single) {
        for (const key of Object.keys(settings)) if (key !== 'layer_height') delete settings[key]
      } else if (part.name.includes('结构背托')) {
        delete settings.sparse_infill_density; delete settings.sparse_infill_pattern
      }
      return { ...part, settings }
    })
    return { ...object, settings: parentSettings, parts }
  })
  let modelSettings = bambuModelSettingsXml(editableObjects, plates)
  objects.forEach((object, index) => {
    const slots = [...new Set(object.parts.map(p => p.extruder))]
    if (slots.length === 1) modelSettings = modelSettings.replace(
      new RegExp(`(<object id="${rootObjectId(objects, index)}">[\\s\\S]*?<metadata key="extruder" value=")1("/>)`), (_all, prefix: string, suffix: string) => prefix + slots[0] + suffix)
  })
  const attribution = createSnapBoardAttribution({ projectName: title, projectVersion: 'standee-demo-0.1' })
  const sharedTop = Math.ceil(Math.max(...objects.flatMap(o => o.parts.map(p => partPrintZ(p)[1]))) / .2) * .2
  const sharedRanges = `${hasOpticalObjects ? '<range min_z="0" max_z="0.4"><option opt_key="layer_height">0.08</option></range>' : ''}<range min_z="${hasOpticalObjects ? '0.4' : '0'}" max_z="${number(Math.max(sharedTop,.6))}"><option opt_key="layer_height">0.2</option></range>`
  const layerRanges = `<?xml version="1.0" encoding="UTF-8"?><objects>${objects.map((_,i)=>`<object id="${i+1}">${sharedRanges}</object>`).join('')}</objects>`
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/><Default Extension="xml" ContentType="text/xml"/><Default Extension="json" ContentType="application/json"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(manufacturingModelXml(objects, plates, title, cfg, attribution)),
    '3D/_rels/3dmodel.model.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    'Metadata/project_settings.config': strToU8(JSON.stringify(settings)),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/layer_config_ranges.xml': strToU8(layerRanges),
    'Metadata/slice_info.config': strToU8(bambuSliceInfoXml()),
    'Metadata/filament_sequence.json': strToU8(bambuFilamentSequenceJson(plates)),
    'Metadata/cut_information.xml': strToU8(bambuCutInformationXml(objects)),
    'Metadata/snapboard-attribution.json': strToU8(serializeSnapBoardAttribution(attribution)),
    'Metadata/standee-layout.json': strToU8(JSON.stringify(input.metadata ?? {})),
  }
  return { data: await zipManufacturingPackage(files, objects, signal, colors), plateCount: plates.length, objectCount: objects.length, plates }
}
