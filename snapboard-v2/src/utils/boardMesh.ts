// ============ 3D 板子生成 — 薄板 + 孔阵列 ============
import * as THREE from 'three'
import { generateHolePattern, type HolePatternParamsEx } from './holePattern'
import type { Point2D, SplitPanel, SplitConfig } from '../types/geometry'

export interface BoardMeshOptions {
  contourPts: Point2D[]      // 轮廓顶点 (像素坐标)
  pixelToMM: number          // 像素→毫米
  thickness: number          // 板厚 mm (T)
  holePattern: HolePatternParamsEx
}

/**
 * 生成洞洞板 3D 网格 (板 + 椭圆孔 + 拼接孔)
 *
 * 方案: 板用 ExtrudeGeometry, 孔用 2D 布尔裁剪 Shape 路径
 * (避免 three-bvh-csg 的 3D 布尔开销, 孔是通孔所以在 Shape 层挖)
 */
export function generateBoardMesh(opts: BoardMeshOptions): THREE.Mesh {
  const { contourPts, pixelToMM, thickness, holePattern } = opts

  // 像素 → mm
  const mmPts = contourPts.map(p => ({ x: p.x * pixelToMM, y: p.y * pixelToMM }))

  // 1. 轮廓 Shape (mm 坐标)
  const shape = new THREE.Shape()
  shape.moveTo(mmPts[0].x, mmPts[0].y)
  for (let i = 1; i < mmPts.length; i++) {
    shape.lineTo(mmPts[i].x, mmPts[i].y)
  }
  shape.closePath()

  // 2. 孔路径 (竖向长圆孔/胶囊 5×15 晶体错列阵列; 副对角线固定圆孔 = 圆)
  const result = generateHolePattern(mmPts, holePattern)

  for (const slot of result.slots) {
    shape.holes.push(makeSlotHolePath(slot.x, slot.y, holePattern.slotLength, holePattern.slotWidth))
  }
  for (const j of result.joints) {
    shape.holes.push(makeCircleHolePath(j.x, j.y, j.diameter))
  }

  // 3. 拉伸为薄板
  const extrudeSettings = { depth: thickness, bevelEnabled: false }
  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings)
  geometry.computeVertexNormals()

  const material = new THREE.MeshStandardMaterial({
    color: 0x2e86de,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
  })

  return new THREE.Mesh(geometry, material)
}

/** 圆孔路径（默认 5mm 拼接孔）：独立 Path */
function makeCircleHolePath(cx: number, cy: number, diameter: number): THREE.Path {
  const p = new THREE.Path()
  const r = diameter / 2
  p.moveTo(cx + r, cy)
  p.absarc(cx, cy, r, 0, Math.PI * 2, true)
  return p
}

/** 任意闭合内轮廓路径; Three.js 的 hole 路径统一为顺时针。 */
function makePolygonHolePath(points: Point2D[]): THREE.Path | null {
  if (points.length < 3) return null
  let area2 = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area2 += a.x * b.y - b.x * a.y
  }
  const pts = area2 > 0 ? [...points].reverse() : points
  const path = new THREE.Path()
  path.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y)
  path.closePath()
  return path
}



// ============================================================================
// 分割面板 3D 网格 — 自动分割引擎输出的板材（圆角矩形 + 长圆孔 + 默认 5mm 拼接孔）
// ============================================================================

export interface SplitPanelMeshOptions {
  panel: SplitPanel
  cfg: SplitConfig
  color: number
  /** 圆/圆弧离散精度：实时预览默认 24，制造导出建议 48。 */
  curveSegments?: number
  /** 导出制造模型时关闭虚线孔位提示。 */
  includeGuides?: boolean
  /** 制造导出的孔口/外缘倒角尺寸 mm；实时预览默认关闭。 */
  manufacturingChamfer?: number
}

