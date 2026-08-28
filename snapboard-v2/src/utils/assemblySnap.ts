import type { PartMountAnchor, MountHoleKind } from '../partLibrary/types'
import type { SplitConfig, SplitPanel } from '../types/geometry'
import { stabilizeSlotAxis } from './mountAxis.js'

export interface AssemblyTarget {
  id: string
  panelId: string
  kind: MountHoleKind
  x: number
  y: number
  z: number
  /** 长圆孔长轴方向 (面板空间单位向量, 板面规格孔全为竖向 [0,1]) — 用于定向吸附 */
  axis?: [number, number]
    /** 候选圆孔尚未打通，装配成功后切换为贯通孔。 */
  covered?: boolean
  source?: { panelX: number; panelY: number; holeX: number; holeY: number }
}

export interface AssemblyFit {
  position: [number, number, number]
  rotationZ: number
  targets: AssemblyTarget[]
  error: number
}

export interface SplitAssemblyFrame {
  centerX: number
  minY: number
}

export function splitAssemblyFrame(panels: SplitPanel[]): SplitAssemblyFrame {
  let minX = Infinity, maxX = -Infinity, minY = Infinity
  for (const panel of panels) {
    minX = Math.min(minX, panel.x)
    maxX = Math.max(maxX, panel.x + panel.w)
    minY = Math.min(minY, panel.y)
  }
  return {
    centerX: Number.isFinite(minX) ? (minX + maxX) / 2 : 0,
    minY: Number.isFinite(minY) ? minY : 0,
  }
}

/** 把分割引擎的全局 mm 孔位变成 3D 装配体中的世界坐标吸附目标。 */
export function splitPanelTargets(
  panels: SplitPanel[],
  cfg: SplitConfig,
  side: 'front' | 'back' = 'front',
): AssemblyTarget[] {
  const frame = splitAssemblyFrame(panels)
  const surfaceZ = side === 'front' ? cfg.thickness : 0
  const targets: AssemblyTarget[] = []
  const key = (value: number) => Math.round(value * 1000)
  for (const panel of panels) {
    panel.slots.forEach((hole, index) => targets.push({
      id: `${panel.id}:slot:${index}:${key(hole.x)}:${key(hole.y)}`,
      panelId: panel.id,
      kind: 'slot',
      x: hole.x - frame.centerX,
      y: hole.y - frame.minY,
      z: surfaceZ,
      // 规格长圆孔全部为竖向 5×15 胶囊 (crystalSlots): 长轴 = 面板 Y
      axis: [0, 1],
    }))
    panel.round_holes.forEach((hole, index) => targets.push({
      id: `${panel.id}:round:${index}:${key(hole.x)}:${key(hole.y)}`,
      panelId: panel.id,
      kind: 'round',
      x: hole.x - frame.centerX,
      y: hole.y - frame.minY,
      z: surfaceZ,
    }))
    panel.edge_holes.forEach((hole, index) => {
      // 板边上的半圆拼接缺口不能安装零件；只收录板内的圆形敲落孔。
      const onBoundary = Math.abs(hole.x - panel.x) < 0.5 || Math.abs(hole.x - (panel.x + panel.w)) < 0.5 ||
        Math.abs(hole.y - panel.y) < 0.5 || Math.abs(hole.y - (panel.y + panel.h)) < 0.5
      if (onBoundary) return
      targets.push({
        id: `${panel.id}:round-edge:${index}:${key(hole.x)}:${key(hole.y)}`,
        panelId: panel.id,
        kind: 'round',
        x: hole.x - frame.centerX,
        y: hole.y - frame.minY,
        z: surfaceZ,
        covered: !hole.knocked,
        source: { panelX: panel.x, panelY: panel.y, holeX: hole.x, holeY: hole.y },
      })
    })
  }
  return targets
}

