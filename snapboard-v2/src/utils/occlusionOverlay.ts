import * as THREE from 'three'
import type { SplitPanel } from '../types/geometry'
import { splitAssemblyFrame, type SplitAssemblyFrame } from './assemblySnap.js'
import type { BoardZone, BoardZoneId, OcclusionGrid, OcclusionReport } from './occlusionModel.js'

export type OcclusionHeatLevel = 'balanced' | 'warning' | 'crowded'

export interface OcclusionOverlayOptions {
  /** 显示基于 coverage / minVoid 的红黄绿密度格。 */
  showHeatmap?: boolean
  /** 显示承重、高频、视觉核心三区的边界。 */
  showZoneBoundaries?: boolean
  /** 用真实板材栅格高亮视觉核心保护区，不会填到异形板外。 */
  showVisualCoreProtection?: boolean
  /** 相对板材正面的抬高距离，避免与贴面 z-fighting。默认 0.35 mm。 */
  zOffset?: number
  /** 格子之间保留的空隙比例，范围 0~0.45。默认 0.08。 */
  cellGapRatio?: number
  /** 平衡/警告分界。密度 = coverage × (1 - minVoid)，默认 0.55。 */
  balancedMax?: number
  /** 警告/拥挤分界。默认 1.25。 */
  crowdedMin?: number
  balancedColor?: THREE.ColorRepresentation
  warningColor?: THREE.ColorRepresentation
  crowdedColor?: THREE.ColorRepresentation
  visualCoreColor?: THREE.ColorRepresentation
}

export interface OcclusionOverlayInput {
  report: OcclusionReport
  /**
   * 分割板件用于把 report.grid 的全局 mm 转成 Viewport3D 的装配世界坐标。
   * 如果调用方已缓存 splitAssemblyFrame，可只传 frame。
   */
  panels?: SplitPanel[]
  frame?: SplitAssemblyFrame
  /** 板材正面的世界 z；通常传 splitCfg.thickness。 */
  surfaceZ: number
  options?: OcclusionOverlayOptions
}

interface ResolvedOverlayOptions {
  showHeatmap: boolean
  showZoneBoundaries: boolean
  showVisualCoreProtection: boolean
  zOffset: number
  cellGapRatio: number
  balancedMax: number
  crowdedMin: number
  balancedColor: THREE.ColorRepresentation
  warningColor: THREE.ColorRepresentation
  crowdedColor: THREE.ColorRepresentation
  visualCoreColor: THREE.ColorRepresentation
}

const DEFAULT_OPTIONS: ResolvedOverlayOptions = {
  showHeatmap: true,
  showZoneBoundaries: true,
  showVisualCoreProtection: true,
  zOffset: 0.35,
  cellGapRatio: 0.08,
  balancedMax: 0.55,
  crowdedMin: 1.25,
  balancedColor: 0x32d583,
  warningColor: 0xfdb022,
  crowdedColor: 0xf04438,
  visualCoreColor: 0x7a5af8,
}

const ZONE_COLORS: Record<BoardZoneId, THREE.ColorRepresentation> = {
  'load-storage': 0x2e90fa,
  'frequent-use': 0xf79009,
  'visual-core': 0x7a5af8,
}

function resolveOptions(options: OcclusionOverlayOptions | undefined): ResolvedOverlayOptions {
  const merged = { ...DEFAULT_OPTIONS, ...options }
  const balancedMax = Math.max(0, Number.isFinite(merged.balancedMax) ? merged.balancedMax : DEFAULT_OPTIONS.balancedMax)
  const crowdedMin = Math.max(
    balancedMax + 0.01,
    Number.isFinite(merged.crowdedMin) ? merged.crowdedMin : DEFAULT_OPTIONS.crowdedMin,
  )
  return {
    ...merged,
    zOffset: Math.max(0.01, Number.isFinite(merged.zOffset) ? merged.zOffset : DEFAULT_OPTIONS.zOffset),
    cellGapRatio: Math.max(0, Math.min(0.45, Number.isFinite(merged.cellGapRatio) ? merged.cellGapRatio : DEFAULT_OPTIONS.cellGapRatio)),
    balancedMax,
    crowdedMin,
  }
}

function heatLevelAt(grid: OcclusionGrid, index: number, options: ResolvedOverlayOptions): OcclusionHeatLevel {
  const coverage = grid.coverage[index] ?? 0
  const voidRatio = coverage > 0
    ? Math.max(0, Math.min(1, grid.minVoid[index] ?? 0))
    : 1
  const effectiveDensity = coverage * (1 - voidRatio)
  if (effectiveDensity <= options.balancedMax) return 'balanced'
  if (effectiveDensity < options.crowdedMin) return 'warning'
  return 'crowded'
}