/**
 * 面板外轮廓: 圆角矩形 (每角可独立圆角/直角) + 四边上的半圆拼接孔缺口 (显式四边四角构造)。
 *
 * 关键: 拼接孔孔心位于板边缘 (X=0/X=W/Y=0/Y=H)。若把整圆作为内环, 圆与外环
 * 相切会导致 earcut 挖孔失败 (垃圾三角化, 板退化为实体)。正确建模 = 边缘孔是
 * 半圆缺口，作为外环的一部分（两板拼接后两个半圆合成默认 5mm 整圆）。
 * 圆角弧与孔缺口重叠时做截断合并 + 微小过渡段, 保证外环是简单多边形。
 *
 * 圆角策略: rr = {bl,br,tr,tl} 每角独立半径。分割引擎把内部/接缝角标记为 0 (直角),
 * 仅装配外轮廓凸角保留 cfg.cornerRadius, 使相邻板材在接缝处零缝隙平齐拼合。
 */
function addPanelOutline(
  shape: THREE.Shape,
  x: number, y: number, w: number, h: number,
  rr: { bl: number; br: number; tr: number; tl: number },
  edgeHoles: { x: number; y: number }[],
  jointD: number,
) {
  const clamp = (v: number) => Math.max(0, Math.min(v, w / 2, h / 2))
  const Rbl = clamp(rr.bl)
  const Rbr = clamp(rr.br)
  const Rtr = clamp(rr.tr)
  const Rtl = clamp(rr.tl)
  const jr = jointD / 2
  const EPS = 1e-3
  const TAU = Math.PI * 2
  const cv = (v: number) => Math.max(-1, Math.min(1, v))

  // 每边孔心坐标 (沿外环行进方向排序)
  const bH = edgeHoles.filter(e => Math.abs(e.y - y) < 0.5).map(e => e.x).sort((a, b) => a - b)
  const tH = edgeHoles.filter(e => Math.abs(e.y - (y + h)) < 0.5).map(e => e.x).sort((a, b) => b - a)
  const lH = edgeHoles.filter(e => Math.abs(e.x - x) < 0.5).map(e => e.y).sort((a, b) => b - a)
  const rH = edgeHoles.filter(e => Math.abs(e.x - (x + w)) < 0.5).map(e => e.y).sort((a, b) => a - b)

  const pts: [number, number][] = []
  const arc = (cx: number, cy: number, a0: number, a1: number, R: number) => {
    if (R <= EPS) return // 直角角: 不产生圆弧段
    const N = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)))
    for (let i = 0; i <= N; i++) {
      const th = a0 + (a1 - a0) * (i / N)
      pts.push([cx + R * Math.cos(th), cy + R * Math.sin(th)])
    }
  }
  const holeArc = (cx: number, cy: number, a0: number, a1: number, n = 16) => {
    for (let i = 0; i <= n; i++) {
      const th = a0 + (a1 - a0) * (i / n)
      pts.push([cx + jr * Math.cos(th), cy + jr * Math.sin(th)])
    }
  }
  const line = (px: number, py: number) => pts.push([px, py])
  const step = (px: number, py: number) => {
    const last = pts[pts.length - 1]
    if (Math.abs(last[0] - px) > EPS || Math.abs(last[1] - py) > EPS) line(px, py)
  }

  // ===== 左下角弧 [BL]: 圆心 (x+Rbl, y+Rbl), θ ∈ [π, 1.5π] =====
  let blS = Math.PI, blE = Math.PI * 1.5
  if (Rbl > EPS && lH.length && lH[lH.length - 1] + jr > y + Rbl) {
    const p = Math.min(lH[lH.length - 1] + jr, y + 2 * Rbl)
    blS = Math.PI - Math.asin(cv((p - (y + Rbl)) / Rbl))
  }
  if (Rbl > EPS && bH.length && bH[0] - jr < x + Rbl) {
    const p = Math.max(bH[0] - jr, x)
    blE = TAU - Math.acos(cv((p - (x + Rbl)) / Rbl))
  }
  if (Rbl <= EPS) {
    // 直角角: 直接以左下角为起点 (否则后续 step 在空点数组上取 last 崩溃)
    pts.push([x, y])
  } else if (blE > blS + EPS) {
    arc(x + Rbl, y + Rbl, blS, blE, Rbl)
    step((x + Rbl) + Rbl * Math.cos(blE), y)  // 截断过渡段 (回到边上)
  }

  // ===== 底边 (左→右) =====
  let curX = (x + Rbl) + Rbl * Math.cos(blE)
  for (const hx of bH) {
    const f = hx - jr
    if (f > curX + EPS) step(f, y)
    holeArc(hx, y, Math.PI, 0)
    curX = Math.max(curX, hx + jr)
  }

  // ===== 右下角弧 [BR]: 圆心 (x+w-Rbr, y+Rbr), θ ∈ [1.5π, 2π] =====
  let brS = Math.PI * 1.5, brE = TAU
  if (Rbr > EPS && curX > x + w - Rbr + EPS) {
    const p = Math.min(curX, x + w)
    brS = TAU - Math.acos(cv((p - (x + w - Rbr)) / Rbr))
  }
  if (Rbr > EPS && rH.length && rH[0] - jr < y + Rbr) {
    const p = Math.max(rH[0] - jr, y)
    brE = TAU + Math.asin(cv((p - (y + Rbr)) / Rbr))
  }
  if (Rbr <= EPS) {
    if (curX < x + w - EPS) step(x + w, y) // 直角角: 补右下角点
  } else if (brE > brS + EPS) {
    if (curX <= x + w - Rbr + EPS) step(x + w - Rbr, y)
    arc(x + w - Rbr, y + Rbr, brS, brE, Rbr)
    step(x + w, (y + Rbr) + Rbr * Math.sin(brE))
  } else if (curX < x + w - EPS) {
    step(x + w, y) // 兜底: 直接连线
  }

  // ===== 右边 (下→上) =====
  let curY = (y + Rbr) + Rbr * Math.sin(brE)
  for (const hy of rH) {
    const f = hy - jr
    if (f > curY + EPS) step(x + w, f)
    holeArc(x + w, hy, Math.PI / 2, Math.PI * 1.5)
    curY = Math.max(curY, hy + jr)
  }

  // ===== 右上角弧 [TR]: 圆心 (x+w-Rtr, y+h-Rtr), θ ∈ [2π, 2.5π] =====
  let trS = TAU, trE = Math.PI * 2.5
  if (Rtr > EPS && curY > y + h - Rtr + EPS) {
    const p = Math.min(curY, y + h)
    trS = TAU + Math.asin(cv((p - (y + h - Rtr)) / Rtr))
  }
  if (Rtr > EPS && tH.length && tH[0] + jr > x + w - Rtr) {
    const p = Math.max(tH[0] + jr, x + w - Rtr)
    trE = TAU + Math.acos(cv((p - (x + w - Rtr)) / Rtr))
  }
  if (Rtr <= EPS) {
    if (curY < y + h - EPS) step(x + w, y + h) // 直角角: 补右上角点
  } else if (trE > trS + EPS) {
    if (curY <= y + h - Rtr + EPS) step(x + w, y + h - Rtr)
    arc(x + w - Rtr, y + h - Rtr, trS, trE, Rtr)
    step((x + w - Rtr) + Rtr * Math.cos(trE), y + h)
  } else if (curY < y + h - EPS) {
    step(x + w, y + h)
  }

  // ===== 顶边 (右→左) =====
  let curTX = (x + w - Rtr) + Rtr * Math.cos(trE)
  for (const hx of tH) {
    const f = hx + jr
    if (f < curTX - EPS) step(f, y + h)
    holeArc(hx, y + h, 0, -Math.PI)
    curTX = Math.min(curTX, hx - jr)
  }

  // ===== 左上角弧 [TL]: 圆心 (x+Rtl, y+h-Rtl), θ ∈ [2.5π, 3π] =====
  let tlS = Math.PI * 2.5, tlE = Math.PI * 3
  if (Rtl > EPS && curTX < x + Rtl - EPS) {
    const p = Math.max(curTX, x)
    tlS = Math.PI * 2.5 + Math.acos(cv(-(p - (x + Rtl)) / Rtl))
  }
  if (Rtl > EPS && lH.length && lH[0] + jr > y + h - Rtl) {
    const p = Math.min(lH[0] + jr, y + h)
    tlE = Math.PI * 2.5 - Math.asin(cv((p - (y + h - Rtl)) / Rtl))
  }
  if (Rtl <= EPS) {
    if (curTX > x + EPS) step(x, y + h) // 直角角: 补左上角点
  } else if (tlE > tlS + EPS) {
    if (curTX >= x + Rtl - EPS) step(x + Rtl, y + h)
    arc(x + Rtl, y + h - Rtl, tlS, tlE, Rtl)
    step(x, (y + h - Rtl) + Rtl * Math.sin(tlE))
  } else if (curTX > x + EPS) {
    step(x, y + h)
  }

  // ===== 左边 (上→下) =====
  let curLY = (y + h - Rtl) + Rtl * Math.sin(tlE)
  for (const hy of lH) {
    const f = hy + jr
    if (f < curLY - EPS) step(x, f)
    holeArc(x, hy, Math.PI / 2, Math.PI * 1.5)
    curLY = Math.min(curLY, hy - jr)
  }
  // 回到 BL 弧起点
  const blStartY = (y + Rbl) + Rbl * Math.sin(blS)
  if (curLY > blStartY + EPS) step(x, blStartY)

  if (pts.length < 3) return
  shape.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
  shape.closePath()
}