/** 背面装配等于先把零件绕 Y 轴翻转 180°，再在板面内旋转匹配孔阵列。 */
export function anchorsForSide(anchors: PartMountAnchor[], side: 'front' | 'back'): PartMountAnchor[] {
  return anchors.map(anchor => {
    const axis = anchor.axis ? stabilizeSlotAxis(anchor.axis) : undefined
    if (side === 'front') return axis === anchor.axis ? anchor : { ...anchor, axis }
    return {
      ...anchor,
      position: [-anchor.position[0], anchor.position[1], -anchor.position[2]],
      normal: anchor.normal ? [-anchor.normal[0], anchor.normal[1], -anchor.normal[2]] : undefined,
      axis: axis ? [-axis[0], axis[1]] : undefined,
    }
  })
}

/** 接触面 z 的背面翻转 (与锚点 z 翻转规则一致: 绕 Y 轴 180° 时局部 z 取反)。 */
export function contactZForSide(contactZ: number | undefined, side: 'front' | 'back'): number | undefined {
  if (contactZ === undefined) return undefined
  return side === 'back' ? -contactZ : contactZ
}

/** 把装配命中的未开候选圆孔变为真孔；同一来源只调用一次，供放置/移动/旋转共用。 */
export function openCoveredAssemblyTargets(
  targets: AssemblyTarget[],
  open: (panelId: string, panelX: number, panelY: number, holeX: number, holeY: number) => void,
): number {
  const opened = new Set<string>()
  for (const target of targets) {
    if (!target.covered || !target.source) continue
    const key = `${target.panelId}:${target.source.panelX}:${target.source.panelY}:${target.source.holeX}:${target.source.holeY}`
    if (opened.has(key)) continue
    opened.add(key)
    open(target.panelId, target.source.panelX, target.source.panelY, target.source.holeX, target.source.holeY)
  }
  return opened.size
}

const accepts = (anchor: PartMountAnchor, target: AssemblyTarget) =>
  anchor.accepts.includes('either') || anchor.accepts.includes(target.kind)

const rotate2 = (x: number, y: number, angle: number): [number, number] => [
  x * Math.cos(angle) - y * Math.sin(angle),
  x * Math.sin(angle) + y * Math.cos(angle),
]

/** 长轴定向校验: 锚点长轴经 rotationZ 旋转后须与目标长轴平行 (|dot| ≥ cos 25.8°)。
 *  板面规格孔长轴全为竖向, 90° 旋转把椭圆对角线调换时 dot=0 → 拒绝该候选。 */
const axesParallel = (
  anchorAxis: [number, number],
  targetAxis: [number, number],
  rotationZ: number,
): boolean => {
  const anchorLength = Math.hypot(anchorAxis[0], anchorAxis[1])
  const targetLength = Math.hypot(targetAxis[0], targetAxis[1])
  if (anchorLength < 1e-6 || targetLength < 1e-6) return false
  const [ax, ay] = rotate2(anchorAxis[0] / anchorLength, anchorAxis[1] / anchorLength, rotationZ)
  return Math.abs(ax * targetAxis[0] / targetLength + ay * targetAxis[1] / targetLength) >= 0.9
}

/**
 * 用 2D 刚体配准把配件端面锚点匹配到板孔。首锚点靠近落点，其余锚点必须保持原间距。
 * 不缩放模型；孔距不一致就拒绝吸附，避免“看似装上、实际变形”的错误装配。
 */