function createCellInstances(
  name: string,
  grid: OcclusionGrid,
  frame: SplitAssemblyFrame,
  surfaceZ: number,
  size: number,
  color: THREE.ColorRepresentation,
  opacity: number,
  renderOrder: number,
  include: (index: number, localX: number, localY: number) => boolean,
): THREE.InstancedMesh | null {
  let count = 0
  for (let row = 0; row < grid.rows; row++) {
    const localY = grid.minY + (row + 0.5) * grid.cellSize - frame.minY
    for (let col = 0; col < grid.cols; col++) {
      const index = row * grid.cols + col
      if (!grid.material[index]) continue
      const localX = grid.minX + (col + 0.5) * grid.cellSize - frame.centerX
      if (include(index, localX, localY)) count++
    }
  }
  if (count === 0) return null

  const geometry = new THREE.PlaneGeometry(size, size)
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.name = name
  mesh.renderOrder = renderOrder
  // InstancedMesh 的包围体在不同 three 版本中计算时机不同；叠加层本身最多 24 万格，
  // 禁用视锥裁剪可以避免初次显示时因空包围体被误裁掉。
  mesh.frustumCulled = false

  const matrix = new THREE.Matrix4()
  let instance = 0
  for (let row = 0; row < grid.rows; row++) {
    const localY = grid.minY + (row + 0.5) * grid.cellSize - frame.minY
    for (let col = 0; col < grid.cols; col++) {
      const index = row * grid.cols + col
      if (!grid.material[index]) continue
      const localX = grid.minX + (col + 0.5) * grid.cellSize - frame.centerX
      if (!include(index, localX, localY)) continue
      matrix.makeTranslation(localX, localY, surfaceZ)
      mesh.setMatrixAt(instance++, matrix)
    }
  }
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

function createZoneOutline(
  zone: BoardZone,
  report: OcclusionReport,
  z: number,
): THREE.LineLoop {
  const { bounds } = report.board
  const y0 = bounds.minY + bounds.height * zone.from
  const y1 = bounds.minY + bounds.height * zone.to
  const points = [
    new THREE.Vector3(bounds.minX, y0, z),
    new THREE.Vector3(bounds.maxX, y0, z),
    new THREE.Vector3(bounds.maxX, y1, z),
    new THREE.Vector3(bounds.minX, y1, z),
  ]
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineBasicMaterial({
    color: ZONE_COLORS[zone.id],
    transparent: true,
    opacity: zone.id === 'visual-core' ? 0.95 : 0.72,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  })
  const outline = new THREE.LineLoop(geometry, material)
  outline.name = `occlusion-zone-${zone.id}`
  outline.renderOrder = 42
  outline.userData.zone = { id: zone.id, label: zone.label, from: zone.from, to: zone.to }
  return outline
}

function requireAssemblyFrame(input: OcclusionOverlayInput): SplitAssemblyFrame {
  if (input.frame) return input.frame
  if (input.panels?.length) return splitAssemblyFrame(input.panels)
  if (input.report.grid.cols === 0 || input.report.grid.rows === 0) return { centerX: 0, minY: 0 }
  throw new Error('创建遮挡叠加层需要 panels 或 splitAssemblyFrame，无法从全局栅格安全推断 3D 装配坐标')
}

/**
 * 创建可直接传入 scene.add() 的遮挡分析叠加层。
 *
 * report.grid 使用分割引擎的全局 mm；返回 group 中的对象则已转换成 Viewport3D
 * 的装配世界坐标（x 以装配中心为 0，y 以板底为 0，z 位于板材正面）。
 */
export function createOcclusionOverlay(input: OcclusionOverlayInput): THREE.Group {
  const group = new THREE.Group()
  group.name = 'occlusion-overlay'
  const { report } = input
  const grid = report.grid
  const options = resolveOptions(input.options)
  const frame = requireAssemblyFrame(input)
  const z = input.surfaceZ + options.zOffset

  if (options.showVisualCoreProtection) {
    const core = report.board.zones.find(zone => zone.id === 'visual-core')
    if (core) {
      const minY = report.board.bounds.minY + report.board.bounds.height * core.from
      const maxY = report.board.bounds.minY + report.board.bounds.height * core.to
      const protection = createCellInstances(
        'occlusion-visual-core-protection',
        grid,
        frame,
        z,
        grid.cellSize,
        options.visualCoreColor,
        0.11,
        39,
        (_index, _localX, localY) => localY >= minY && localY <= maxY,
      )
      if (protection) group.add(protection)
    }
  }

  const heatCounts: Record<OcclusionHeatLevel, number> = { balanced: 0, warning: 0, crowded: 0 }
  if (options.showHeatmap) {
    const levels: Array<{
      id: OcclusionHeatLevel
      color: THREE.ColorRepresentation
      opacity: number
    }> = [
      { id: 'balanced', color: options.balancedColor, opacity: 0.12 },
      { id: 'warning', color: options.warningColor, opacity: 0.28 },
      { id: 'crowded', color: options.crowdedColor, opacity: 0.46 },
    ]
    const cellSize = grid.cellSize * (1 - options.cellGapRatio)
    for (const level of levels) {
      const mesh = createCellInstances(
        `occlusion-heat-${level.id}`,
        grid,
        frame,
        z + 0.02,
        cellSize,
        level.color,
        level.opacity,
        40,
        index => heatLevelAt(grid, index, options) === level.id,
      )
      if (!mesh) continue
      heatCounts[level.id] = mesh.count
      mesh.userData.heatLevel = level.id
      group.add(mesh)
    }
  }

  if (options.showZoneBoundaries) {
    for (const zone of report.board.zones) group.add(createZoneOutline(zone, report, z + 0.05))
  }

  group.userData.occlusionOverlay = {
    frame: { ...frame },
    surfaceZ: input.surfaceZ,
    heatCounts,
    thresholds: { balancedMax: options.balancedMax, crowdedMin: options.crowdedMin },
  }
  return group
}

/** 从场景移除叠加层并释放本工具创建的全部 geometry / material。可安全重复调用。 */
export function disposeOcclusionOverlay(group: THREE.Group): void {
  group.removeFromParent()
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  group.traverse(object => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    if (renderable.geometry) geometries.add(renderable.geometry)
    if (Array.isArray(renderable.material)) {
      for (const material of renderable.material) materials.add(material)
    } else if (renderable.material) {
      materials.add(renderable.material)
    }
  })
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  group.clear()
  group.userData = {}
}