/**
 * 竖向长圆孔(胶囊)路径: 短轴宽 width × 长轴长 length, 端部半圆 R = width/2。
 * 孔心 (cx, cy) 为胶囊中心 (mm, y 向上), 上/下端半圆圆心在 cy ± (length/2 - R)。
 * 注意: 独立 Path 加入 shape.holes 才能被 earcut 识别为孔; 绝不能追加到主轮廓上。
 * 端部半圆用 clockwise=true 保证在两段直线之间正确收尾 (与工程图胶囊一致)。
 */
function makeSlotHolePath(cx: number, cy: number, length: number, width: number): THREE.Path {
  const p = new THREE.Path()
  const r = width / 2
  const halfL = length / 2
  const topY = cy + halfL - r   // 上端半圆圆心 (y 向上)
  const botY = cy - halfL + r   // 下端半圆圆心
  p.moveTo(cx - r, botY)        // 左直边下端
  p.lineTo(cx - r, topY)        // 左直边上端
  p.absarc(cx, topY, r, Math.PI, 0, true)   // 上端半圆 (经顶部)
  p.lineTo(cx + r, botY)        // 右直边下端
  p.absarc(cx, botY, r, 0, Math.PI, true)   // 下端半圆 (经底部)
  p.closePath()
  return p
}