export function fitPartAnchors(
  anchorsInput: PartMountAnchor[],
  targets: AssemblyTarget[],
  pointer: { x: number; y: number },
  pointerRadius = 35,
  tolerance = 4,
  preferredRotationZ?: number,
  /** 已被其他装配件占用的孔位 id (孔是穿板贯通孔, 正/背面共用同一组孔, 只能装一件) */
  occupiedIds?: ReadonlySet<string>,
  /** 接触面局部 z (已按 side 翻转): 装配时接触面与板面贴合; 缺省退回锚点平面贴合 */
  contactZ?: number,
): AssemblyFit | null {
  const anchors = anchorsInput.filter(anchor => anchor.required !== false)
  if (!anchors.length || !targets.length) return null
  const free = occupiedIds?.size
    ? (target: AssemblyTarget) => !occupiedIds.has(target.id)
    : () => true
  const firstCandidates = targets
    .filter(target => free(target) && accepts(anchors[0], target))
    .map(target => ({ target, pointerError: Math.hypot(target.x - pointer.x, target.y - pointer.y) }))
    .filter(item => item.pointerError <= pointerRadius)
    .sort((a, b) => a.pointerError - b.pointerError)
    .slice(0, 16)
  if (!firstCandidates.length) return null

  let best: AssemblyFit | null = null
  let bestScore = Infinity
  const evaluate = (rotationZ: number, first: AssemblyTarget, pointerError: number) => {
    if (anchors[0].axis && first.axis && !axesParallel(anchors[0].axis, first.axis, rotationZ)) return
    const [r0x, r0y] = rotate2(anchors[0].position[0], anchors[0].position[1], rotationZ)
    const tx = first.x - r0x
    const ty = first.y - r0y
    const used = new Set<string>([first.id])
    const matched: AssemblyTarget[] = [first]
    let error = pointerError * 0.08
    for (let i = 1; i < anchors.length; i++) {
      const anchor = anchors[i]
      const [rx, ry] = rotate2(anchor.position[0], anchor.position[1], rotationZ)
      let nearest: { target: AssemblyTarget; distance: number } | null = null
      for (const target of targets) {
        if (used.has(target.id) || !free(target) || !accepts(anchor, target)) continue
        if (anchor.axis && target.axis && !axesParallel(anchor.axis, target.axis, rotationZ)) continue
        const distance = Math.hypot(target.x - (rx + tx), target.y - (ry + ty))
        if (distance <= tolerance && (!nearest || distance < nearest.distance)) nearest = { target, distance }
      }
      if (!nearest) return
      used.add(nearest.target.id)
      matched.push(nearest.target)
      error += nearest.distance
    }
    const zOffset = Number.isFinite(contactZ)
      ? first.z - (contactZ as number)
      : matched.reduce((sum, target, i) => sum + target.z - anchors[i].position[2], 0) / matched.length
    const candidate: AssemblyFit = {
      position: [tx, ty, zOffset],
      rotationZ,
      targets: matched,
      error,
    }
    const angleDistance = preferredRotationZ === undefined
      ? 0
      : Math.abs(Math.atan2(Math.sin(rotationZ - preferredRotationZ), Math.cos(rotationZ - preferredRotationZ)))
    // 手动旋转时优先选择最接近期望角度的合法孔组；仍只接受实际孔距完全匹配的结果。
    const score = candidate.error + angleDistance * 100
    if (!best || score < bestScore) {
      best = candidate
      bestScore = score
    }
  }

  for (const { target: first, pointerError } of firstCandidates) {
    if (anchors.length === 1) {
      evaluate(preferredRotationZ ?? 0, first, pointerError)
      continue
    }
    const sourceDx = anchors[1].position[0] - anchors[0].position[0]
    const sourceDy = anchors[1].position[1] - anchors[0].position[1]
    const sourceDistance = Math.hypot(sourceDx, sourceDy)
    if (sourceDistance < 1e-5) continue
    for (const second of targets) {
      if (second.id === first.id || !free(second) || !accepts(anchors[1], second)) continue
      const targetDx = second.x - first.x
      const targetDy = second.y - first.y
      if (Math.abs(Math.hypot(targetDx, targetDy) - sourceDistance) > tolerance) continue
      const rotation = Math.atan2(targetDy, targetDx) - Math.atan2(sourceDy, sourceDx)
      evaluate(rotation, first, pointerError)
    }
  }
  return best
}