/**
 * 正交多边形外轮廓 (矩形或 L 型单凹角, 全局 mm, CCW) + 逐顶点圆角:
 *  roundIdx 中的凸角用四分之一圆角 (R = cornerRadius), 其余为直角。
 *  接缝/内部角全部直角 → 相邻板拼装平齐; 装配外凸角圆角 → 外观连续。
 */
function addOrthoOutline(
  shape: THREE.Shape,
  contour: { x: number; y: number }[],
  roundIdx: number[],
  R: number,
) {
  const n = contour.length
  const pts: [number, number][] = []
  const push = (x: number, y: number) => {
    const last = pts[pts.length - 1]
    if (!last || Math.abs(last[0] - x) > 1e-3 || Math.abs(last[1] - y) > 1e-3) pts.push([x, y])
  }
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    const N = Math.max(4, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)))
    for (let i = 1; i <= N; i++) {
      const th = a0 + (a1 - a0) * (i / N)
      pts.push([cx + R * Math.cos(th), cy + R * Math.sin(th)])
    }
  }

  for (let i = 0; i < n; i++) {
    const prev = contour[(i - 1 + n) % n]
    const cur = contour[i]
    const next = contour[(i + 1) % n]
    const d1 = { x: Math.sign(cur.x - prev.x), y: Math.sign(cur.y - prev.y) }
    const d2 = { x: Math.sign(next.x - cur.x), y: Math.sign(next.y - cur.y) }
    const cross = d1.x * d2.y - d1.y * d2.x
    if (R > 0 && roundIdx.includes(i) && cross > 0) {
      // CCW 凸角 90° 圆角:
      //   圆心 = 顶点 + 两条边内法线各偏移 R (内法线 = 行进方向左侧 (-dy, dx))
      //   切点 = 入边在顶点前 R 处 (cur - d1*R) / 出边在顶点后 R 处 (cur + d2*R)
      const n1 = { x: -d1.y, y: d1.x }
      const n2 = { x: -d2.y, y: d2.x }
      const cx = cur.x + (n1.x + n2.x) * R
      const cy = cur.y + (n1.y + n2.y) * R
      const sx = cur.x - d1.x * R, sy = cur.y - d1.y * R
      const ex = cur.x + d2.x * R, ey = cur.y + d2.y * R
      const a0 = Math.atan2(sy - cy, sx - cx)
      const aEnd = Math.atan2(ey - cy, ex - cx)
      let sweep = aEnd - a0
      while (sweep < 0) sweep += Math.PI * 2
      arc(cx, cy, a0, a0 + sweep)
    } else {
      push(cur.x, cur.y)
    }
  }

  if (pts.length < 3) return
  shape.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
  shape.closePath()
}

/**
 * 生成单块分割面板的 3D 网格 (与分割引擎输出 1:1 对应):
 *   - 外轮廓: 圆角矩形 (仅装配外轮廓凸角圆角, 接缝/内部角直角, 保证拼装紧密平齐)
 *   - 挖孔: slots 竖向长圆孔(胶囊) + round_holes 通圆孔，均贯穿全部板厚
 *   - edge_holes 候选孔（默认 φ5）：
 *       knocked=true  → 真实贯通孔
 *       false/缺省    → 实体保持完整，只叠加不参与导出的虚线位置提示
 *   - 拉伸厚度 = cfg.thickness (默认 5mm；PETG 宿舍洞洞板基准)
 * 坐标: 面板 mm 平面 (x 右, y 上), 网格 z 方向为厚度; 返回 Group (主体 + 可选提示线)
 */
function splitPanelHoleGroups(panel: SplitPanel) {
  const oc = panel.outerCorners ?? [true, true, true, true]
  const onEdge = (h: { x: number; y: number }) =>
    Math.abs(h.x - panel.x) < 0.5 || Math.abs(h.x - (panel.x + panel.w)) < 0.5 ||
    Math.abs(h.y - panel.y) < 0.5 || Math.abs(h.y - (panel.y + panel.h)) < 0.5
  const boundaryHoles = panel.edge_holes.filter(onEdge)
  const plannedHoles = panel.edge_holes.filter(h => !onEdge(h) && !h.knocked) // 仅虚线预览，实体板面保持完整
  const knockHoles = panel.edge_holes.filter(h => !onEdge(h) && !!h.knocked) // 已启用打孔: 真正贯通
  return { oc, boundaryHoles, plannedHoles, knockHoles }
}

/**
 * 单块板件的制造截面。3D 预览、4mm 基层切片和顶部 Lumina 模具必须共用这一
 * 个 Shape，避免分别近似外圆角、孔口和内轮廓后在切片软件中露出基层。
 */
export function createSplitPanelShape(panel: SplitPanel, cfg: SplitConfig): THREE.Shape {
  const { oc, boundaryHoles, knockHoles } = splitPanelHoleGroups(panel)
  const rr = {
    bl: oc[0] ? cfg.cornerRadius : 0,
    br: oc[1] ? cfg.cornerRadius : 0,
    tr: oc[2] ? cfg.cornerRadius : 0,
    tl: oc[3] ? cfg.cornerRadius : 0,
  }

  // 通孔路径：用户内轮廓 + 槽 + 通圆孔 + 当前启用的候选圆孔。
  const throughPaths: THREE.Path[] = []
  for (const cutout of panel.cutouts ?? []) {
    const path = makePolygonHolePath(cutout)
    if (path) throughPaths.push(path)
  }
  for (const s of panel.slots) {
    throughPaths.push(makeSlotHolePath(s.x, s.y, cfg.slotLength, cfg.slotWidth))
  }
  for (const rh of panel.round_holes) {
    throughPaths.push(makeCircleHolePath(rh.x, rh.y, cfg.jointDiameter))
  }
  for (const k of knockHoles) {
    throughPaths.push(makeCircleHolePath(k.x, k.y, cfg.jointDiameter))
  }
  const shape = new THREE.Shape()
  if (panel.contour && panel.contour.length >= 4) {
    addOrthoOutline(shape, panel.contour, panel.roundIdx ?? [], cfg.cornerRadius)
  } else {
    addPanelOutline(shape, panel.x, panel.y, panel.w, panel.h, rr, boundaryHoles, cfg.jointDiameter)
  }
  for (const hole of throughPaths) shape.holes.push(hole)
  return shape
}

export function generateSplitPanelMesh(opts: SplitPanelMeshOptions): THREE.Object3D {
  const { panel, cfg, color, curveSegments = 24, includeGuides = true, manufacturingChamfer = 0 } = opts

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.15,
    side: THREE.DoubleSide,
  })
  const { plannedHoles } = splitPanelHoleGroups(panel)
  const meshFrom = (depth: number) => {
    const shape = createSplitPanelShape(panel, cfg)
    const targetDepth = Math.max(0.05, depth)
    const chamfer = Math.max(0, Math.min(manufacturingChamfer, targetDepth / 3, cfg.slotWidth / 4))
    // ExtrudeGeometry 的倒角默认向 z 两端各外扩 bevelThickness；缩短中段并整体平移，
    // 使最终实体仍严格落在 z=0..targetDepth，避免导出板厚比参数多 2×倒角。
    const coreDepth = chamfer > 0.001 ? targetDepth - 2 * chamfer : targetDepth
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: coreDepth,
      bevelEnabled: chamfer > 0.001,
      bevelSize: chamfer,
      // ExtrudeGeometry 默认从轮廓向外扩 bevelSize，会在切片器里形成“蘑菇边”。
      // 从 -chamfer 开始倒角，使中间直壁保持设计轮廓，顶/底面向内收缩。
      bevelOffset: -chamfer,
      bevelThickness: chamfer,
      bevelSegments: 1,
      curveSegments,
    })
    if (chamfer > 0.001) geometry.translate(0, 0, chamfer)
    geometry.computeVertexNormals()
    return new THREE.Mesh(geometry, material)
  }

  const group = new THREE.Group()
  // 制造实体只有一整块板：未启用孔位不改变几何，启用后直接贯穿全部板厚。
  group.add(meshFrom(cfg.thickness))

  // 虚线只用于 3D 位置确认，不是 Mesh，因此制造导出器会自然忽略。
  if (includeGuides) {
    for (const h of plannedHoles) {
      group.add(makeHoleGuide(h.x, h.y, cfg.jointDiameter / 2, cfg.thickness + 0.035, curveSegments))
      group.add(makeHoleGuide(h.x, h.y, cfg.jointDiameter / 2, -0.035, curveSegments))
    }
  }
  return group
}

/** 未打孔位置的 3D 虚线圆，仅作交互提示，不参与 3MF。 */
function makeHoleGuide(cx: number, cy: number, radius: number, z: number, segments: number): THREE.LineLoop {
  const count = Math.max(24, segments)
  const points: THREE.Vector3[] = []
  for (let i = 0; i < count; i++) {
    const angle = Math.PI * 2 * i / count
    points.push(new THREE.Vector3(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z))
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineDashedMaterial({
    color: 0xffd166,
    dashSize: 1.2,
    gapSize: 0.8,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
  })
  const guide = new THREE.LineLoop(geometry, material)
  guide.computeLineDistances()
  guide.name = 'planned-hole-guide'
  guide.userData.previewOnly = true
  guide.renderOrder = 25
  return guide
}

/** 面板文字标签 (CanvasTexture Sprite, 显示 p1/p2... 编号) */
export function makePanelLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.font = 'bold 72px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    ctx.fillText(text, 128, 64)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(60, 30, 1)
  return sprite
}
