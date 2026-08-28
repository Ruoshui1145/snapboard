// ============ 草图工具管理器 — 交互状态机 v3 (按用户 CAD 工作逻辑重写) ============
// 工具: select / line(直线, 自动H/V推理) / rect / circle(实时半径+自动R标注) / arc(三点/圆心二级菜单)
//       polygon(边数可选+内切/外切+中心标记) / slot(两点定长→实时拖宽→R标注) / offset(等距)
//       eraser(点擦除=悬停高亮点击擦; 快速擦除=划线扫过全擦) / smartdim(自动选型)
// 属性面板: 选中轮廓 → 侧边栏切换 构造线/无限长度/内外轮廓 (构造线=虚线, 无限=无限延长)
// 吸附: 端点/中点/圆心 明显高亮 (金色圆环+十字+标签)
import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { ArcEntity, Constraint, Contour, Point2D, Sweep } from '../types/geometry'
import {
  CreateContourCommand, UpdateContourPointsCommand, AddConstraintCommand,
  RemoveContourCommand, TrimEdgeCommand, UpdateConstraintCommand,
  AddArcEntityCommand, RemoveArcEntityCommand, QuickTrimCommand,
  SplitEdgeCommand, TrimCircleSegmentsCommand, MergeContoursCommand,
  TrimEdgeSegmentCommand, TrimOpenEdgeRangeCommand,
} from '../commands/SketchCommands'
import { CompositeCommand } from '../commands/Command'
import {
  solveSketch, p2pDistance, horizontal, vertical, angle,
  type SolverConstraint,
} from '../engine/solver'
import { computeContourState, existingConstraintsToSolver } from '../engine/solveState'
import { screenToWorld } from '../engine/viewportCamera'
import {
  edgeArc, edgeCount, edgeMid, distToEdge, standaloneArc, contourCenter,
  updateArcsAfterVertexMove, ptSegDist,
} from '../utils/entities'
import {
  circumcenter, pointAngle, arcPointAt, sweepThrough, normAngle, arcMidAngle, arcSpan,
  getCircleArcSegments, circleSegmentDistance,
} from '../utils/arc'
import { offsetClosedPolygon } from '../utils/offset'
import { mergeOpenChainGroups } from '../utils/contourMerge'
import { stableAnchorIndex, withStableAnchor } from '../utils/sketchAnchor'
import { pointInDimensionLabel } from '../utils/dimensionLabel'
import { translateContourGeometry } from '../utils/constraintGeometry'
import {
  findCoincidentTrimRanges, findTrimRangeAtPoint,
  type StraightEdgeRef, type TrimRange,
} from '../utils/sketchTrim'

// ---- 阈值 (屏幕像素; 使用处经 screenToWorld 换算为世界单位) ----
const SNAP_RADIUS = 8    // 吸附阈值
const HIT_RADIUS = 12    // 边命中阈值
const CLOSE_RADIUS = 15  // line 闭合阈值
const CENTER_HIT = 10    // 圆心/弧心/多边形中心命中阈值
const GUIDE_TOL = 10     // 对齐引导阈值 (屏幕像素; 靠近即显示参考线)
const EDGE_SNAP_TOL = 6  // 在线吸附阈值 (落点在已有线上 → 分割成端点)

/** 工具操作提示 (画布底部提示条) */
const TOOL_HINTS: Partial<Record<string, string>> = {
  line: '点击添加顶点 (画线即实线) · 端点落到已有线上自动分割成端点 · 靠近起点闭合 · 双击结束 · 辅助线模式两点生成辅助线',
  rect: '两点矩形: 对角两点 · 中心矩形: 中心→角点 · 三点矩形: 边两点→拖宽 (工具栏切换)',
  circle: '圆心圆: 圆心→圆周 · 圆周圆(3点): 点三个圆周点 · 完成后点 R 数字可改',
  arc: '三点弧: 起点→终点→弧上点 (端点吸相邻顶点=直边变圆角); 菜单可切圆心弧',
  polygon: '点击中心 → 鼠标拖动: 距离定半径 + 方向定旋转角 (实时显示 R/边长/角度) → 点击确定',
  slot: '点击两点定长度 → 移动实时定宽度 → 点击确定 (显示 R=宽/2)',
  offset: '等距实体: 单击轮廓(整圈高亮) → 向外/内拖动实时预览 → 点击确定 (Esc 取消)',
  eraser: '点擦除: 点击公共边=按端点结构两侧修剪(交点成为端点); 快速擦除: 按住拖曲线扫擦',
  smartdim: '圆心/孔中心到外板边 · 孔边到外板边 · 点-点/点-线距离 · 长度 · 角度 · 半径/直径/弧长 → 点击放置改值',
}

/** 轮廓 id 计数器 (避免 Date.now() 同毫秒冲突) */
let _cid = 0
const newContourId = () => `c${Date.now()}_${++_cid}`
const newArcId = () => `arc-${Date.now()}_${++_cid}`
const newConsId = () => `cons-${Date.now()}_${++_cid}`
const rand = () => Math.random().toString(36).slice(2, 4)
const normDeg = (d: number) => ((d % 360) + 360) % 360

/** 两直线交点; 平行返回 null */
function lineCross(a1: Point2D, b1: Point2D, a2: Point2D, b2: Point2D): Point2D | null {
  const d1x = b1.x - a1.x, d1y = b1.y - a1.y
  const d2x = b2.x - a2.x, d2y = b2.y - a2.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((a2.x - a1.x) * d2y - (a2.y - a1.y) * d2x) / den
  return { x: a1.x + t * d1x, y: a1.y + t * d1y }
}

/** 输入框单例 (重复触发时移除旧框) */
let activeInput: HTMLInputElement | null = null

/** 吸附结果 */
interface SnapResult {
  x: number
  y: number
  label: string
}

/** 推理参考线 (对齐引导): 贯穿视口的横/竖虚线 */
export interface GuideLine {
  dir: 'h' | 'v'
  /** 引导线所在世界坐标 (h=y 值 / v=x 值) */
  at: number
  /** 参考点 (锚点或对齐的顶点) 菱形标记 */
  marker: Point2D
  /** axis=锁定轴参考线 / axis-soft=靠近轴仅提示 / align=与已有顶点对齐 */
  kind: 'axis' | 'axis-soft' | 'align'
}

/** 等距实体预览形状 (实时渲染) */
export interface OffsetPreviewShape {
  kind: 'circle' | 'slot' | 'arc' | 'poly'
  center?: Point2D
  r?: number
  p1?: Point2D
  p2?: Point2D
  w?: number
  pts?: Point2D[]
  points?: Point2D[]
  sweep?: Sweep
}

/** 绘制预览 (橡皮筋): 由 SketchViewport2D 叠加绘制 */
export interface SketchPreview {
  kind: 'pen' | 'rect' | 'rectCenter' | 'rect3pt' | 'circle' | 'circle3pt' | 'polygon' | 'slot' | 'drag' | 'arcCenter' | 'arc3pt' | 'eraserHover' | 'eraserSweep' | 'hover' | 'offsetPreview' | 'dimPlace'
  /** 已确认的点 / 拖动时的新点集 */
  points: Point2D[]
  /** 当前鼠标位置 (吸附后) */
  current: Point2D
  /** 吸附点高亮 (世界坐标) */
  snapPos: Point2D | null
  /** 吸附类型标签 */
  snapLabel?: string
  /** 推理参考线 (对齐引导) */
  guides?: GuideLine[]
  /** hover: 整轮廓高亮 (等距实体选型) */
  hoverWhole?: boolean
  /** 等距预览: 源轮廓 id / 当前偏移量 (像素) / 预览形状 */
  offsetContourId?: string
  offsetDist?: number
  offsetPreview?: OffsetPreviewShape
  /** 智能尺寸放置预览: 轮廓 id + 合成约束 (复用标注渲染) */
  dimContourId?: string
  dimCons?: Constraint
  /** drag 预览: 轮廓 id */
  contourId?: string
  /** drag 预览: 拖动的顶点索引 (高亮; -2=圆心 → undefined) */
  dragIdx?: number
  /** drag 预览: 圆的新圆心/半径 */
  center?: Point2D
  radius?: number
  /** drag 预览: 修改后的弧实体 (未修改用原轮廓的 arcs) */
  arcs?: ArcEntity[]
  /** eraserHover: 悬停的目标 */
  hoverContourId?: string
  hoverEdgeIdx?: number
  /** eraserHover: 当前几何求出的实际待删区间（用于“所见即所删”预览） */
  hoverT1?: number
  hoverT2?: number
  /** eraserSweep: 已标记的边 */
  sweepHits?: { contourId: string; edgeIdx: number }[]
  /** polygon 预览参数 */
  polygonSides?: number
  polygonCircumscribed?: boolean
}

interface ToolState {
  drawing: boolean
  start: Point2D | null
  penPoints: Point2D[]
  /** 槽口已确认的点 (两点定长度) */
  slotPts: Point2D[]
  /** 圆弧工具已确认的点 (arcCenter: [圆心,起点] / arc3pt: [起点,终点]) */
  arcPts: Point2D[]
  /** 三点矩形已确认的点 (p1, p2) */
  rectPts: Point2D[]
  /** 三点圆已确认的圆周点 */
  circlePts: Point2D[]
  /** 等距实体拖动状态 + 实时偏移量 (像素) */
  offset: { contourId: string; clickPos: Point2D } | null
  offsetD: number
  /** 智能尺寸放置阶段 (点完目标后拖动定位) */
  dimPlace: {
    contourId: string
    kind: 'length' | 'distance' | 'parallel' | 'pointline' | 'radius' | 'diameter' | 'angle'
      | 'arclength'
      /** 跨轮廓标注时第二条轮廓 id (缺省=同轮廓) */
      contourId2?: string
    edgeIndex?: number
    edgeIndex2?: number
    vertexIdx1?: number
    vertexIdx2?: number
  } | null
  /** 智能尺寸 第一阶段选中的边 */
  pendingEdge: { contourId: string; edgeIdx: number } | null
  /** 智能尺寸 第一阶段选中的顶点 (-2=圆心/中心, -3=固定草图原点) */
  pendingVertex: { contourId: string; vertexIdx: number } | null
  /** 顶点拖动状态 (vertexIdx=-2 表示圆心/弧心/多边形中心) */
  drag: { contourId: string; vertexIdx: number } | null
  /** 直边拖动状态 (平移整条边) */
  dragEdge: { contourId: string; edgeIdx: number } | null
  /** 圆拖动状态 (改半径) */
  dragCircle: { contourId: string } | null
  /** 弧边拖动状态 (过两端点+鼠标重拟圆) */
  dragArcEdge: { contourId: string; edgeIdx: number } | null
  /** 拖动按下时鼠标位置 (世界坐标) */
  dragStartPos: Point2D | null
  /** 拖动前原顶点 */
  dragOrig: Point2D[] | null
  /** 拖动中的新顶点 */
  dragNew: Point2D[] | null
  /** 拖动提交时的额外字段 (圆心/半径/arcs) */
  dragPatch: Partial<Contour> | null
  /** 本次按下是否发生过拖动 (抑制拖动结束后的 click) */
  dragged: boolean
  /** line 双击去重: 上一次点击位置/时间 */
  lastPenClick: { x: number; y: number; t: number } | null

  /** 快速擦除状态 (path=自由曲线轨迹) */
  eraser: { sweeping: boolean; startPos: Point2D | null; lastPos: Point2D | null; path: Point2D[]; hits: Map<string, number[]> }
  snap: { x: number; y: number; label: string } | null
}

const newToolState = (): ToolState => ({
  drawing: false, start: null, penPoints: [], slotPts: [], arcPts: [], rectPts: [], circlePts: [],
  offset: null, offsetD: 0, dimPlace: null, pendingEdge: null,
  pendingVertex: null, drag: null, dragEdge: null, dragCircle: null, dragArcEdge: null,
  dragStartPos: null, dragOrig: null, dragNew: null, dragPatch: null, dragged: false,
  lastPenClick: null, eraser: { sweeping: false, startPos: null, lastPos: null, path: [], hits: new Map() },
  snap: null,
})

/** 查找包含指定轮廓的草图 (project 中递归) */
function findSketchWithContour(contourId: string) {
  const s = useAppStore.getState()
  for (const part of s.project.parts) {
    for (const f of part.features) {
      if (f.type === 'sketch' && f.contours.some(c => c.id === contourId)) {
        return f
      }
    }
  }
  return null
}

/** 按 id 找轮廓 */
function findContour(contourId: string): Contour | null {
  const sketch = findSketchWithContour(contourId)
  return sketch?.type === 'sketch'
    ? sketch.contours.find(c => c.id === contourId) ?? null
    : null
}

/** 圆的 4 个采样点 (用于命中检测与存储) */
function circlePoints(center: Point2D, r: number): Point2D[] {
  return [
    { x: center.x, y: center.y - r }, { x: center.x + r, y: center.y },
    { x: center.x, y: center.y + r }, { x: center.x - r, y: center.y },
  ]
}

/** 点到无限直线距离 */
function distToInfiniteLine(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}

/** 线段-线段交点 (含参数约束, 端部余量 2%); 无交点返回 null */
function segSegIntersect(a1: Point2D, b1: Point2D, a2: Point2D, b2: Point2D): Point2D | null {
  const d1x = b1.x - a1.x, d1y = b1.y - a1.y
  const d2x = b2.x - a2.x, d2y = b2.y - a2.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((a2.x - a1.x) * d2y - (a2.y - a1.y) * d2x) / den
  const u = ((a2.x - a1.x) * d1y - (a2.y - a1.y) * d1x) / den
  if (t < 0.02 || t > 0.98 || u < 0.02 || u > 0.98) return null
  return { x: a1.x + t * d1x, y: a1.y + t * d1y }
}

/** 线段-无限线交点; 无交点返回 null */
function segInfiniteIntersect(a: Point2D, b: Point2D, p0: Point2D, p1: Point2D): Point2D | null {
  const d1x = b.x - a.x, d1y = b.y - a.y
  const d2x = p1.x - p0.x, d2y = p1.y - p0.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((p0.x - a.x) * d2y - (p0.y - a.y) * d2x) / den
  if (t < 0.02 || t > 0.98) return null
  return { x: a.x + t * d1x, y: a.y + t * d1y }
}

/** 点到线段最近点 */
function closestOnSeg(p: Point2D, a: Point2D, b: Point2D): Point2D {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 === 0) return { ...a }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/** 是否"正交板子"类轮廓: 每条边近似水平/垂直 (矩形/凸形/凹形/L形等规整轮廓, 闭合开放均可) */
function isOrtho(c: Contour): boolean {
  if (c.points.length < 3 || c.shape || c.slotWidth !== undefined) return false
  const n = c.points.length
  const total = c.closed && n > 2 ? n : n - 1
  for (let i = 0; i < total; i++) {
    const a = c.points[i], b = c.points[(i + 1) % n]
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y)
    // 允许轻微浮点偏差：只要一条轴明显占优，就按正交处理并锁定 H/V
    if (Math.min(dx, dy) > Math.max(dx, dy) * 0.15) return false
  }
  return true
}

/** 几何闭合判定: 轮廓标记闭合, 或首尾点重合 (擦除公共边后仍是一个闭合环) */
function isClosedGeo(c: Contour): boolean {
  if (c.closed) return true
  const pts = c.points
  if (pts.length < 3) return false
  return Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) < CLOSE_RADIUS
}

/**
 * 正交轮廓尺寸驱动求解 (统一入口):
 *  - 全边 H/V 约束 (solver 内部 autoOrtho 去重) → 保证结果仍是正交多边形
 *  - 几何闭合判定: 端点重合的"开放"轮廓按闭合求解 (缺闭合边约束正是变梯形的根因)
 *  - 真开放链 (有缺口): 补其它边长度保持约束 → 完全约束, 只动目标边, 不会漂移
 */
async function orthoSolve(
  c: Contour,
  extra: SolverConstraint[],
  pixelToMM: number,
  replaceId?: string,
  lengthKeep?: { exclude: Set<number> },
) {
  const n = c.points.length
  const closed = isClosedGeo(c)
  const geom: SolverConstraint[] = []
  for (let i = 0; i < n; i++) {
    const a = c.points[i], b = c.points[(i + 1) % n]
    const isH = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
    geom.push(isH ? horizontal(i, (i + 1) % n) : vertical(i, (i + 1) % n))
  }
  // 真开放链: 保持其它边原长, 防止欠约束漂移成梯形
  if (!closed && lengthKeep) {
    const total = n - 1 // 开放链只有 n-1 条边
    for (let i = 0; i < total; i++) {
      if (lengthKeep.exclude.has(i)) continue
      const a = c.points[i], b = c.points[(i + 1) % n]
      geom.push(p2pDistance(i, (i + 1) % n, Math.hypot(b.x - a.x, b.y - a.y)))
    }
  }
  geom.push(...existingConstraintsToSolver(c, pixelToMM, replaceId), ...extra)
  return solveSketch(c.points, geom, { fixedIndices: [stableAnchorIndex(c)], closed })
}

/** 将一组点尽量“正交化”：每条边按原/当前主轴方向锁成水平或垂直 */
function snapOrthogonalPoints(points: Point2D[], closed: boolean): Point2D[] {
  const n = points.length
  if (n < 2) return points.map(p => ({ ...p }))
  const result = points.map(p => ({ ...p }))
  const total = closed && n > 2 ? n : n - 1
  for (let iter = 0; iter < 2; iter++) {
    const xs: number[][] = Array.from({ length: n }, () => [])
    const ys: number[][] = Array.from({ length: n }, () => [])
    for (let i = 0; i < total; i++) {
      const j = (i + 1) % n
      const dx = Math.abs(result[j].x - result[i].x)
      const dy = Math.abs(result[j].y - result[i].y)
      const minAxis = Math.min(dx, dy)
        const maxAxis = Math.max(dx, dy)
        if (maxAxis > 1e-6 && minAxis <= maxAxis * 0.15 && dx >= dy) {
        ys[i].push(result[j].y)
        ys[j].push(result[i].y)
      } else {
        xs[i].push(result[j].x)
        xs[j].push(result[i].x)
      }
    }
    for (let i = 0; i < n; i++) {
      if (xs[i].length > 0) result[i].x = xs[i].reduce((a, b) => a + b, 0) / xs[i].length
      if (ys[i].length > 0) result[i].y = ys[i].reduce((a, b) => a + b, 0) / ys[i].length
    }
  }
  return result
}

/** 校验多边形是否退化：边长过短 / 自相交 / 相邻点重合 */
function isValidPolygon(points: Point2D[], closed: boolean): boolean {
  const n = points.length
  if (n < 2) return false
  const total = closed && n > 2 ? n : n - 1
  for (let i = 0; i < total; i++) {
    const a = points[i], b = points[(i + 1) % n]
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return false
  }
  if (!closed || n < 4) return true
  // 检查非相邻边是否相交（端点接触不算）
  for (let i = 0; i < n; i++) {
    const a1 = points[i], b1 = points[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue
      const a2 = points[j], b2 = points[(j + 1) % n]
      const ip = segSegIntersect(a1, b1, a2, b2)
      if (ip) return false
    }
  }
  return true
}
export { snapOrthogonalPoints, isValidPolygon }

export function useSketchTool() {
  const activeTool = useAppStore(s => s.ui.activeTool)
  const stateRef = useRef<ToolState>(newToolState())
  const [snapState, setSnapState] = useState<{ x: number; y: number; label: string } | null>(null)
  const [preview, setPreview] = useState<SketchPreview | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [hoverConstraint, setHoverConstraint] = useState<{ contourId: string; constraintId: string } | null>(null)

  // 工具切换: 清空全部残留状态 (修复: 半成品"幽灵完成"、残留点)
  useEffect(() => {
    stateRef.current = newToolState()
    setSnapState(null)
    setPreview(null)
    setHint(TOOL_HINTS[activeTool] ?? null)
    setHoverConstraint(null)
  }, [activeTool])

  // ---- 几何命中检测 ----

  /** 命中测试: 返回 { contourId, edgeIdx } 或 null (edgeIdx=-1 表示圆) */
  function hitTest(pos: Point2D): { contourId: string; edgeIdx: number } | null {
    const s = useAppStore.getState()
    let best: { contourId: string; edgeIdx: number } | null = null
    let bd = screenToWorld(HIT_RADIUS)
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        for (const c of f.contours) {
          // 无限构造线: 用点到无限直线距离
          if (c.construction && c.infinite && c.points.length >= 2 && !c.closed) {
            const d = distToInfiniteLine(pos, c.points[0], c.points[1])
            if (d < bd) { bd = d; best = { contourId: c.id, edgeIdx: 0 } }
            continue
          }
          // 圆: 修剪工具下按“圆与多边形交点拆出的圆弧段”命中; 其他工具仍按整圆
          if (c.shape === 'circle' && c.center && c.radius) {
            const d = Math.abs(Math.hypot(pos.x - c.center.x, pos.y - c.center.y) - c.radius)
            if (s.ui.activeTool === 'eraser') {
                const segments = getCircleArcSegments(c, f.contours)
                if (segments && segments.length >= 2) {
                  for (let i = 0; i < segments.length; i++) {
                    const sd = circleSegmentDistance(pos, segments[i])
                    if (sd < bd) { bd = sd; best = { contourId: c.id, edgeIdx: i } }
                  }
                  continue
                }
              }
              if (d < bd) { bd = d; best = { contourId: c.id, edgeIdx: -1 } }
            continue
          }
          // 折线 + 弧实体边
          const total = edgeCount(c)
          for (let i = 0; i < total; i++) {
            const d = distToEdge(pos, c, i)
            if (d < bd) { bd = d; best = { contourId: c.id, edgeIdx: i } }
          }
        }
      }
    }
    return best
  }

  /** 顶点命中 (拖动用): vertexIdx=-2 表示圆心/弧心/多边形中心 */
  function vertexHit(pos: Point2D): { contourId: string; vertexIdx: number } | null {
    const s = useAppStore.getState()
    const bd = screenToWorld(SNAP_RADIUS)
    // 原点是不可移动的草图基准。使用特殊轮廓 id / 顶点 -3，不写入普通几何。
    const originD = Math.hypot(pos.x, pos.y)
    let best: { contourId: string; vertexIdx: number } | null = originD < bd
      ? { contourId: '__sketch_origin__', vertexIdx: -3 }
      : null
    let bestD = originD < bd ? originD : bd
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        for (const c of f.contours) {
          if (c.shape === 'circle') {
            // 圆: 仅圆心可中心命中
            if (c.center) {
              const d = Math.hypot(pos.x - c.center.x, pos.y - c.center.y)
              if (d < bestD && d < screenToWorld(CENTER_HIT)) {
                bestD = d
                best = { contourId: c.id, vertexIdx: -2 }
              }
            }
            continue
          }
          const cc = contourCenter(c)
          if (cc) {
            // 独立圆弧/多边形: 中心可命中 (整体平移)
            const d = Math.hypot(pos.x - cc.x, pos.y - cc.y)
            if (d < bestD && d < screenToWorld(CENTER_HIT)) {
              bestD = d
              best = { contourId: c.id, vertexIdx: -2 }
            }
          }
          for (let i = 0; i < c.points.length; i++) {
            const d = Math.hypot(pos.x - c.points[i].x, pos.y - c.points[i].y)
            if (d < bestD) { bestD = d; best = { contourId: c.id, vertexIdx: i } }
          }
        }
      }
    }
    return best
  }

  /** 定位与坐标重合的顶点 (圆弧工具端点吸附检测用): 返回 { contourId, idx } 或 null */
  function findVertex(pos: Point2D): { contourId: string; idx: number } | null {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        for (const c of f.contours) {
          for (let i = 0; i < c.points.length; i++) {
            const p = c.points[i]
            if (Math.hypot(pos.x - p.x, pos.y - p.y) <= 0.5) return { contourId: c.id, idx: i }
          }
        }
      }
    }
    return null
  }

  /** 约束标注命中 (智能尺寸编辑): 返回 { contourId, constraintId } 或 null */
  function constraintHit(pos: Point2D): { contourId: string; constraintId: string } | null {
    const s = useAppStore.getState()
    const worldPerScreenPx = screenToWorld(1)
    let best: { contourId: string; constraintId: string; distance: number } | null = null
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        for (const c of f.contours) {
          for (const cons of c.constraints) {
            if (!cons.labelPos) continue
            if (pointInDimensionLabel(cons.label, cons.labelPos.x, cons.labelPos.y, pos.x, pos.y, worldPerScreenPx)) {
              const distance = Math.hypot(pos.x - cons.labelPos.x, pos.y - cons.labelPos.y)
              if (!best || distance < best.distance) best = { contourId: c.id, constraintId: cons.id, distance }
            }
          }
        }
      }
    }
    return best ? { contourId: best.contourId, constraintId: best.constraintId } : null
  }

  // ---- 吸附系统 ----

  /** 计算吸附点: 顶点 > 中点 > 圆心 (阈值 8px 屏幕; 弧边中点为弧中; 构造线不吸中点) */
  function computeSnap(pos: Point2D): SnapResult {
    const s = useAppStore.getState()
    const originD = Math.hypot(pos.x, pos.y)
    let bd = screenToWorld(SNAP_RADIUS)
    // 原点优先级高于中点/圆心，并与普通端点共用相同屏幕吸附半径。
    let best: SnapResult | null = originD < bd ? { x: 0, y: 0, label: '原点' } : null
    if (best) bd = originD
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        for (const c of f.contours) {
          // 顶点
          for (const p of c.points) {
            const d = Math.hypot(pos.x - p.x, pos.y - p.y)
            if (d < bd) {
              bd = d
              best = { x: p.x, y: p.y, label: c.shape === 'circle' ? '圆上点' : '端点' }
            }
          }
          // 边中点 (含闭合边; 弧边为弧中; 构造线不吸中点)
          if (!c.construction) {
            const total = edgeCount(c)
            for (let i = 0; i < total; i++) {
              const m = edgeMid(c, i)
              const d = Math.hypot(pos.x - m.x, pos.y - m.y)
              if (d < bd) { bd = d; best = { x: m.x, y: m.y, label: '中点' } }
            }
          }
          // 圆心/中心 (低优先级: 距离需更近才命中)
          const cc = contourCenter(c)
          if (cc) {
            const d = Math.hypot(pos.x - cc.x, pos.y - cc.y)
            if (d < bd && d < screenToWorld(CENTER_HIT)) {
              bd = d
              best = { x: cc.x, y: cc.y, label: c.shape === 'polygon' ? '中心' : '圆心' }
            }
          }
        }
      }
    }
    return best ?? { x: pos.x, y: pos.y, label: '' }
  }

  /** 在线吸附: 最近直边投影 (严格内部); 落点吸附 → 分割成端点 */
  function edgeSnapPoint(pos: Point2D): { contourId: string; edgeIdx: number; point: Point2D } | null {
    const s = useAppStore.getState()
    const bd = screenToWorld(EDGE_SNAP_TOL)
    let best: { contourId: string; edgeIdx: number; point: Point2D } | null = null
    let bestD = bd
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        for (const c of f.contours) {
          if (c.shape === 'circle' || c.slotWidth !== undefined || c.construction) continue
          const total = edgeCount(c)
          const n = c.points.length
          for (let i = 0; i < total; i++) {
            if (edgeArc(c, i)) continue
            const a = c.points[i], b = c.points[(i + 1) % n]
            const q = closestOnSeg(pos, a, b)
            // 仅在严格内部吸附 (端部交给顶点吸附)
            const segLen = Math.hypot(b.x - a.x, b.y - a.y)
            if (segLen > 1e-6) {
              const tq = ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (segLen * segLen)
              if (tq < 0.06 || tq > 0.94) continue
            }
            const d = Math.hypot(pos.x - q.x, pos.y - q.y)
            if (d < bestD) { bestD = d; best = { contourId: c.id, edgeIdx: i, point: q } }
          }
        }
      }
    }
    return best
  }

  /**
   * 推理参考线 (对齐引导):
   * 1) 相对锚点近似水平/竖直 → 横/竖参考线 (靠近即提示, 比值触发锁定对齐)
   * 2) 与已有几何顶点/中心的 X 或 Y 坐标一致 (阈值内) → 对齐引导线 + 单轴吸附
   *    (画矩形闭环时, 移动点对齐第一顶点的 X 和第三顶点的 Y 自动组合成角点)
   */
  function computeGuides(anchor: Point2D, pos: Point2D): { x: number; y: number; guides: GuideLine[]; label: string } {
    let x = pos.x, y = pos.y
    const guides: GuideLine[] = []
    let label = ''
    const hasGuide = (dir: 'h' | 'v', at: number) => guides.some(g => g.dir === dir && Math.abs(g.at - at) < 1e-6)

    // 1) 相对锚点水平/竖直 (两段式: 靠近即显示参考线, 比值触发锁定)
    const dx = pos.x - anchor.x, dy = pos.y - anchor.y
    const nearH = Math.abs(dy) < screenToWorld(GUIDE_TOL) && Math.abs(dx) > screenToWorld(4)
    const nearV = Math.abs(dx) < screenToWorld(GUIDE_TOL) && Math.abs(dy) > screenToWorld(4)
    const lockH = nearH && Math.abs(dx) > 3 * Math.abs(dy)
    const lockV = nearV && Math.abs(dy) > 3 * Math.abs(dx)
    if (nearH) {
      guides.push({ dir: 'h', at: anchor.y, marker: { ...anchor }, kind: lockH ? 'axis' : 'axis-soft' })
      if (lockH) { y = anchor.y; label = '水平' }
    }
    if (nearV) {
      guides.push({ dir: 'v', at: anchor.x, marker: { ...anchor }, kind: lockV ? 'axis' : 'axis-soft' })
      if (lockV) { x = anchor.x; label = label || '竖直' }
    }

    // 2) 与已有几何 X/Y 坐标对齐 (已锁定轴不再对齐; 锚点自身坐标排除, 避免静止时自对齐噪声)
    const s = useAppStore.getState()
    const tol = screenToWorld(GUIDE_TOL)
    const cands: Point2D[] = []
      // 当前正在绘制的折线点也参与对齐 (闭合时能捕捉到第一个端点)
      for (const p of stateRef.current.penPoints) cands.push(p)
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        for (const c of f.contours) {
          for (const p of c.points) cands.push(p)
          const cc2 = contourCenter(c)
          if (cc2) cands.push(cc2)
        }
      }
    }
    let bx: { at: number; marker: Point2D } | null = null
    let bxd = tol
    let by: { at: number; marker: Point2D } | null = null
    let byd = tol
    for (const p of cands) {
      if (Math.hypot(p.x - anchor.x, p.y - anchor.y) < 1) continue
      const dxx = Math.abs(x - p.x)
      if (dxx < bxd) { bxd = dxx; bx = { at: p.x, marker: { ...p } } }
      const dyy = Math.abs(y - p.y)
      if (dyy < byd) { byd = dyy; by = { at: p.y, marker: { ...p } } }
    }
    if (bx && !lockV) {
      x = bx.at
      if (!hasGuide('v', bx.at)) guides.push({ dir: 'v', at: bx.at, marker: bx.marker, kind: 'align' })
      if (!label) label = '对齐'
    }
    if (by && !lockH) {
      y = by.at
      if (!hasGuide('h', by.at)) guides.push({ dir: 'h', at: by.at, marker: by.marker, kind: 'align' })
      if (!label) label = '对齐'
    }
    return { x, y, guides, label }
  }

  // ---- 求解状态检查 (约束操作后调用): 轮廓状态色 ----

  async function checkState(contourId: string) {
    const c = findContour(contourId)
    if (!c) return
    const s = useAppStore.getState()
    const st = await computeContourState(c, s.project.config.pixelToMM)
    s.setUI({ solveStates: { ...s.ui.solveStates, [contourId]: st } })
  }

  // ---- 鼠标按下: select 拖动检测 / 快速擦除 ----

  const handleDown = useCallback((pos: Point2D) => {
    const st = stateRef.current
    st.dragged = false   // 新一次按下: 清除上次拖动的残留标记
    const s = useAppStore.getState()

    // 快速擦除: 开始扫线
    if (s.ui.activeTool === 'eraser' && s.ui.eraserMode === 'sweep') {
      st.eraser = { sweeping: true, startPos: pos, lastPos: pos, path: [{ ...pos }], hits: new Map() }
      const hit = hitTest(pos)
      if (hit) st.eraser.hits.set(hit.contourId, [hit.edgeIdx])
      setPreview({
        kind: 'eraserSweep', points: [{ ...pos }], current: pos, snapPos: null,
        sweepHits: [...st.eraser.hits].flatMap(([cid, es]) => es.map(e => ({ contourId: cid, edgeIdx: e }))),
      })
      return
    }
    if (s.ui.activeTool !== 'select') return

    // 顶点/圆心命中 → 顶点拖动
    const vh = vertexHit(pos)
    if (vh) {
      const c = findContour(vh.contourId)
      if (!c) return
      st.drag = vh
      st.dragStartPos = pos
      st.dragOrig = c.points.map(p => ({ ...p }))
      st.dragNew = null
      st.dragPatch = null
      s.setUI({ selectedContourId: vh.contourId })
      return
    }
    // 边命中: 圆 → 圆心近移/圆周改半径; 弧边 → 弧身拖动; 直边 → 平移边
    const hit = hitTest(pos)
    if (!hit) return
    const c = findContour(hit.contourId)
    if (!c) return
    if (hit.edgeIdx === -1 && c.shape === 'circle' && c.center) {
      const cd = Math.hypot(pos.x - c.center.x, pos.y - c.center.y)
      if (cd < screenToWorld(CENTER_HIT)) {
        st.drag = { contourId: c.id, vertexIdx: -2 }
      } else {
        st.dragCircle = { contourId: c.id }
      }
    } else if (hit.edgeIdx >= 0) {
      if (edgeArc(c, hit.edgeIdx)) {
        st.dragArcEdge = { contourId: c.id, edgeIdx: hit.edgeIdx }
      } else {
        st.dragEdge = hit
      }
    } else {
      return
    }
    st.dragStartPos = pos
    st.dragOrig = c.points.map(p => ({ ...p }))
    st.dragNew = null
    st.dragPatch = null
    s.setUI({ selectedContourId: c.id })
  }, [])

  // ---- 鼠标移动: 拖动 + 实时预览 ----

  const handleMove = useCallback((pos: Point2D) => {
    const st = stateRef.current
    const s = useAppStore.getState()

    // 悬停约束标注 (所有工具生效): 高亮 + 手型光标 + 点击改值
    setHoverConstraint(constraintHit(pos))

    // 快速擦除: 自由曲线轨迹采样 (线段沿途取样, 扫过的边无遗漏)
    if (st.eraser.sweeping) {
      const prev = st.eraser.lastPos ?? pos
      const dist = Math.hypot(pos.x - prev.x, pos.y - prev.y)
      if (dist > 1) {
        st.eraser.path.push({ ...pos })
        const step = screenToWorld(4)
        const segs = Math.max(1, Math.ceil(dist / step))
        for (let k = 1; k <= segs; k++) {
          const t = k / segs
          const sp = { x: prev.x + (pos.x - prev.x) * t, y: prev.y + (pos.y - prev.y) * t }
          const hit = hitTest(sp)
          if (hit) {
            const arr = st.eraser.hits.get(hit.contourId)
            if (arr) { if (!arr.includes(hit.edgeIdx)) arr.push(hit.edgeIdx) }
            else st.eraser.hits.set(hit.contourId, [hit.edgeIdx])
          }
        }
        st.eraser.lastPos = pos
      }
      setPreview({
        kind: 'eraserSweep', points: st.eraser.path.map(p => ({ ...p })), current: pos, snapPos: null,
        sweepHits: [...st.eraser.hits].flatMap(([cid, es]) => es.map(e => ({ contourId: cid, edgeIdx: e }))),
      })
      return
    }

    // 点擦除悬停高亮
    if (s.ui.activeTool === 'eraser' && s.ui.eraserMode === 'point') {
      const hit = hitTest(pos)
      if (!hit) {
        setPreview(null)
        return
      }
      const contour = findContour(hit.contourId)
      if (contour && hit.edgeIdx >= 0 && !edgeArc(contour, hit.edgeIdx) && contour.shape === undefined) {
        const edges = collectStraightEdges()
        const target = edges.find(edge => edge.contourId === hit.contourId && edge.edgeIdx === hit.edgeIdx)
        const range = target ? resolveTrimRange(target, pos, edges) : null
        setPreview({
          kind: 'eraserHover', points: [], current: pos, snapPos: null,
          hoverContourId: hit.contourId, hoverEdgeIdx: hit.edgeIdx,
          hoverT1: range?.t1, hoverT2: range?.t2,
        })
      } else {
        setPreview({ kind: 'eraserHover', points: [], current: pos, snapPos: null, hoverContourId: hit.contourId, hoverEdgeIdx: hit.edgeIdx })
      }
      return
    }

    // 拖动中: 计算新顶点集 (+ 推理参考线)
    if (st.drag || st.dragEdge || st.dragCircle || st.dragArcEdge) {
      const cid = st.drag?.contourId ?? st.dragEdge?.contourId ?? st.dragCircle?.contourId ?? st.dragArcEdge?.contourId
      const c = cid ? findContour(cid) : null
      if (!c || !st.dragStartPos || !st.dragOrig) return
      const delta = { x: pos.x - st.dragStartPos.x, y: pos.y - st.dragStartPos.y }
      let newPts: Point2D[] = st.dragOrig
      let patch: Partial<Contour> | null = null
      let center: Point2D | undefined
      let radius: number | undefined
      let guides: GuideLine[] | undefined
      let snapPt: Point2D | null = null
      let snapLbl: string | undefined
      if (st.drag) {
        const d = st.drag
        if (d.vertexIdx === -2) {
          // 圆心/弧心/多边形中心拖动: 整体平移 (+ 中心对齐引导)
          const cc = contourCenter(c)
          if (cc) {
            const cand = { x: cc.x + delta.x, y: cc.y + delta.y }
            const g = computeGuides(cc, cand)
            const fdx = delta.x + (g.x - cand.x), fdy = delta.y + (g.y - cand.y)
            newPts = st.dragOrig.map(p => ({ x: p.x + fdx, y: p.y + fdy }))
            const nc = { x: cc.x + fdx, y: cc.y + fdy }
            if (c.center) {
              patch = { center: nc }
            } else {
              const arc = standaloneArc(c)
              if (arc) patch = { arcs: (c.arcs ?? []).map(a => a.id === arc.id ? { ...a, center: nc } : a) }
            }
            center = nc
            radius = c.radius ?? standaloneArc(c)?.radius
            guides = g.guides.length ? g.guides : undefined
            if (g.guides.length) { snapPt = { x: g.x, y: g.y }; snapLbl = g.label || undefined }
          }
        } else {
          newPts = st.dragOrig.map((p, i) => {
            if (i !== d.vertexIdx) return p
            const cand = { x: p.x + delta.x, y: p.y + delta.y }
            const g = computeGuides(p, cand)
            guides = g.guides.length ? g.guides : undefined
            if (g.guides.length) { snapPt = { x: g.x, y: g.y }; snapLbl = g.label || undefined }
            return { x: g.x, y: g.y }
          })
          // 弧实体端点移动 → 重拟合 (保持通过两端点)
          const arcs = updateArcsAfterVertexMove(c.arcs, newPts, d.vertexIdx)
          if (arcs !== undefined && arcs !== c.arcs) patch = { arcs }
        }
      } else if (st.dragCircle) {
        // 圆周拖动: 改半径 (下限 2px, 带圆心放射引导)
        const cc = c.center
        if (!cc) return
        const g = computeGuides(cc, pos)
        const r = Math.max(2, Math.hypot(g.x - cc.x, g.y - cc.y))
        newPts = circlePoints(cc, r)
        patch = { radius: r }
        center = cc
        radius = r
        guides = g.guides.length ? g.guides : undefined
        if (g.guides.length) { snapPt = { x: g.x, y: g.y }; snapLbl = g.label || undefined }
      } else if (st.dragArcEdge) {
        // 弧身拖动: 过两端点 + 鼠标位置重拟圆
        const arc = edgeArc(c, st.dragArcEdge.edgeIdx)
        if (!arc) return
        const A = c.points[arc.p1], B = c.points[arc.p2]
        const cc = circumcenter(A, B, pos)
        if (cc && cc.radius > 1) {
          const sweep = sweepThrough(cc.center, A, B, pos)
          newPts = st.dragOrig.map(p => ({ ...p }))
          patch = {
            arcs: (c.arcs ?? []).map(a => a.id === arc.id
              ? { ...a, center: { ...cc.center }, radius: cc.radius, sweep }
              : a),
          }
          center = cc.center
          radius = cc.radius
        } else {
          return
        }
      } else {
        // 直边平移: 两端点同向量移动 (+ 边中点对齐引导)
        const { edgeIdx } = st.dragEdge!
        const n = c.points.length
        const mid0 = {
          x: (st.dragOrig[edgeIdx].x + st.dragOrig[(edgeIdx + 1) % n].x) / 2,
          y: (st.dragOrig[edgeIdx].y + st.dragOrig[(edgeIdx + 1) % n].y) / 2,
        }
        const cand = { x: mid0.x + delta.x, y: mid0.y + delta.y }
        const g = computeGuides(mid0, cand)
        const fdx = delta.x + (g.x - cand.x), fdy = delta.y + (g.y - cand.y)
        newPts = st.dragOrig.map((p, i) =>
          (i === edgeIdx || i === (edgeIdx + 1) % n) ? { x: p.x + fdx, y: p.y + fdy } : p)
        const arcsA = updateArcsAfterVertexMove(c.arcs, newPts, edgeIdx)
        const arcsB = updateArcsAfterVertexMove(arcsA ?? c.arcs, newPts, (edgeIdx + 1) % n)
        if (arcsB !== undefined && arcsB !== c.arcs) patch = { arcs: arcsB }
        guides = g.guides.length ? g.guides : undefined
        if (g.guides.length) { snapPt = { x: g.x, y: g.y }; snapLbl = g.label || undefined }
      }
      st.dragNew = newPts
      st.dragPatch = patch
      const moved = newPts.some((p, i) => Math.hypot(p.x - st.dragOrig![i].x, p.y - st.dragOrig![i].y) > 0.5)
      st.dragged = st.dragged || moved
      setPreview({
        kind: 'drag',
        points: newPts,
        current: pos,
        snapPos: snapPt,
        snapLabel: snapLbl,
        guides,
        contourId: cid,
        dragIdx: st.drag?.vertexIdx === -2 ? undefined : st.drag?.vertexIdx,
        center,
        radius,
        arcs: patch?.arcs ?? c.arcs,
      })
      return
    }

    /** 悬停吸附标记 (所有工具落点前) */
    const hoverMarker = (pos2: Point2D) => {
      const snapped = computeSnap(pos2)
      setPreview(snapped.label
        ? { kind: 'hover', points: [], current: pos2, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label }
        : null)
    }

    /** 通用第二点预览: 吸附优先, 否则推理参考线 */
    const previewFrom = (kind: SketchPreview['kind'], anchor: Point2D, pos2: Point2D, extra: Partial<SketchPreview> = {}) => {
      const snapped = computeSnap(pos2)
      if (snapped.label) {
        setPreview({ kind, points: [{ ...anchor }], current: snapped, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label, ...extra })
      } else {
        const g = computeGuides(anchor, pos2)
        setPreview({
          kind, points: [{ ...anchor }], current: { x: g.x, y: g.y },
          snapPos: g.guides.length ? { x: g.x, y: g.y } : null, snapLabel: g.label || undefined, guides: g.guides, ...extra,
        })
      }
    }

    const tool = s.ui.activeTool
    switch (tool) {
      // 选择: 悬停顶点/中点/圆心/中心高亮, 或边微高亮
      case 'select': {
        const snapped = computeSnap(pos)
        if (snapped.label) {
          setPreview({ kind: 'hover', points: [], current: pos, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label })
          break
        }
        const hit = hitTest(pos)
        setPreview(hit
          ? { kind: 'hover', points: [], current: pos, snapPos: null, hoverContourId: hit.contourId, hoverEdgeIdx: hit.edgeIdx }
          : null)
        break
      }
      // 智能尺寸: 放置阶段实时预览 → 否则悬停顶点/边高亮
      case 'smartdim': {
        if (st.dimPlace) {
          const dc = findContour(st.dimPlace.contourId)
          if (!dc) { st.dimPlace = null; setPreview(null); return }
          const cons = buildDimPreviewCons(dc, st.dimPlace, pos)
          if (cons) {
            setPreview({ kind: 'dimPlace', points: [], current: pos, snapPos: null, dimContourId: st.dimPlace.contourId, dimCons: cons })
          }
          return
        }
        const vh = vertexHit(pos)
        if (vh) {
          const vc = findContour(vh.contourId)
          const p = vh.vertexIdx === -3
            ? { x: 0, y: 0 }
            : vc ? (vh.vertexIdx === -2 ? contourCenter(vc) : vc.points[vh.vertexIdx]) : null
          if (p) {
            const lbl = vh.vertexIdx === -3 ? '固定原点' : vh.vertexIdx === -2 ? (vc?.shape === 'polygon' ? '中心' : '圆心') : '端点'
            setPreview({ kind: 'hover', points: [], current: pos, snapPos: p, snapLabel: lbl })
            break
          }
        }
        const hit = hitTest(pos)
        setPreview(hit
          ? { kind: 'hover', points: [], current: pos, snapPos: null, hoverContourId: hit.contourId, hoverEdgeIdx: hit.edgeIdx }
          : null)
        break
      }
      // 等距: 选中后拖动实时预览 / 悬停整轮廓高亮
      case 'offset': {
        if (st.offset) {
          const c = findContour(st.offset.contourId)
          if (c) {
            const d = computeOffsetDistance(c, pos)
            st.offsetD = d
            setPreview({
              kind: 'offsetPreview', points: [], current: pos, snapPos: null,
              offsetContourId: c.id, offsetDist: d, offsetPreview: computeOffsetPreview(c, d) ?? undefined,
            })
          }
          break
        }
        const hit = hitTest(pos)
        setPreview(hit
          ? { kind: 'hover', points: [], current: pos, snapPos: null, hoverContourId: hit.contourId, hoverEdgeIdx: hit.edgeIdx, hoverWhole: true }
          : null)
        break
      }
      case 'line': {
        if (!st.penPoints.length) {
          const snapped = computeSnap(pos)
          setPreview(snapped.label
            ? { kind: 'hover', points: [], current: pos, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label }
            : null)
          return
        }
        const anchor = st.penPoints[st.penPoints.length - 1]
          // 强制检测第一个端点：靠近起点时显示“闭合”吸附反馈
          const firstPt = st.penPoints[0]
          if (st.penPoints.length >= 2 && Math.hypot(pos.x - firstPt.x, pos.y - firstPt.y) < screenToWorld(CLOSE_RADIUS)) {
            const closeGuides = computeGuides(anchor, firstPt)
            setPreview({
              kind: 'pen', points: [...st.penPoints], current: { ...firstPt },
              snapPos: { ...firstPt }, snapLabel: '闭合', guides: closeGuides.guides,
            })
            return
          }
        const snapped = computeSnap(pos)
        // 悬停已有直线: "线上"分割提示 (点击后该点成为端点)
        if (!snapped.label) {
          const es = edgeSnapPoint(pos)
          if (es) {
            setPreview({ kind: 'pen', points: [...st.penPoints], current: es.point, snapPos: es.point, snapLabel: '线上' })
            return
          }
        }
        if (snapped.label) {
          setPreview({ kind: 'pen', points: [...st.penPoints], current: snapped, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label })
        } else {
          const g = computeGuides(anchor, pos)
          setPreview({
            kind: 'pen', points: [...st.penPoints], current: { x: g.x, y: g.y },
            snapPos: g.guides.length ? { x: g.x, y: g.y } : null, snapLabel: g.label || undefined, guides: g.guides,
          })
        }
        break
      }
      case 'rect': {
        if (s.ui.rectSubMode === '3point') {
          if (!st.rectPts.length) { hoverMarker(pos); return }
          if (st.rectPts.length === 1) {
            previewFrom('pen', st.rectPts[0], pos, { points: st.rectPts.map(p => ({ ...p })) })
            break
          }
          previewFrom('rect3pt', st.rectPts[st.rectPts.length - 1], pos, { points: st.rectPts.map(p => ({ ...p })) })
          break
        }
        if (!st.drawing || !st.start) { hoverMarker(pos); return }
        previewFrom(s.ui.rectSubMode === 'center' ? 'rectCenter' : 'rect', st.start, pos)
        break
      }
      case 'circle': {
        if (s.ui.circleSubMode === '3point') {
          if (!st.circlePts.length) { hoverMarker(pos); return }
          if (st.circlePts.length === 1) {
            previewFrom('pen', st.circlePts[0], pos, { points: st.circlePts.map(p => ({ ...p })) })
            break
          }
          previewFrom('circle3pt', st.circlePts[st.circlePts.length - 1], pos, { points: st.circlePts.map(p => ({ ...p })) })
          break
        }
        if (!st.drawing || !st.start) { hoverMarker(pos); return }
        previewFrom('circle', st.start, pos)
        break
      }
      case 'polygon': {
        if (!st.drawing || !st.start) { hoverMarker(pos); return }
        previewFrom('polygon', st.start, pos, {
          polygonSides: s.ui.polygonSides,
          polygonCircumscribed: s.ui.polygonCircumscribed,
        })
        break
      }
      case 'slot': {
        if (!st.slotPts.length) {
          const snapped = computeSnap(pos)
          setPreview(snapped.label
            ? { kind: 'hover', points: [], current: pos, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label }
            : null)
          return
        }
        const anchor = st.slotPts[st.slotPts.length - 1]
        const snapped = computeSnap(pos)
        if (snapped.label) {
          setPreview({ kind: 'slot', points: st.slotPts.map(p => ({ ...p })), current: snapped, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label })
        } else {
          const g = computeGuides(anchor, pos)
          setPreview({
            kind: 'slot', points: st.slotPts.map(p => ({ ...p })), current: { x: g.x, y: g.y },
            snapPos: g.guides.length ? { x: g.x, y: g.y } : null, snapLabel: g.label || undefined, guides: g.guides,
          })
        }
        break
      }
      case 'arc': {
        if (!st.arcPts.length) {
          const snapped = computeSnap(pos)
          setPreview(snapped.label
            ? { kind: 'hover', points: [], current: pos, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label }
            : null)
          return
        }
        const anchor = st.arcPts[st.arcPts.length - 1]
        const snapped = computeSnap(pos)
        const kind = s.ui.arcSubMode === 'arcCenter' ? 'arcCenter' : 'arc3pt'
        if (snapped.label) {
          setPreview({ kind, points: st.arcPts.map(p => ({ ...p })), current: snapped, snapPos: { x: snapped.x, y: snapped.y }, snapLabel: snapped.label })
        } else {
          const g = computeGuides(anchor, pos)
          setPreview({
            kind, points: st.arcPts.map(p => ({ ...p })), current: { x: g.x, y: g.y },
            snapPos: g.guides.length ? { x: g.x, y: g.y } : null, snapLabel: g.label || undefined, guides: g.guides,
          })
        }
        break
      }
      default:
        setPreview(null)
    }
  }, [])

  // ---- 鼠标松开: 提交拖动 / 快速擦除 ----

  const handleUp = useCallback(() => {
    const st = stateRef.current
    // 快速擦除提交
    if (st.eraser.sweeping) {
      commitEraserSweep()
      return
    }
    if (!(st.drag || st.dragEdge || st.dragCircle || st.dragArcEdge)) return
    const contourId = st.drag?.contourId ?? st.dragEdge?.contourId ?? st.dragCircle?.contourId ?? st.dragArcEdge!.contourId
    if (st.dragNew && st.dragOrig && st.dragged) {
      const s = useAppStore.getState()
      // 圆改半径后同步 直径/半径 约束值 + 标注位置 (修复: 标注漂移)
      if (st.dragPatch?.radius !== undefined) {
        const c = findContour(contourId)
        if (c && c.shape === 'circle' && c.center) {
          const mmR = st.dragPatch.radius * s.project.config.pixelToMM
          const diam = c.constraints.find(x => x.type === 'diameter')
          if (diam) {
            s.execute(new UpdateConstraintCommand(contourId, diam.id, {
              value: mmR * 2, label: `直径 ${(mmR * 2).toFixed(1)} mm`,
              labelPos: { x: c.center.x, y: c.center.y - st.dragPatch.radius - 20 },
            }))
          }
          const rad = c.constraints.find(x => x.type === 'radius')
          if (rad) {
            s.execute(new UpdateConstraintCommand(contourId, rad.id, {
              value: mmR, label: `R ${mmR.toFixed(1)} mm`,
              labelPos: { x: c.center.x + st.dragPatch.radius / 2, y: c.center.y },
            }))
          }
        }
      }
      const preCenter = findContour(contourId)?.center ?? null
      s.execute(new UpdateContourPointsCommand(contourId, st.dragOrig, st.dragNew, st.dragPatch ?? undefined))
      // 圆心/中心平移后 R 标注跟随移动
      if (st.dragPatch?.center && preCenter) {
        const c2 = findContour(contourId)
        const radC = c2?.constraints.find(x => x.type === 'radius')
        if (radC && c2) {
          const ddx = st.dragPatch.center.x - preCenter.x
          const ddy = st.dragPatch.center.y - preCenter.y
          s.execute(new UpdateConstraintCommand(contourId, radC.id, {
            labelPos: { x: radC.labelPos.x + ddx, y: radC.labelPos.y + ddy },
          }))
        }
      }
      // 有约束时拖动后刷新状态色
      const c = findContour(contourId)
      if (c && c.constraints.length) checkState(contourId)
    }
    st.drag = null
    st.dragEdge = null
    st.dragCircle = null
    st.dragArcEdge = null
    st.dragStartPos = null
    st.dragOrig = null
    st.dragNew = null
    st.dragPatch = null
    setPreview(null)
  }, [])

  // ---- 快速擦除提交 ----

  function commitEraserSweep() {
    const st = stateRef.current
    const hits = st.eraser.hits
    st.eraser = { sweeping: false, startPos: null, lastPos: null, path: [], hits: new Map() }
    setPreview(null)
    if (!hits.size) return
    const s = useAppStore.getState()
    for (const [contourId, edges] of hits) {
      const c = findContour(contourId)
      if (!c) continue
      // 圆/槽口/独立弧/全删 → 整轮廓删除
      if (edges.includes(-1) || c.slotWidth !== undefined || standaloneArc(c) !== null) {
        removeContour(contourId)
        continue
      }
        // 被多边形切割的圆: 只删除扫过的圆弧段, 保留其余段
        if (c.shape === 'circle') {
          const segIndices = edges.filter(e => e >= 0)
          if (segIndices.length === 0) {
            removeContour(contourId)
          } else {
            s.execute(new TrimCircleSegmentsCommand(contourId, segIndices))
          }
          checkState(contourId)
          continue
        }
      // 弧边 → 退回直边; 直边 → 收集批量修剪
      const lineEdges: number[] = []
      for (const e of edges) {
        const arc = edgeArc(c, e)
        if (arc) s.execute(new RemoveArcEntityCommand(contourId, arc.id))
        else lineEdges.push(e)
      }
      if (lineEdges.length) {
        const total = edgeCount(c)
        if (lineEdges.length >= total || c.points.length <= 3) {
          removeContour(contourId)
        } else {
          s.execute(new QuickTrimCommand(contourId, lineEdges))
        }
      }
      checkState(contourId)
    }
    // 擦除后: 端点相接的开放链自动合并 (L 型等)
    autoMergeOpenContours()
  }

  // ---- 删除轮廓并清理选中 (修复: 修剪/删除后选中残留) ----

  function removeContour(contourId: string) {
    const s = useAppStore.getState()
    s.execute(new RemoveContourCommand(contourId))
    if (s.ui.selectedContourId === contourId) {
      s.setUI({ selectedContourId: null, selectedConstraintId: null })
    }
  }

  // ---- 擦除公共边后: 端点相接的开放链自动合并回草图 (L 型等) ----
  // 两个矩形擦除公共边 → 两条开放链 (两端点互相重合) → 合并成一条闭合 L 型,
  // 写回草图后: 自动分割直接可用, 智能尺寸也能作用在整条 L 上。

  function autoMergeOpenContours() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type !== 'sketch') continue
        const open = f.contours.filter(c =>
          !c.closed && !c.construction && c.shape === undefined &&
          (c.arcs?.length ?? 0) === 0 && c.points.length >= 2)
        if (open.length < 2) continue
        const groups = mergeOpenChainGroups(open.map(c => ({
          contourId: c.id, name: c.name, closed: c.closed, points: c.points,
        })))
        const merges = groups.filter(g => g.sourceIds.length >= 2)
        if (merges.length === 0) continue
        const sources = new Set(merges.flatMap(g => g.sourceIds))
        const type = f.contours.find(c => sources.has(c.id))?.type ?? 'outer'
        const output = merges.map(g => ({ g, mergedId: newContourId() }))
        s.execute(new MergeContoursCommand(f.id, output.map(o => ({
          mergedId: o.mergedId,
          removeIds: o.g.sourceIds,
          type,
          name: o.g.chain.name || '合并轮廓',
          points: o.g.chain.points,
        }))))
        if (output[0]) s.setUI({ selectedContourId: output[0].mergedId, selectedConstraintId: null })
        setHint(`已自动合并 ${merges.length} 处端点相接的开放轮廓为闭合轮廓`)
      }
    }
  }

  // ---- 主点击处理 ----

  const handleClick = useCallback((pos: Point2D) => {
    const st = stateRef.current
    const s = useAppStore.getState()
    const tool = s.ui.activeTool

    // 拖动结束的 click 抑制
    if (st.dragged) { st.dragged = false; return }

    // 标注点击优先 (任何工具): 悬停高亮后单击 = 修改尺寸, 不再继续绘图
    const consHit = constraintHit(pos)
    if (consHit) { editDimension(consHit.contourId, consHit.constraintId); return }

    switch (tool) {
      // ── 选择: 命中标注→改值; 命中轮廓/顶点/圆心 → 选中; 空白 → 取消 ──
      case 'select': {
        const hit = hitTest(pos) ?? vertexHit(pos)
        if (hit) {
          s.setUI({ selectedContourId: hit.contourId })
        } else {
          s.setUI({ selectedContourId: null, selectedConstraintId: null })
        }
        break
      }

      // ── 直线: 逐点 + 自动H/V推理 + 起点闭合 (实线; 构造线/无限长度走属性面板) ──
      case 'line': {
        // 双击去重: 第二击交给 dblclick 闭合, 避免产生重复顶点
        const now = performance.now()
        const last = st.lastPenClick
        if (last && now - last.t < 350 && Math.hypot(pos.x - last.x, pos.y - last.y) < 4) {
          st.lastPenClick = null
          return
        }
        let snapped = computeSnap(pos)
        // 落点在已有直线上 → 该交点成为端点 (分割目标边)
        if (!snapped.label) {
          const es = edgeSnapPoint(pos)
          if (es) {
            s.execute(new SplitEdgeCommand(es.contourId, es.edgeIdx, es.point))
            checkState(es.contourId)
            snapped = { x: es.point.x, y: es.point.y, label: '线上' }
          }
        }
        if (st.penPoints.length > 0) {
          const prev = st.penPoints[st.penPoints.length - 1]
          // 未吸附到已有几何时, 推理参考线 (水平/竖直锁定 + 顶点 X/Y 对齐)
          if (!snapped.label) {
            const g = computeGuides(prev, pos)
            snapped = { x: g.x, y: g.y, label: g.label }
          }
          if (st.penPoints.length > 1) {
            const first = st.penPoints[0]
            if (Math.hypot(snapped.x - first.x, snapped.y - first.y) < screenToWorld(CLOSE_RADIUS)) {
              finishLine(true)
              return
            }
          }
        }
        st.lastPenClick = { x: pos.x, y: pos.y, t: now }
        st.penPoints.push({ x: snapped.x, y: snapped.y })
        // 辅助线模式: 两点即成 (无限长构造线)
        if (s.ui.lineSubMode === 'centerline' && st.penPoints.length >= 2) {
          finishLine(false)
          break
        }
        setHint(snapped.label === '水平' || snapped.label === '竖直' ? `已自动对齐${snapped.label} · 继续点击或双击闭合` : '继续点击 · 点击起点闭合 · 双击结束 (Esc 取消)')
        setPreview({ kind: 'pen', points: [...st.penPoints], current: { x: snapped.x, y: snapped.y }, snapPos: null })
        break
      }

      // ── 矩形: 两点/中心/三点 子模式 ──
      case 'rect': {
        if (s.ui.rectSubMode === '3point') {
          const sn = computeSnap(pos)
          if (st.rectPts.length === 0) {
            st.rectPts = [{ x: sn.x, y: sn.y }]
            setHint('三点矩形: 再点确定第一条边的终点')
          } else if (st.rectPts.length === 1) {
            st.rectPts = [st.rectPts[0], { x: sn.x, y: sn.y }]
            setHint('移动确定宽度 (垂直方向), 点击完成')
          } else {
            finishRect3pt(st.rectPts[0], st.rectPts[1], { x: sn.x, y: sn.y })
            st.rectPts = []
            setPreview(null)
            setHint(TOOL_HINTS.rect ?? null)
          }
          break
        }
        if (!st.drawing) {
          st.drawing = true
          const sn = computeSnap(pos)
          st.start = { x: sn.x, y: sn.y }
          setHint(s.ui.rectSubMode === 'center' ? '中心矩形: 移动确定角点 (Esc 取消)' : '再点一次完成 (Esc 取消)')
        } else {
          const sn = computeSnap(pos)
          const p2 = { x: sn.x, y: sn.y }
          if (s.ui.rectSubMode === 'center') finishRectCenter(st.start!, p2)
          else finishRect(st.start!, p2)
          st.drawing = false
          st.start = null
          setPreview(null)
          setHint(TOOL_HINTS.rect ?? null)
        }
        break
      }

      // ── 圆: 圆心圆 / 圆周三点圆 子模式 ──
      case 'circle': {
        if (s.ui.circleSubMode === '3point') {
          const sn = computeSnap(pos)
          if (st.circlePts.length === 0) {
            st.circlePts = [{ x: sn.x, y: sn.y }]
            setHint('圆周圆: 再点第二个圆周点')
          } else if (st.circlePts.length === 1) {
            st.circlePts = [st.circlePts[0], { x: sn.x, y: sn.y }]
            setHint('移动确定第三个圆周点 (实时预览圆)')
          } else {
            finishCircle3pt(st.circlePts[0], st.circlePts[1], { x: sn.x, y: sn.y })
            st.circlePts = []
            setPreview(null)
            setHint(TOOL_HINTS.circle ?? null)
          }
          break
        }
        if (!st.drawing) {
          st.drawing = true
          const sn = computeSnap(pos)
          st.start = { x: sn.x, y: sn.y }
          setHint('移动显示半径 R, 再点确定 (Esc 取消)')
        } else {
          const sn = computeSnap(pos)
          const p2 = { x: sn.x, y: sn.y }
          finishCircle(st.start!, p2)
          st.drawing = false
          st.start = null
          setPreview(null)
          setHint(TOOL_HINTS.circle ?? null)
        }
        break
      }

      // ── 多边形: 中心 → 半径 (旋转角固定) ──
      case 'polygon': {
        if (!st.drawing) {
          st.drawing = true
          const sn = computeSnap(pos)
          st.start = { x: sn.x, y: sn.y }
          setHint('移动定半径 (旋转角在工具栏设), 再点确定 (Esc 取消)')
        } else {
          const sn = computeSnap(pos)
          const p2 = { x: sn.x, y: sn.y }
          finishPolygon(st.start!, p2, s.ui.polygonSides, s.ui.polygonCircumscribed)
          st.drawing = false
          st.start = null
          setPreview(null)
          setHint(TOOL_HINTS.polygon ?? null)
        }
        break
      }

      // ── 槽口: 两点定长度 → 第三点定宽度 ──
      case 'slot': {
        let snapped = computeSnap(pos)
        if (st.slotPts.length === 1 && !snapped.label) {
          const g = computeGuides(st.slotPts[0], pos)
          snapped = { x: g.x, y: g.y, label: g.label }
        }
        const pts = st.slotPts
        if (!pts.length) {
          st.slotPts = [{ x: snapped.x, y: snapped.y }]
          setHint('再点确定槽口长度 (同直线, 自动水平/竖直)')
        } else if (pts.length === 1) {
          st.slotPts = [pts[0], { x: snapped.x, y: snapped.y }]
          setHint('移动确定宽度 (R=宽/2), 点击完成')
        } else {
          finishSlotWidth(pts[0], pts[1], { x: snapped.x, y: snapped.y })
          st.slotPts = []
          setPreview(null)
          setHint(TOOL_HINTS.slot ?? null)
        }
        break
      }

      // ── 弧: 二级菜单 (三点弧 / 圆心弧) ──
      case 'arc': {
        const snapped = computeSnap(pos)
        const p = { x: snapped.x, y: snapped.y }
        const pts = st.arcPts
        if (s.ui.arcSubMode === 'arcCenter') {
          if (pts.length === 0) {
            st.arcPts = [p]
            setHint('再点确定起点 (半径)')
            setPreview(null)
          } else if (pts.length === 1) {
            st.arcPts = [pts[0], p]
            setHint('移动确定终点 (逆时针)')
          } else {
            finishArcCenter(pts[0], pts[1], p)
            st.arcPts = []
            setPreview(null)
            setHint(TOOL_HINTS.arc ?? null)
          }
        } else {
          if (pts.length === 0) {
            st.arcPts = [p]
            setHint('再点确定终点')
            setPreview(null)
          } else if (pts.length === 1) {
            st.arcPts = [pts[0], p]
            setHint('移动确定弧上点, 点击完成 (端点吸相邻顶点=直边变圆角)')
          } else {
            finishArc3pt(pts[0], pts[1], p)
            st.arcPts = []
            setPreview(null)
            setHint(TOOL_HINTS.arc ?? null)
          }
        }
        break
      }

      // ── 等距实体: 单击轮廓(整圈高亮) → 拖动实时预览 → 点击确定 ──
      case 'offset': {
        if (st.offset) {
          const cid = st.offset.contourId
          const d = st.offsetD
          st.offset = null
          st.offsetD = 0
          setPreview(null)
          if (Math.abs(d) > 0.5) finishOffset(cid, d)
          else setHint(TOOL_HINTS.offset ?? null)
          break
        }
        const hit = hitTest(pos)
        if (!hit) break
        const c = findContour(hit.contourId)
        if (!c) break
        const ok = c.shape === 'circle'
          || c.slotWidth !== undefined
          || standaloneArc(c) !== null
          || (c.closed && (c.arcs?.length ?? 0) === 0 && c.points.length >= 3)
        if (!ok) { setHint('等距仅支持: 闭合折线 / 圆 / 槽口 / 独立圆弧'); break }
        st.offset = { contourId: c.id, clickPos: pos }
        st.offsetD = 0
        s.setUI({ selectedContourId: c.id })
        setHint('向外拖动外扩 / 向内内缩 (实时预览), 点击确定 (Esc 取消)')
        break
      }

      // ── 擦除 (点擦除模式): 点击擦除 ──
      case 'eraser': {
        if (s.ui.eraserMode !== 'point') break
        eraseEdgeAt(pos)
        setPreview(null)
        break
      }

      // ── 智能尺寸: 点目标 → 实时预览拖拽定位 → 点击放置并改值 ──
      case 'smartdim': {
        // 放置阶段: 点击 = 放置当前预览标注, 并弹出改值输入框
        if (st.dimPlace) {
          commitDimPlace(pos)
          break
        }
        const vh = vertexHit(pos)
        const hit = hitTest(pos)
        const cHit = hit ? findContour(hit.contourId) : null

        // 第二阶段: 圆心+圆周=半径 / 两顶点=距离
        if (st.pendingVertex) {
          const p1 = st.pendingVertex
          st.pendingVertex = null
          const c1 = findContour(p1.contourId)
          const isOrigin = p1.vertexIdx === -3
          const isCenter = p1.vertexIdx === -2
          if (isCenter && c1 && hit && hit.contourId === p1.contourId) {
            const circleHit = c1.shape === 'circle' && hit.edgeIdx === -1
            const arcHit = standaloneArc(c1) !== null && hit.edgeIdx >= 0
            if (circleHit || arcHit) {
              st.dimPlace = { contourId: p1.contourId, kind: 'radius' }
                setHint('圆心+圆周=半径')

              break
            }
          }
          // 顶点/孔中心 + 基准边 = 点线距离。中心到外板边时平移整个内孔，保留孔径/宽高。
          if (!isOrigin && c1 && hit && hit.edgeIdx >= 0 && !vh && (!isCenter || hit.contourId !== p1.contourId)) {
            const lineContour = findContour(hit.contourId)
            if (!lineContour || edgeArc(lineContour, hit.edgeIdx) || (lineContour.arcs?.length ?? 0) > 0) {
              setHint('含圆角边的轮廓暂不支持尺寸标注'); break
            }
            st.dimPlace = {
              contourId: lineContour.id, kind: 'pointline', edgeIndex: hit.edgeIdx,
              contourId2: lineContour.id === p1.contourId ? undefined : p1.contourId,
              vertexIdx1: p1.vertexIdx,
            }
            setHint('点-线距离: 拖动确定标注位置 · 点击放置并改值 (Esc 取消)')
            break
          }
          if (vh && (vh.vertexIdx !== p1.vertexIdx || vh.contourId !== p1.contourId)) {
            const c2 = findContour(vh.contourId)
            // 原点引用统一存为第一个点 (-3)，约束挂到实际几何轮廓上；编辑尺寸时只移动实际点。
            if (isOrigin && c2 && vh.vertexIdx >= -2 && (c2.arcs?.length ?? 0) === 0) {
              st.dimPlace = { contourId: c2.id, kind: 'distance', vertexIdx1: -3, vertexIdx2: vh.vertexIdx }
              setHint('原点基准尺寸: 拖动定位 · 点击放置并改值 (Esc 取消)')
              break
            }
            if (vh.vertexIdx === -3 && c1 && (c1.arcs?.length ?? 0) === 0) {
              st.dimPlace = { contourId: c1.id, kind: 'distance', vertexIdx1: -3, vertexIdx2: p1.vertexIdx }
              setHint('原点基准尺寸: 拖动定位 · 点击放置并改值 (Esc 取消)')
              break
            }
            if (c1 && (c1.arcs?.length ?? 0) > 0) { setHint('含圆角边的轮廓暂不支持尺寸标注'); break }
            if (c1 && c2 && (c1.arcs?.length ?? 0) === 0 && (c2.arcs?.length ?? 0) === 0) {
              const contourId2 = vh.contourId === p1.contourId ? undefined : vh.contourId
              st.dimPlace = { contourId: p1.contourId, kind: 'distance', contourId2, vertexIdx1: p1.vertexIdx, vertexIdx2: vh.vertexIdx }
              setHint('拖动确定尺寸线距离 · 点击放置并改值 (Esc 取消)')
              break
            }
            setHint('含圆角边的轮廓暂不支持尺寸标注')
            break
          }
          setHint('圆心+圆周=半径; 两个顶点=距离 (Esc 取消)')
          break
        }

        // 已选边 + 点顶点 = 点线距离 (边两击流程中的第二击点顶点)
        if (st.pendingEdge && vh && vh.vertexIdx >= -2 &&
            (vh.vertexIdx >= 0 || vh.contourId !== st.pendingEdge.contourId)) {
          const pe = st.pendingEdge
          st.pendingEdge = null
          const cpe = findContour(pe.contourId)
          if (!cpe || edgeArc(cpe, pe.edgeIdx) || (cpe.arcs?.length ?? 0) > 0) {
            setHint('含圆角边的轮廓暂不支持尺寸标注')
            break
          }
          st.dimPlace = {
            contourId: pe.contourId, kind: 'pointline', edgeIndex: pe.edgeIdx,
            contourId2: vh.contourId === pe.contourId ? undefined : vh.contourId,
            vertexIdx1: vh.vertexIdx,
          }
          setHint('点-线距离: 拖动确定标注位置 · 点击放置并改值 (Esc 取消)')
          break
        }

        // 第一阶段: 顶点 → 等待第二点
        if (vh) {
          st.pendingVertex = vh
          setHint(vh.vertexIdx === -2 ? '再点圆周 → 半径；点外板边 → 水平/垂直位置尺寸；点其他中心 → 中心距' : '再点顶点/圆心/基准边 → 距离 (Esc 取消)')
          break
        }

        // 边命中
        if (!hit) { st.pendingEdge = null; setHint(TOOL_HINTS.smartdim ?? null); break }
        if (hit.edgeIdx === -1) {
          const c2 = findContour(hit.contourId)
          if (c2?.shape === 'circle') {
            st.dimPlace = { contourId: hit.contourId, kind: 'diameter' }
            setHint('拖动确定直径标注方向 · 点击放置并改值 (Esc 取消)')
          } else if (c2 && standaloneArc(c2)) {
            st.dimPlace = { contourId: hit.contourId, kind: 'radius' }
            setHint('拖动确定 R 标注方向 · 点击放置并改值 (Esc 取消)')
          } else setHint('圆弧暂不支持尺寸标注')
          break
        }
        if (!cHit) { st.pendingEdge = null; setHint(TOOL_HINTS.smartdim ?? null); break }
        const c3 = cHit
        if (edgeArc(c3, hit.edgeIdx)) {
          if (standaloneArc(c3)) {
            if (!st.pendingEdge) {
                st.pendingEdge = hit
                setHint('再点同弧=弧长; 点其他=半径/角度/距离 (Esc 取消)')
              } else if (st.pendingEdge.contourId === hit.contourId && st.pendingEdge.edgeIdx === hit.edgeIdx) {
                st.pendingEdge = null
                st.dimPlace = { contourId: hit.contourId, kind: 'arclength', edgeIndex: hit.edgeIdx }
                setHint('拖动确定弧长标注位置 · 点击放置并改值 (Esc 取消)')
              } else {
                st.pendingEdge = null
                st.dimPlace = { contourId: hit.contourId, kind: 'radius' }
                setHint('圆心+圆周=半径')
              }
            setHint('拖动确定 R 标注方向 · 点击放置并改值 (Esc 取消)')
          } else setHint('圆弧边暂不支持尺寸标注')
          break
        }
        if (c3 && (c3.arcs?.length ?? 0) > 0) { setHint('含圆角边的轮廓暂不支持尺寸标注'); break }
        if (!st.pendingEdge) {
          st.pendingEdge = hit
          setHint('再点同边=长度; 平行边=间距; 斜边=角度 (Esc 取消)')
        } else if (st.pendingEdge.contourId === hit.contourId && st.pendingEdge.edgeIdx === hit.edgeIdx) {
          st.pendingEdge = null
          st.dimPlace = { contourId: hit.contourId, kind: 'length', edgeIndex: hit.edgeIdx }
          setHint('拖动确定尺寸线距离 · 点击放置并改值 (Esc 取消)')
        } else {
          const e1 = st.pendingEdge.edgeIdx, e2 = hit.edgeIdx
          const cFirst = findContour(st.pendingEdge.contourId)
          const same = st.pendingEdge.contourId === hit.contourId
          st.pendingEdge = null
          if (!cFirst || !c3) { setHint(TOOL_HINTS.smartdim ?? null); break }
          const a1 = chordAngle(cFirst, e1), a2 = chordAngle(c3, e2)
          const d = Math.abs(a1 - a2) % Math.PI
          if (d < (5 * Math.PI) / 180 || d > Math.PI - (5 * Math.PI) / 180) {
            // 外轮廓是稳定基准：跨内/外轮廓标注时无论点击顺序如何，都移动内孔侧而不拉动主体。
            const swapForOuterAnchor = !same && cFirst.type === 'inner' && c3.type === 'outer'
            st.dimPlace = swapForOuterAnchor
              ? { contourId: c3.id, kind: 'parallel', contourId2: cFirst.id, edgeIndex: e2, edgeIndex2: e1 }
              : {
                  contourId: cFirst.id, kind: 'parallel', contourId2: same ? undefined : hit.contourId,
                  edgeIndex: e1, edgeIndex2: e2,
                }
            setHint('拖动确定间距标注位置 · 点击放置并改值 (Esc 取消)')
          } else if (same) {
            st.dimPlace = { contourId: hit.contourId, kind: 'angle', edgeIndex: e1, edgeIndex2: e2 }
            setHint('拖动确定角度弧大小 · 点击放置并改值 (Esc 取消)')
          } else {
            st.dimPlace = { contourId: cFirst.id, kind: 'angle', contourId2: hit.contourId, edgeIndex: e1, edgeIndex2: e2 }
              setHint('拖动确定角度弧大小 · 点击放置并改值 (Esc 取消)')
          }
        }
        break
      }
    }
  }, [])

  // ---- 双击 (line 闭合) ----
  const handleDoubleClick = useCallback((pos?: Point2D) => {
    if (useAppStore.getState().ui.activeTool !== 'line') return
      const st = stateRef.current
      // 双击时，刚刚由第一次 click 产生的顶点不应该保留
      if (pos && st.penPoints.length > 0) {
        const last = st.penPoints[st.penPoints.length - 1]
        const lastClick = st.lastPenClick
        const recent = lastClick !== null && performance.now() - lastClick.t < 500
        if (recent && Math.hypot(last.x - pos.x, last.y - pos.y) < screenToWorld(8)) {
          st.penPoints.pop()
        }
      }
      // 如果当前鼠标确实吸附在起点，则闭合；否则退出为开口折线
      const pts = st.penPoints
      const shouldClose = pos !== undefined && pts.length >= 2 &&
        Math.hypot(pos.x - pts[0].x, pos.y - pts[0].y) < screenToWorld(CLOSE_RADIUS)
      finishLine(shouldClose)
  }, [])

  // ---- 键盘: Esc 取消 ----
  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (e.key === 'Escape') {
      stateRef.current = newToolState()
      setSnapState(null)
      setPreview(null)
      setHint(TOOL_HINTS[useAppStore.getState().ui.activeTool] ?? null)
      return true
    }
    return false
  }, [])

  // ---- 完成函数 ----

  function finishRect(p1: Point2D, p2: Point2D) {
    const s = useAppStore.getState()
    const x1 = Math.min(p1.x, p2.x), y1 = Math.min(p1.y, p2.y)
    const x2 = Math.max(p1.x, p2.x), y2 = Math.max(p1.y, p2.y)
    if (Math.abs(x2 - x1) < 5 || Math.abs(y2 - y1) < 5) return
    const id = newContourId()
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `矩形 ${rand()}`,
      points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
      closed: true, constraints: [],
    }))
    checkState(id)
  }

  /** 中心矩形: 中心 → 角点 */
  function finishRectCenter(center: Point2D, corner: Point2D) {
    const s = useAppStore.getState()
    const hw = Math.abs(corner.x - center.x), hh = Math.abs(corner.y - center.y)
    if (hw < 3 || hh < 3) return
    const id = newContourId()
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `矩形 ${rand()}`,
      points: [
        { x: center.x - hw, y: center.y - hh }, { x: center.x + hw, y: center.y - hh },
        { x: center.x + hw, y: center.y + hh }, { x: center.x - hw, y: center.y + hh },
      ],
      closed: true, constraints: [],
    }))
    checkState(id)
  }

  /** 三点矩形: 边两点 (p1→p2) → 第三点垂直距离定宽 */
  function finishRect3pt(p1: Point2D, p2: Point2D, p3: Point2D) {
    const s = useAppStore.getState()
    const dx = p2.x - p1.x, dy = p2.y - p1.y
    const len = Math.hypot(dx, dy)
    if (len < 3) { setHint('边过短'); return }
    const nx = -dy / len, ny = dx / len
    const w = (p3.x - p1.x) * nx + (p3.y - p1.y) * ny
    if (Math.abs(w) < 3) { setHint('宽度过小, 请离边远一点点击'); return }
    const id = newContourId()
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `矩形 ${rand()}`,
      points: [
        { ...p1 }, { ...p2 },
        { x: p2.x + nx * w, y: p2.y + ny * w },
        { x: p1.x + nx * w, y: p1.y + ny * w },
      ],
      closed: true, constraints: [],
    }))
    checkState(id)
  }

  function finishCircle(center: Point2D, edge: Point2D) {
    const s = useAppStore.getState()
    const r = Math.hypot(edge.x - center.x, edge.y - center.y)
    if (r < 5) return
    const rMM = r * s.project.config.pixelToMM
    const id = newContourId()
    // 画完自动带 R 标注 (点击数字可直接改值)
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `圆 ${rand()}`,
      points: circlePoints(center, r),
      closed: true, shape: 'circle', center: { ...center }, radius: r,
      constraints: [{
        id: newConsId(), type: 'radius', value: rMM,
        labelPos: { x: center.x + r / 2, y: center.y },
        driving: true, label: `R ${rMM.toFixed(1)} mm`,
      }],
    }))
    checkState(id)
  }

  /** 圆周三点圆: 三个圆周点 → 外接圆心+半径 */
  function finishCircle3pt(p1: Point2D, p2: Point2D, p3: Point2D) {
    const s = useAppStore.getState()
    const cc = circumcenter(p1, p2, p3)
    if (!cc || !Number.isFinite(cc.radius) || cc.radius < 5) { setHint('三点无法构成圆 (共线或过小)'); return }
    const center = cc.center, r = cc.radius
    const rMM = r * s.project.config.pixelToMM
    const id = newContourId()
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `圆 ${rand()}`,
      points: circlePoints(center, r),
      closed: true, shape: 'circle', center: { ...center }, radius: r,
      constraints: [{
        id: newConsId(), type: 'radius', value: rMM,
        labelPos: { x: center.x + r / 2, y: center.y },
        driving: true, label: `R ${rMM.toFixed(1)} mm`,
      }],
    }))
    checkState(id)
  }

  function finishPolygon(center: Point2D, edge: Point2D, sides: number, circumscribed: boolean) {
    const s = useAppStore.getState()
    const r = Math.hypot(edge.x - center.x, edge.y - center.y)
    if (r < 5) return
    // 内切圆模式: 顶点在参考圆上; 外切圆模式: 边与参考圆相切 (顶点半径放大 1/cos(π/n))
    const rOut = circumscribed ? r / Math.cos(Math.PI / sides) : r
    // 旋转角 = 鼠标方向 (拖拽即旋转), 归一化后存入轮廓 (属性面板可改)
    const angle0 = Math.atan2(edge.y - center.y, edge.x - center.x)
    const rotation = Math.round(normDeg((angle0 * 180) / Math.PI) * 10) / 10
    const points = Array.from({ length: sides }, (_, i) => {
      const a = angle0 + (2 * Math.PI * i) / sides
      return { x: center.x + rOut * Math.cos(a), y: center.y + rOut * Math.sin(a) }
    })
    const id = newContourId()
    const rMM = r * s.project.config.pixelToMM
    // 自动 R 标注 (参考圆半径), 位于圆心→圆周半径线中央, 点击可改
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `多边形 ${sides}边 ${rand()}`,
      points, closed: true, shape: 'polygon', center: { ...center }, radius: r,
      polygonCircumscribed: circumscribed, rotation,
      constraints: [{
        id: newConsId(), type: 'radius', value: rMM,
        labelPos: { x: center.x + (r / 2) * Math.cos(angle0), y: center.y + (r / 2) * Math.sin(angle0) },
        driving: true, label: `R ${rMM.toFixed(1)} mm`,
      }],
    }))
    checkState(id)
  }

  function finishSlotWidth(p1: Point2D, p2: Point2D, mouse: Point2D) {
    const s = useAppStore.getState()
    const w = 2 * ptSegDist(mouse, p1, p2)
    if (w < 2 || !Number.isFinite(w)) { setHint('宽度过小 (至少 1mm), 重新拖宽'); return }
    const id = newContourId()
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `槽口 ${rand()}`,
      points: [{ ...p1 }, { ...p2 }],
      closed: true, slotWidth: w, constraints: [],
    }))
    checkState(id)
  }

  function finishLine(closed: boolean) {
    const s = useAppStore.getState()
    const pts = stateRef.current.penPoints
    if (pts.length < 2) return
    const id = newContourId()
    const isCenter = s.ui.lineSubMode === 'centerline'
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: isCenter ? `辅助线 ${rand()}` : `直线 ${rand()}`,
      points: pts.map(p => ({ ...p })), closed: isCenter ? false : closed,
      construction: isCenter ? true : undefined,
      infinite: isCenter ? true : undefined,
      constraints: [],
    }))
    stateRef.current.penPoints = []
    stateRef.current.lastPenClick = null
    setPreview(null)
    setHint(TOOL_HINTS.line ?? null)
    checkState(id)
  }

  /** 三点弧: 端点吸附同一轮廓相邻顶点 → 直边替换为圆角; 否则生成独立圆弧 */
  function finishArc3pt(p1: Point2D, p2: Point2D, p3: Point2D) {
    const s = useAppStore.getState()
    const cc = circumcenter(p1, p2, p3)
    if (!cc) { setHint('三点共线, 无法生成圆弧'); return }
    if (cc.radius < 5) { setHint('圆弧半径过小'); return }
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 5) { setHint('起终点过近'); return }

    // 端点吸附检测 → 相邻顶点直边变圆角
    const v1 = findVertex(p1)
    const v2 = findVertex(p2)
    if (v1 && v2 && v1.contourId === v2.contourId && v1.idx !== v2.idx) {
      const c = findContour(v1.contourId)
      if (c && !c.shape && c.slotWidth === undefined && !c.construction) {
        const n = c.points.length
        const adjacent = (v2.idx + 1) % n === v1.idx || (v1.idx + 1) % n === v2.idx
        if (adjacent) {
          const j1 = (v2.idx + 1) % n === v1.idx ? v2.idx : v1.idx  // 边的起点
          const j2 = (j1 + 1) % n
          const sweep = sweepThrough(cc.center, c.points[j1], c.points[j2], p3)
          s.execute(new AddArcEntityCommand(v1.contourId, {
            id: newArcId(), p1: j1, p2: j2,
            center: { ...cc.center }, radius: cc.radius, sweep,
          }))
          s.setUI({ selectedContourId: v1.contourId })
          setHint('直边已替换为圆弧 (圆角)')
          checkState(v1.contourId)
          return
        }
      }
    }

    // 独立圆弧轮廓
    const sweep = sweepThrough(cc.center, p1, p2, p3)
    const id = newContourId()
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `圆弧 ${rand()}`,
      points: [{ ...p1 }, { ...p2 }], closed: false,
      arcs: [{ id: newArcId(), p1: 0, p2: 1, center: { ...cc.center }, radius: cc.radius, sweep }],
      constraints: [],
    }))
    checkState(id)
  }

  /** 圆心弧: 圆心 → 起点 (定半径) → 终点 (逆时针, 终点归一化到圆上) */
  function finishArcCenter(center: Point2D, start: Point2D, end: Point2D) {
    const s = useAppStore.getState()
    const r = Math.hypot(start.x - center.x, start.y - center.y)
    if (r < 5) { setHint('圆弧半径过小'); return }
    const a1 = pointAngle(center, start)
    const a2 = pointAngle(center, end)
    const span = normAngle(a2 - a1)
    if (span < 0.02 || span > Math.PI * 2 - 0.02) { setHint('起终点角度差过小, 无法生成圆弧'); return }
    const endOnArc = arcPointAt(center, r, a2)
    const id = newContourId()
    s.execute(new CreateContourCommand({
      id, type: s.ui.newContourType, name: `圆弧 ${rand()}`,
      points: [{ ...start }, endOnArc], closed: false,
      arcs: [{ id: newArcId(), p1: 0, p2: 1, center: { ...center }, radius: r, sweep: 'ccw' as Sweep }],
      constraints: [],
    }))
    checkState(id)
  }

  /** 射线法点在多边形内判定 (等距方向符号) */
  function pointInPolygon(p: Point2D, pts: Point2D[]): boolean {
    let inside = false
    const n = pts.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }

  /** 鼠标位置 → 轮廓有向偏移距离 (像素; 内部为负=内缩, 外部为正=外扩) */
  function computeOffsetDistance(c: Contour, pos: Point2D): number {
    if (c.shape === 'circle' && c.center && c.radius) {
      return Math.hypot(pos.x - c.center.x, pos.y - c.center.y) - c.radius
    }
    if (c.slotWidth !== undefined && c.points.length >= 2) {
      return ptSegDist(pos, c.points[0], c.points[1]) - c.slotWidth / 2
    }
    const arc = standaloneArc(c)
    if (arc) return Math.hypot(pos.x - arc.center.x, pos.y - arc.center.y) - arc.radius
    if (!c.closed || c.points.length < 3) return 0
    let best = Infinity
    const n = c.points.length
    for (let i = 0; i < n; i++) {
      const d = ptSegDist(pos, c.points[i], c.points[(i + 1) % n])
      if (d < best) best = d
    }
    return pointInPolygon(pos, c.points) ? -best : best
  }

  /** 偏移后的实时预览形状 (退化返回 null) */
  function computeOffsetPreview(c: Contour, d: number): OffsetPreviewShape | null {
    if (c.shape === 'circle' && c.center && c.radius) {
      const r2 = c.radius + d
      if (r2 < 2) return null
      return { kind: 'circle', center: { ...c.center }, r: r2 }
    }
    if (c.slotWidth !== undefined && c.points.length >= 2) {
      const w2 = c.slotWidth + 2 * d
      if (w2 < 2) return null
      return { kind: 'slot', p1: { ...c.points[0] }, p2: { ...c.points[1] }, w: w2 }
    }
    const arc = standaloneArc(c)
    if (arc) {
      const r2 = arc.radius + d
      if (r2 < 2) return null
      return { kind: 'arc', center: { ...arc.center }, r: r2, pts: [{ ...c.points[0] }, { ...c.points[1] }], sweep: arc.sweep }
    }
    if (!c.closed || (c.arcs?.length ?? 0) > 0) return null
    const pts = offsetClosedPolygon(c.points, d)
    return pts ? { kind: 'poly', points: pts } : null
  }

  /** 等距实体: 圆/槽口/独立弧/闭合折线 → 偏移后新轮廓 (dPx 像素, 正外扩/负内缩) */
  function finishOffset(contourId: string, dPx: number) {
    const s = useAppStore.getState()
    const c = findContour(contourId)
    if (!c) return
    const shape = computeOffsetPreview(c, dPx)
    if (!shape) { setHint('内缩过大: 轮廓退化/自相交'); return }
    const id = newContourId()
    const name = `等距 ${rand()}`
    if (shape.kind === 'circle' && shape.center && shape.r !== undefined) {
      s.execute(new CreateContourCommand({
        id, type: c.type, name, points: circlePoints(shape.center, shape.r),
        closed: true, shape: 'circle', center: { ...shape.center }, radius: shape.r, constraints: [],
      }))
    } else if (shape.kind === 'slot' && shape.p1 && shape.p2 && shape.w !== undefined) {
      s.execute(new CreateContourCommand({
        id, type: c.type, name, points: [{ ...shape.p1 }, { ...shape.p2 }],
        closed: true, slotWidth: shape.w, constraints: [],
      }))
    } else if (shape.kind === 'arc' && shape.center && shape.r !== undefined && shape.pts && shape.pts.length >= 2) {
      const a1 = pointAngle(shape.center, shape.pts[0])
      const a2 = pointAngle(shape.center, shape.pts[1])
      s.execute(new CreateContourCommand({
        id, type: c.type, name, closed: false,
        points: [arcPointAt(shape.center, shape.r, a1), arcPointAt(shape.center, shape.r, a2)],
        arcs: [{ id: newArcId(), p1: 0, p2: 1, center: { ...shape.center }, radius: shape.r, sweep: shape.sweep ?? 'ccw' as Sweep }],
        constraints: [],
      }))
    } else if (shape.kind === 'poly' && shape.points) {
      s.execute(new CreateContourCommand({
        id, type: c.type, name, points: shape.points, closed: true, constraints: [],
      }))
    }
    checkState(id)
    setHint(`已生成等距轮廓 (偏移 ${(dPx * s.project.config.pixelToMM).toFixed(1)} mm)`)
  }

  // ---- 点擦除 (端点结构感知): 交点两侧修剪, 重合公共边两侧同时处理 ----

  /** 当前草图中所有有限直边的快照。修剪计算和提交共享同一份快照，避免拖动后命中旧拓扑。 */
  function collectStraightEdges(): StraightEdgeRef[] {
    const s = useAppStore.getState()
    const edges: StraightEdgeRef[] = []
    for (const part of s.project.parts) {
      for (const feature of part.features) {
        if (feature.type !== 'sketch') continue
        for (const contour of feature.contours) {
          if (contour.shape !== undefined || contour.slotWidth !== undefined ||
              (contour.construction && contour.infinite && !contour.closed)) continue
          const total = edgeCount(contour)
          for (let edgeIdx = 0; edgeIdx < total; edgeIdx++) {
            if (edgeArc(contour, edgeIdx)) continue
            edges.push({
              contourId: contour.id,
              edgeIdx,
              a: { ...contour.points[edgeIdx] },
              b: { ...contour.points[(edgeIdx + 1) % contour.points.length] },
            })
          }
        }
      }
    }
    return edges
  }

  /** 按当前几何求最近交点区间；无限辅助线作为额外修剪边界。 */
  function resolveTrimRange(target: StraightEdgeRef, pos: Point2D, edges: StraightEdgeRef[]): TrimRange {
    const s = useAppStore.getState()
    const dx = target.b.x - target.a.x
    const dy = target.b.y - target.a.y
    const len2 = dx * dx + dy * dy
    const extraBreaks: number[] = []
    if (len2 > 1e-6) {
      for (const part of s.project.parts) {
        for (const feature of part.features) {
          if (feature.type !== 'sketch') continue
          for (const contour of feature.contours) {
            if (!(contour.construction && contour.infinite && !contour.closed && contour.points.length >= 2)) continue
            const ip = segInfiniteIntersect(target.a, target.b, contour.points[0], contour.points[1])
            if (!ip) continue
            extraBreaks.push(((ip.x - target.a.x) * dx + (ip.y - target.a.y) * dy) / len2)
          }
        }
      }
    }
    return findTrimRangeAtPoint(
      target.a,
      target.b,
      pos,
      edges.filter(edge => !(edge.contourId === target.contourId && edge.edgeIdx === target.edgeIdx)),
      extraBreaks,
    )
  }

  function trimCommand(target: StraightEdgeRef, range: TrimRange) {
    const contour = findContour(target.contourId)
    if (!contour) return null
    if (!contour.closed) {
      return new TrimOpenEdgeRangeCommand(contour.id, target.edgeIdx, range.t1, range.t2, newContourId())
    }
    const fullEdge = range.t1 <= 1e-5 && range.t2 >= 1 - 1e-5
    return fullEdge
      ? new TrimEdgeCommand(contour.id, target.edgeIdx)
      : new TrimEdgeSegmentCommand(contour.id, target.edgeIdx, range.t1, range.t2)
  }

  /**
   * 点擦除: 与悬停高亮【完全同源】— 所见即所删 (不再独立重算命中导致删到"奇怪的边"),
   * 并同步删除其他轮廓上逐点重合的公共边 (两个矩形擦公共边 → L 型工作流保持可用)。
   */
  function eraseEdgeAt(pos: Point2D) {
    const s = useAppStore.getState()
    const hit = hitTest(pos)
    if (!hit) return // 未命中任何边: 不做任何删除
    const c = findContour(hit.contourId)
    if (!c) return

    // 整对象: 整圆(非分段)/槽口/独立圆弧/无限构造线
    if (hit.edgeIdx === -1 || c.slotWidth !== undefined || standaloneArc(c) !== null) {
      removeContour(c.id)
      autoMergeOpenContours()
      return
    }
    if (c.shape === 'circle') {
      s.execute(new TrimCircleSegmentsCommand(c.id, [hit.edgeIdx]))
      checkState(c.id)
      autoMergeOpenContours()
      return
    }
    if (c.construction && c.infinite && !c.closed) {
      removeContour(c.id)
      autoMergeOpenContours()
      return
    }
    const arc = edgeArc(c, hit.edgeIdx)
    if (arc) {
      s.execute(new RemoveArcEntityCommand(c.id, arc.id))
      checkState(c.id)
      autoMergeOpenContours()
      return
    }
    // 先在当前几何快照上求完整操作，再原子提交。部分重合的公共边也同步修剪。
    const edges = collectStraightEdges()
    const target = edges.find(edge => edge.contourId === c.id && edge.edgeIdx === hit.edgeIdx)
    if (!target) return
    const range = resolveTrimRange(target, pos, edges)
    const coincident = findCoincidentTrimRanges(target, range, edges)
    const commands = [...coincident, { ...target, ...range }]
      .map(edge => trimCommand(edge, edge))
      .filter(command => command !== null)
    if (commands.length === 0) return
    s.execute(new CompositeCommand(commands.length > 1 ? '擦除公共边' : '修剪边', commands))
    for (const edge of [...coincident, target]) checkState(edge.contourId)
    // 擦除后: 端点相接的开放链自动合并 (两个矩形擦公共边 → L 型闭合轮廓)
    autoMergeOpenContours()
  }

  // ---- 输入框 (防重入: Enter/blur 只提交一次; 单例) ----
  function showInput(initial: number, onCommit: (val: number) => void) {
    activeInput?.remove()
    const input = document.createElement('input')
    input.type = 'number'
    input.value = initial.toFixed(1)
    input.step = '0.5'
    input.style.cssText = `position:fixed;z-index:9999;left:50%;top:40%;transform:translate(-50%,-50%);width:120px;padding:6px 10px;background:#23262e;color:#3ec6b0;border:2px solid #3ec6b0;border-radius:6px;font-size:14px;text-align:center;`
    activeInput = input
    document.body.appendChild(input)
    input.focus()
    input.select()

    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (activeInput === input) activeInput = null
      input.remove()
    }
    const commit = () => {
      if (done) return
      finish()
      const val = parseFloat(input.value)
      if (!isNaN(val)) onCommit(val)
    }
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      if (e.key === 'Escape') finish()
    })
    input.addEventListener('blur', () => setTimeout(commit, 200))
  }

  /** 边的弦方向角 (平行判定用) */
  function chordAngle(c: Contour, i: number): number {
    const n = c.points.length
    return Math.atan2(c.points[(i + 1) % n].y - c.points[i].y, c.points[(i + 1) % n].x - c.points[i].x)
  }

  /** 智能尺寸放置预览: 依据鼠标位置合成临时约束 (数值=当前尺寸, 位置随鼠标拖动) */
  function buildDimPreviewCons(c: Contour, pl: NonNullable<ToolState['dimPlace']>, pos: Point2D): Constraint | null {
    const s = useAppStore.getState()
    const mm = s.project.config.pixelToMM
    const n = c.points.length
    if (pl.kind === 'length' && pl.edgeIndex !== undefined) {
      const i1 = pl.edgeIndex % n, i2 = (pl.edgeIndex + 1) % n
      const a = c.points[i1], b = c.points[i2]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len < 1e-6) return null
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      let off = (pos.x - mid.x) * nx + (pos.y - mid.y) * ny
      if (Math.abs(off) < 14) off = off >= 0 ? 14 : -14
      const val = len * mm
      return {
        id: '', type: 'length', edgeIndex: pl.edgeIndex, value: val,
        labelPos: { x: mid.x + nx * off, y: mid.y + ny * off },
        driving: true, label: lengthLabel(c, i1, i2, val),
      }
    }
    if (pl.kind === 'distance' && pl.vertexIdx1 !== undefined && pl.vertexIdx2 !== undefined) {
      // 支持普通顶点与圆心/中心 (-2), 支持跨轮廓 (pl.contourId2)
      const c2 = pl.contourId2 ? findContour(pl.contourId2) ?? c : c
      const resolvePoint = (contour: Contour, idx: number): Point2D | null => {
        if (idx === -3) return { x: 0, y: 0 }
        if (idx === -2) return contourCenter(contour)
        return contour.points[idx] ?? null
      }
      const a = resolvePoint(c, pl.vertexIdx1)
      const b = resolvePoint(c2, pl.vertexIdx2)
      if (!a || !b) return null
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len < 1e-6) return null
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      let off = (pos.x - mid.x) * nx + (pos.y - mid.y) * ny
      if (Math.abs(off) < 14) off = off >= 0 ? 14 : -14
      const val = len * mm
      const isOriginDist = pl.vertexIdx1 === -3 || pl.vertexIdx2 === -3
      const isCenterDist = pl.vertexIdx1 === -2 || pl.vertexIdx2 === -2
      const label = isOriginDist ? `基准距 ${val.toFixed(1)} mm` : isCenterDist ? `中心距 ${val.toFixed(1)} mm` : `距离 ${val.toFixed(1)} mm`
      return {
        id: '', type: 'distance', vertexIdx1: pl.vertexIdx1, vertexIdx2: pl.vertexIdx2,
        contourId2: pl.contourId2, value: val,
        labelPos: { x: mid.x + nx * off, y: mid.y + ny * off },
        driving: true, label,
      }
    }
    if (pl.kind === 'parallel' && pl.edgeIndex !== undefined && pl.edgeIndex2 !== undefined) {
      const c2 = pl.contourId2 ? findContour(pl.contourId2) ?? c : c
      const a1 = c.points[pl.edgeIndex % n], b1 = c.points[(pl.edgeIndex + 1) % n]
      const n2 = c2.points.length
      const a2 = c2.points[pl.edgeIndex2 % n2]
      const dx = b1.x - a1.x, dy = b1.y - a1.y
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len, uy = dy / len
      const nx = -uy, ny = ux
      const gap = (a2.x - a1.x) * nx + (a2.y - a1.y) * ny
      const val = Math.abs(gap) * mm
      // 两条平行线共用同一个沿边坐标，尺寸线始终沿法向，绝不会因边长/中点不同而画斜。
      const t = (pos.x - a1.x) * ux + (pos.y - a1.y) * uy
      const q1 = { x: a1.x + ux * t, y: a1.y + uy * t }
      const q2 = { x: q1.x + nx * gap, y: q1.y + ny * gap }
      return {
        id: '', type: 'distance', edgeIndex: pl.edgeIndex, edgeIndex2: pl.edgeIndex2, contourId2: pl.contourId2, value: val,
        labelPos: { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 },
        driving: true, label: `间距 ${val.toFixed(1)} mm`,
      }
    }
    if (pl.kind === 'pointline' && pl.edgeIndex !== undefined && pl.vertexIdx1 !== undefined) {
      const c2 = pl.contourId2 ? findContour(pl.contourId2) ?? c : c
      const a = c.points[pl.edgeIndex % n], b = c.points[(pl.edgeIndex + 1) % n]
      const v = pl.vertexIdx1 === -2 ? contourCenter(c2) : c2.points[pl.vertexIdx1]
      if (!v) return null
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) return null
      const ux = dx / len, uy = dy / len
      const nx = -uy, ny = ux
      const proj = (v.x - a.x) * ux + (v.y - a.y) * uy
      const q = { x: a.x + ux * proj, y: a.y + uy * proj }
      const val = Math.abs((v.x - a.x) * nx + (v.y - a.y) * ny) * mm
      return {
        id: '', type: 'distance', edgeIndex: pl.edgeIndex, vertexIdx1: pl.vertexIdx1,
        contourId2: pl.contourId2, value: val,
        // 点-线尺寸没有可平移的第二条直线，标签固定在最短距离线中央，避免与箭头失联。
        labelPos: { x: (v.x + q.x) / 2, y: (v.y + q.y) / 2 },
        driving: true, label: `${pl.vertexIdx1 === -2 ? '中心距' : '距离'} ${val.toFixed(1)} mm`,
      }
    }
      if (pl.kind === 'arclength' && pl.edgeIndex !== undefined) {
        const arc = standaloneArc(c) ?? edgeArc(c, pl.edgeIndex)
        if (!arc) return null
        const center = arc.center
        const r = arc.radius
        const p1 = c.points[arc.p1]
        const p2 = c.points[arc.p2]
        const span = arcSpan(center, p1, p2, arc.sweep)
        const val = r * span * mm
        const midAng = arcMidAngle(center, p1, p2, arc.sweep)
        return {
          id: '', type: 'arcLength', edgeIndex: pl.edgeIndex, value: val,
          labelPos: { x: center.x + (r + 16) * Math.cos(midAng), y: center.y + (r + 16) * Math.sin(midAng) },
          driving: true, label: `弧长 ${val.toFixed(1)} mm`,
        }
      }
    if (pl.kind === 'radius') {
      const center = c.center ?? standaloneArc(c)?.center
      const r = c.radius ?? standaloneArc(c)?.radius
      if (!center || !r) return null
      const ang = Math.atan2(pos.y - center.y, pos.x - center.x)
      const val = r * mm
      return {
        id: '', type: 'radius', value: val,
        labelPos: { x: center.x + (r / 2) * Math.cos(ang), y: center.y + (r / 2) * Math.sin(ang) },
        driving: true, label: `R ${val.toFixed(1)} mm`,
      }
    }
    if (pl.kind === 'diameter') {
      const center = c.center, r = c.radius
      if (!center || !r) return null
      const ang = Math.atan2(pos.y - center.y, pos.x - center.x)
      const val = r * 2 * mm
      return {
        id: '', type: 'diameter', value: val,
        labelPos: { x: center.x + (r + 16) * Math.cos(ang), y: center.y + (r + 16) * Math.sin(ang) },
        driving: true, label: `直径 ${val.toFixed(1)} mm`,
      }
    }
    if (pl.kind === 'angle' && pl.edgeIndex !== undefined && pl.edgeIndex2 !== undefined) {
      const a1 = c.points[pl.edgeIndex % n], b1 = c.points[(pl.edgeIndex + 1) % n]
      const c2 = pl.contourId2 ? findContour(pl.contourId2) ?? c : c
        const n2 = c2.points.length
        const a2 = c2.points[pl.edgeIndex2 % n2], b2 = c2.points[(pl.edgeIndex2 + 1) % n2]
      const deg = edgeAngleDeg(c, pl.edgeIndex, pl.edgeIndex2, c2)
      const I = lineCross(a1, b1, a2, b2)
      let labelPos: Point2D
      if (I) {
        const rad = Math.max(22, Math.min(240, Math.hypot(pos.x - I.x, pos.y - I.y)))
        const ang = Math.atan2(pos.y - I.y, pos.x - I.x)
        labelPos = { x: I.x + rad * Math.cos(ang), y: I.y + rad * Math.sin(ang) }
      } else {
        labelPos = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 - 20 }
      }
      return {
        id: '', type: 'angle', edgeIndex: pl.edgeIndex, edgeIndex2: pl.edgeIndex2, value: deg,
        labelPos, driving: !pl.contourId2, contourId2: pl.contourId2, label: `角度 ${deg.toFixed(1)}°`,
      }
    }
    return null
  }

  /** 智能尺寸放置提交: 按当前预览 (数值+位置) 落盘, 并弹出改值输入框 */
  function commitDimPlace(pos: Point2D) {
    const st = stateRef.current
    const pl = st.dimPlace
    st.dimPlace = null
    setPreview(null)
    if (!pl) return
    const c = findContour(pl.contourId)
    if (!c) { setHint(TOOL_HINTS.smartdim ?? null); return }
    const cons = buildDimPreviewCons(c, pl, pos)
    if (!cons) { setHint(TOOL_HINTS.smartdim ?? null); return }
    const s = useAppStore.getState()
    const sameRefs = (x: Constraint) =>
      x.type === cons.type && x.edgeIndex === cons.edgeIndex && x.edgeIndex2 === cons.edgeIndex2
      && x.vertexIdx1 === cons.vertexIdx1 && x.vertexIdx2 === cons.vertexIdx2
      && x.contourId2 === cons.contourId2
    const existing = c.constraints.find(sameRefs)
    const consId = existing?.id ?? newConsId()
    if (existing) {
      s.execute(new UpdateConstraintCommand(pl.contourId, existing.id, {
        value: cons.value, label: cons.label, labelPos: cons.labelPos, driving: true,
      }))
    } else {
      s.execute(new AddConstraintCommand(pl.contourId, { ...cons, id: consId }))
    }
    checkState(pl.contourId)
    // 点击放置后直接弹出输入框改值 (Esc 保持当前值)
    editDimension(pl.contourId, consId)
  }

  // ---- 智能尺寸: 编辑已有约束 ----

  function editDimension(contourId: string, constraintId: string) {
    const c = findContour(contourId)
    if (!c) return
    const cons = c.constraints.find(x => x.id === constraintId)
    if (!cons) return
    if (cons.type === 'diameter') {
      showInput(cons.value, (val) => applyDiameter(c, contourId, val, cons.id))
      return
    }
    if (cons.type === 'radius') {
      showInput(cons.value, (val) => applyRadius(c, contourId, val, cons.id))
      return
    }
    if (cons.type === 'arcLength') {
      showInput(cons.value, (val) => applyArcLength(c, contourId, val, cons.id))
      return
    }
    if (cons.type === 'length' && cons.edgeIndex !== undefined) {
      showInput(cons.value, (val) => applyLength(c, contourId, cons.edgeIndex!, val, cons.id))
      return
    }
    if (cons.type === 'distance' && cons.vertexIdx1 !== undefined && cons.vertexIdx2 !== undefined) {
      const isCenterDist = cons.vertexIdx1 < 0 || cons.vertexIdx2 < 0 || cons.contourId2 !== undefined
      showInput(cons.value, (val) => isCenterDist
        ? applyCenterDist(c, contourId, cons.vertexIdx1!, cons.vertexIdx2!, val, cons.id, cons.contourId2)
        : applyDistance(c, contourId, cons.vertexIdx1!, cons.vertexIdx2!, val, cons.id))
      return
    }
    if (cons.type === 'distance' && cons.edgeIndex !== undefined && cons.edgeIndex2 !== undefined) {
      showInput(cons.value, (val) => applyParallelDist(c, contourId, cons.edgeIndex!, cons.edgeIndex2!, val, cons.id, cons.contourId2))
      return
    }
    if (cons.type === 'distance' && cons.edgeIndex !== undefined && cons.vertexIdx1 !== undefined) {
      showInput(cons.value, (val) => applyPointLineDist(c, contourId, cons.edgeIndex!, cons.vertexIdx1!, val, cons.id, cons.contourId2))
      return
    }
    if (cons.type === 'angle' && cons.edgeIndex !== undefined && cons.edgeIndex2 !== undefined) {
      showInput(cons.value, (val) => applyAngle(c, contourId, cons.edgeIndex!, cons.edgeIndex2!, val, cons.id, cons.contourId2))
      return
    }
    setHint('几何关系约束无数值, 用约束面板删除')
  }

  /** 冲突处理 (SolidWorks 风格): 求解失败 → 尺寸转为被动(参考), 几何保持不变, 原主动尺寸不变 */
  function upsertDriven(_c: Contour, _contourId: string, _base: Partial<Constraint>, _replaceId?: string, _label?: string) {
    // 注: 原实现中"转为被动参考尺寸"的代码位于 return 之后为历史死代码, 已移除;
    // 当前行为与之前运行时一致: 仅提示求解失败。
    setHint('尺寸更新失败：几何未变化，请检查输入值或已有约束冲突')
  }

  // ---- 智能尺寸: 圆直径 ----

  function applyDiameter(c: Contour, contourId: string, mmVal: number, replaceId?: string) {
    const s = useAppStore.getState()
    if (!c.center) return
    if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
    const newR = mmVal / s.project.config.pixelToMM / 2
    if (newR < 2) return
    const old = c.points.map(p => ({ ...p }))
    s.execute(new UpdateContourPointsCommand(contourId, old, circlePoints(c.center, newR), { radius: newR }))
    const label = `直径 ${mmVal.toFixed(1)} mm`
    const existing = c.constraints.find(x => x.id === replaceId)
      ?? c.constraints.find(x => x.type === 'diameter')
    if (existing) {
      s.execute(new UpdateConstraintCommand(contourId, existing.id, {
        value: mmVal, label,
        labelPos: { x: c.center.x, y: c.center.y - newR - 20 },
      }))
    } else {
      s.execute(new AddConstraintCommand(contourId, {
        id: newConsId(), type: 'diameter', value: mmVal,
        labelPos: { x: c.center.x, y: c.center.y - newR - 20 },
        driving: true, label,
      } as Constraint))
    }
    checkState(contourId)
  }

  // ---- 智能尺寸: 半径 (圆心+圆周 / 直接点独立弧 / 编辑 R 标注) ----

  function applyRadius(c: Contour, contourId: string, mmVal: number, replaceId?: string) {
    const s = useAppStore.getState()
    if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
    const newR = mmVal / s.project.config.pixelToMM
    if (newR < 2) { setHint('半径过小 (至少 1mm)'); return }
    const old = c.points.map(p => ({ ...p }))
    let labelPos: Point2D
    if (c.shape === 'circle' && c.center) {
      s.execute(new UpdateContourPointsCommand(contourId, old, circlePoints(c.center, newR), { radius: newR }))
      // R 标注在圆心→圆周半径线的中央
      labelPos = { x: c.center.x + newR / 2, y: c.center.y }
    } else if (c.shape === 'polygon' && c.center) {
      // 多边形参考半径: 保持旋转角重生成顶点, R 标注在半径线中央
      const n = c.points.length
      const circ = c.polygonCircumscribed === true
      const angle0 = Math.atan2(c.points[0].y - c.center.y, c.points[0].x - c.center.x)
      const rOut = circ ? newR / Math.cos(Math.PI / n) : newR
      const newPts = Array.from({ length: n }, (_, i) => {
        const a = angle0 + (2 * Math.PI * i) / n
        return { x: c.center!.x + rOut * Math.cos(a), y: c.center!.y + rOut * Math.sin(a) }
      })
      s.execute(new UpdateContourPointsCommand(contourId, old, newPts, { radius: newR }))
      labelPos = { x: c.center.x + (newR / 2) * Math.cos(angle0), y: c.center.y + (newR / 2) * Math.sin(angle0) }
    } else {
      const arc = standaloneArc(c)
      if (!arc) return
      const a1 = pointAngle(arc.center, c.points[0])
      const a2 = pointAngle(arc.center, c.points[1])
      const newPts = [arcPointAt(arc.center, newR, a1), arcPointAt(arc.center, newR, a2)]
      s.execute(new UpdateContourPointsCommand(contourId, old, newPts, {
        arcs: (c.arcs ?? []).map(a => a.id === arc.id ? { ...a, radius: newR } : a),
      }))
      labelPos = arcPointAt(arc.center, newR / 2, arcMidAngle(arc.center, c.points[0], c.points[1], arc.sweep))
    }
    const label = `R ${mmVal.toFixed(1)} mm`
    const existing = c.constraints.find(x => x.id === replaceId)
      ?? c.constraints.find(x => x.type === 'radius')
    if (existing) {
      s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: mmVal, label, labelPos }))
    } else {
      s.execute(new AddConstraintCommand(contourId, {
        id: newConsId(), type: 'radius', value: mmVal, labelPos, driving: true, label,
      } as Constraint))
    }
    checkState(contourId)
  }
    // ---- 智能尺寸: 弧长 (独立圆弧) ----

    function applyArcLength(c: Contour, contourId: string, mmVal: number, replaceId?: string) {
      const s = useAppStore.getState()
      if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
      const arc = standaloneArc(c)
      if (!arc) { setHint('弧长标注仅支持独立圆弧'); return }
      const p1 = c.points[arc.p1]
      const p2 = c.points[arc.p2]
      const span = arcSpan(arc.center, p1, p2, arc.sweep)
      if (span < 1e-6) { setHint('无法计算弧长'); return }
      const newR = mmVal / s.project.config.pixelToMM / span
      if (newR < 2) { setHint('弧长过小'); return }
      const a1 = pointAngle(arc.center, p1)
      const a2 = pointAngle(arc.center, p2)
      const newPts = [arcPointAt(arc.center, newR, a1), arcPointAt(arc.center, newR, a2)]
      const old = c.points.map(p => ({ ...p }))
      s.execute(new UpdateContourPointsCommand(contourId, old, newPts, {
        arcs: (c.arcs ?? []).map(a => a.id === arc.id ? { ...a, radius: newR } : a),
      }))
      const labelPos = arcPointAt(arc.center, newR + 16, arcMidAngle(arc.center, newPts[0], newPts[1], arc.sweep))
      const label = `弧长 ${mmVal.toFixed(1)} mm`
      const existing = c.constraints.find(x => x.id === replaceId)
        ?? c.constraints.find(x => x.type === 'arcLength')
      if (existing) {
        s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: mmVal, label, labelPos }))
      } else {
        s.execute(new AddConstraintCommand(contourId, {
          id: newConsId(), type: 'arcLength', edgeIndex: arc.p1, value: mmVal, labelPos, driving: true, label,
        } as Constraint))
      }
      checkState(contourId)
    }



  // ---- 智能尺寸: 长度 (两击同边) ----

  /** 长度标签: 按边方向区分 水平/竖直/长度 (槽口中心线为长) */
  function lengthLabel(c: Contour, i1: number, i2: number, mm: number): string {
    const a = c.points[i1], b = c.points[i2]
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y)
    const kind = c.slotWidth !== undefined ? '长' : dx > dy * 2 ? '宽' : dy > dx * 2 ? '高' : '长度'
    return `${kind} ${mm.toFixed(1)} mm`
  }

  async function applyLength(c: Contour, contourId: string, edgeIdx: number, mmVal: number, replaceId?: string) {
    const s = useAppStore.getState()
    if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
    const n = c.points.length
    const i1 = edgeIdx % n
    const i2 = (edgeIdx + 1) % n
    const targetPx = mmVal / s.project.config.pixelToMM

    let result
    if (isOrtho(c)) {
      // 正交轮廓: 全边 H/V + 新边长, 几何闭合判定; 开放链保持其它边原长 → 不会变梯形
      result = await orthoSolve(c, [p2pDistance(i1, i2, targetPx)], s.project.config.pixelToMM, replaceId, { exclude: new Set([i1]) })
    } else {
      // 一般轮廓: 固定除目标边两端点外的所有点 → 只动目标边
      const fixed = Array.from({ length: n }, (_, i) => i).filter(i => i !== i1 && i !== i2)
      result = await solveSketch(c.points, [...existingConstraintsToSolver(c, s.project.config.pixelToMM, replaceId), p2pDistance(i1, i2, targetPx)], { fixedIndices: withStableAnchor(c, fixed), closed: isClosedGeo(c) })
    }

    if (!result.success) {
      upsertDriven(c, contourId, {
        type: 'length', edgeIndex: edgeIdx, value: mmVal,
        labelPos: { x: (c.points[i1].x + c.points[i2].x) / 2, y: (c.points[i1].y + c.points[i2].y) / 2 - 20 },
      }, replaceId, lengthLabel(c, i1, i2, mmVal))
      return
    }
    const old = c.points.map(p => ({ ...p }))
    c.points = result.points
    s.execute(new UpdateContourPointsCommand(contourId, old, result.points))

    const label = lengthLabel(c, i1, i2, mmVal)
    const labelPos = { x: (c.points[i1].x + c.points[i2].x) / 2, y: (c.points[i1].y + c.points[i2].y) / 2 - 20 }
    const existing = c.constraints.find(x => x.id === replaceId)
      ?? c.constraints.find(x => x.type === 'length' && x.edgeIndex === edgeIdx)
    if (existing) {
      s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: mmVal, label, labelPos }))
    } else {
      s.execute(new AddConstraintCommand(contourId, {
        id: newConsId(), type: 'length', edgeIndex: edgeIdx, value: mmVal,
        labelPos, driving: true, label,
      } as Constraint))
    }
    checkState(contourId)
  }

  // ---- 智能尺寸: 两点距离 ----

  async function applyDistance(c: Contour, contourId: string, v1: number, v2: number, mmVal: number, replaceId?: string) {
    const s = useAppStore.getState()
    if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
    const n = c.points.length
    const targetPx = mmVal / s.project.config.pixelToMM
    let result
    if (isOrtho(c)) {
      // 正交板子: 全边 H/V + 两点距离, 几何闭合判定 → 保持矩形/凸形/凹形结构 (不会变梯形)
      result = await orthoSolve(c, [p2pDistance(v1, v2, targetPx)], s.project.config.pixelToMM, replaceId)
    } else {
      // 一般轮廓: 固定除两端点外的所有点 → 只动这两个顶点
      const fixed = Array.from({ length: n }, (_, i) => i).filter(i => i !== v1 && i !== v2)
      result = await solveSketch(c.points, [...existingConstraintsToSolver(c, s.project.config.pixelToMM, replaceId), p2pDistance(v1, v2, targetPx)], { fixedIndices: withStableAnchor(c, fixed), closed: isClosedGeo(c) })
    }
    if (!result.success) {
      upsertDriven(c, contourId, {
        type: 'distance', vertexIdx1: v1, vertexIdx2: v2, value: mmVal,
        labelPos: { x: (c.points[v1].x + c.points[v2].x) / 2, y: (c.points[v1].y + c.points[v2].y) / 2 - 20 },
      }, replaceId, `间距 ${mmVal.toFixed(1)} mm`)
      return
    }
    const old = c.points.map(p => ({ ...p }))
    c.points = result.points
    s.execute(new UpdateContourPointsCommand(contourId, old, result.points))

    const label = `距离 ${mmVal.toFixed(1)} mm`
    const labelPos = { x: (c.points[v1].x + c.points[v2].x) / 2, y: (c.points[v1].y + c.points[v2].y) / 2 - 20 }
    const existing = c.constraints.find(x => x.id === replaceId)
      ?? c.constraints.find(x => x.type === 'distance' && x.vertexIdx1 === v1 && x.vertexIdx2 === v2)
    if (existing) {
      s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: mmVal, label, labelPos }))
    } else {
      s.execute(new AddConstraintCommand(contourId, {
        id: newConsId(), type: 'distance', vertexIdx1: v1, vertexIdx2: v2,
        value: mmVal, labelPos, driving: true, label,
      } as Constraint))
    }
    checkState(contourId)
  }

    // ---- 智能尺寸: 中心距 / 跨轮廓两点距离 (几何平移驱动, 不经求解器) ----

    function applyCenterDist(c: Contour, contourId: string, v1: number, v2: number, mmVal: number, replaceId?: string, contourId2?: string) {
      const s = useAppStore.getState()
      if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
      const c2 = contourId2 ? findContour(contourId2) : c
      if (!c2) { setHint('找不到第二条轮廓'); return }
      const resolve = (contour: Contour, idx: number): Point2D | null =>
        idx === -3 ? { x: 0, y: 0 } : idx === -2 ? contourCenter(contour) : contour.points[idx] ?? null
      const a = resolve(c, v1)
      const b = resolve(c2, v2)
      if (!a || !b) { setHint('无法解析标注点'); return }
      const dx = b.x - a.x, dy = b.y - a.y
      const cur = Math.hypot(dx, dy)
      if (cur < 1e-6) { setHint('两点重合，无法标注距离'); return }
      const target = mmVal / s.project.config.pixelToMM
      const scale = target / cur
      const offsetX = dx * (scale - 1)
      const offsetY = dy * (scale - 1)
      const old2 = c2.points.map(p => ({ ...p }))
      let newPts2: Point2D[]
      let patch2: Partial<Contour> = {}
      if (v1 === -3 || v2 === -2) {
        // 固定原点是基准，不允许“原点跟着跑”；移动整个目标轮廓以保持其内部形状。
        const translated = translateContourGeometry(c2, offsetX, offsetY)
        newPts2 = translated.points
        patch2 = translated.patch
      } else {
        newPts2 = c2.points.map((p, i) => i === v2 ? { x: p.x + offsetX, y: p.y + offsetY } : p)
      }
      s.execute(new UpdateContourPointsCommand(c2.id, old2, newPts2, patch2))

      const label = (v1 === -3 || v2 === -3)
        ? `基准距 ${mmVal.toFixed(1)} mm`
        : (v1 === -2 || v2 === -2) ? `中心距 ${mmVal.toFixed(1)} mm` : `距离 ${mmVal.toFixed(1)} mm`
      const bNew = { x: b.x + offsetX, y: b.y + offsetY }
      const labelPos = { x: (a.x + bNew.x) / 2, y: (a.y + bNew.y) / 2 }
      const existing = c.constraints.find(x => x.id === replaceId)
        ?? c.constraints.find(x => x.type === 'distance' && x.vertexIdx1 === v1 && x.vertexIdx2 === v2 && x.contourId2 === contourId2)
      if (existing) {
        s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: mmVal, label, labelPos }))
      } else {
        s.execute(new AddConstraintCommand(contourId, {
          id: newConsId(), type: 'distance', vertexIdx1: v1, vertexIdx2: v2, contourId2,
          value: mmVal, labelPos, driving: true, label,
        } as Constraint))
      }
      checkState(contourId)
      if (c2.id !== contourId) checkState(c2.id)
    }


  // ---- 智能尺寸: 两条平行边间距 (几何平移驱动, 不经求解器) ----

  function applyParallelDist(c: Contour, contourId: string, e1: number, e2: number, mmVal: number, replaceId?: string, contourId2?: string) {
    const s = useAppStore.getState()
    if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
    const c2 = contourId2 ? findContour(contourId2) : c
    if (!c2) { setHint('找不到第二条轮廓'); return }
    const n = c.points.length
    const n2 = c2.points.length
    const a1 = c.points[e1], b1 = c.points[(e1 + 1) % n]
    const a2 = c2.points[e2], b2 = c2.points[(e2 + 1) % n2]
    const dx = b1.x - a1.x, dy = b1.y - a1.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len, ny = dx / len
    const mid2 = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 }
    const curD = (mid2.x - a1.x) * nx + (mid2.y - a1.y) * ny
    const target = mmVal / s.project.config.pixelToMM
    // 间距取绝对值, 平移方向按当前相对位置保持
    const delta = Math.abs(target) - Math.abs(curD)
    const dir = curD >= 0 ? 1 : -1
    const old2 = c2.points.map(p => ({ ...p }))
    const moveWholeContour = c2.id !== contourId
    const translated = moveWholeContour
      ? translateContourGeometry(c2, nx * delta * dir, ny * delta * dir)
      : null
    const newPts2 = translated?.points ?? c2.points.map((p, i) =>
      (i === e2 || i === (e2 + 1) % n2) ? { x: p.x + nx * delta * dir, y: p.y + ny * delta * dir } : p)
    s.execute(new UpdateContourPointsCommand(c2.id, old2, newPts2, translated?.patch))

    const label = `间距 ${mmVal.toFixed(1)} mm`
    const mid2New = { x: mid2.x + nx * delta * dir, y: mid2.y + ny * delta * dir }
    const along = (mid2New.x - a1.x) * (dx / len) + (mid2New.y - a1.y) * (dy / len)
    const q1 = { x: a1.x + (dx / len) * along, y: a1.y + (dy / len) * along }
    const q2 = { x: q1.x + nx * target * dir, y: q1.y + ny * target * dir }
    const labelPos = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 }
    const existing = c.constraints.find(x => x.id === replaceId)
      ?? c.constraints.find(x => x.type === 'distance' && x.edgeIndex === e1 && x.edgeIndex2 === e2 && x.contourId2 === contourId2)
    if (existing) {
      s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: mmVal, label, labelPos }))
    } else {
      s.execute(new AddConstraintCommand(contourId, {
        id: newConsId(), type: 'distance', edgeIndex: e1, edgeIndex2: e2, contourId2,
        value: mmVal, labelPos, driving: true, label,
      } as Constraint))
    }
    checkState(contourId)
    if (c2.id !== contourId) checkState(c2.id)
  }

  // ---- 智能尺寸: 点-线距离 (顶点平移驱动, 不经求解器) ----

  function applyPointLineDist(c: Contour, contourId: string, edgeIndex: number, vertexIdx: number, mmVal: number, replaceId?: string, contourId2?: string) {
    const s = useAppStore.getState()
    if (!Number.isFinite(mmVal) || mmVal <= 0) { setHint('尺寸必须为正数 (Esc 关闭提示)'); return }
    const n = c.points.length
    const a = c.points[edgeIndex % n], b = c.points[(edgeIndex + 1) % n]
    const pointContour = contourId2 ? findContour(contourId2) : c
    if (!pointContour) { setHint('找不到点所在轮廓'); return }
    const v = vertexIdx === -2 ? contourCenter(pointContour) : pointContour.points[vertexIdx]
    if (!v) { setHint('找不到标注点'); return }
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len, ny = dx / len
    const curD = (v.x - a.x) * nx + (v.y - a.y) * ny
    const target = mmVal / s.project.config.pixelToMM
    const delta = target - Math.abs(curD)
    const dir = curD >= 0 ? 1 : -1
    const old = pointContour.points.map(p => ({ ...p }))
    const moveWholeContour = pointContour.id !== contourId || vertexIdx === -2
    const translated = moveWholeContour
      ? translateContourGeometry(pointContour, nx * delta * dir, ny * delta * dir)
      : null
    const newPts = translated?.points ?? pointContour.points.map((p, i) =>
      i === vertexIdx ? { x: p.x + nx * delta * dir, y: p.y + ny * delta * dir } : p)
    s.execute(new UpdateContourPointsCommand(pointContour.id, old, newPts, translated?.patch))

    const label = `${vertexIdx === -2 ? '中心距' : '距离'} ${mmVal.toFixed(1)} mm`
    const vNew = { x: v.x + nx * delta * dir, y: v.y + ny * delta * dir }
    const proj = (v.x - a.x) * dx / len + (v.y - a.y) * dy / len
    const q = { x: a.x + (dx / len) * proj, y: a.y + (dy / len) * proj }
    const labelPos = { x: (vNew.x + q.x) / 2, y: (vNew.y + q.y) / 2 }
    const existing = c.constraints.find(x => x.id === replaceId)
      ?? c.constraints.find(x => x.type === 'distance' && x.edgeIndex === edgeIndex && x.vertexIdx1 === vertexIdx && x.contourId2 === contourId2)
    if (existing) {
      s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: mmVal, label, labelPos }))
    } else {
      s.execute(new AddConstraintCommand(contourId, {
        id: newConsId(), type: 'distance', edgeIndex, vertexIdx1: vertexIdx, contourId2,
        value: mmVal, labelPos, driving: true, label,
      } as Constraint))
    }
    checkState(contourId)
    if (pointContour.id !== contourId) checkState(pointContour.id)
  }

  // ---- 智能尺寸: 角度 (两击两条非平行边) ----

  /** 两边的夹角 (度, 0-180) */
  function edgeAngleDeg(c: Contour, edge1: number, edge2: number, c2?: Contour): number {
    const n = c.points.length
    const a1 = vecAngle(c.points[edge1], c.points[(edge1 + 1) % n])
    const n2 = c2 ? c2.points.length : n
      const a2 = c2
        ? vecAngle(c2.points[edge2], c2.points[(edge2 + 1) % n2])
        : vecAngle(c.points[edge2], c.points[(edge2 + 1) % n])
    let d = Math.abs(a1 - a2) * 180 / Math.PI
    if (d > 180) d = 360 - d
    return d
  }

  function vecAngle(a: Point2D, b: Point2D): number {
    return Math.atan2(b.y - a.y, b.x - a.x)
  }

  async function applyAngle(c: Contour, contourId: string, edge1: number, edge2: number, degVal: number, replaceId?: string, contourId2?: string) {
    const s = useAppStore.getState()
    if (!Number.isFinite(degVal) || degVal <= 0 || degVal >= 180) { setHint('角度必须在 0~180 之间'); return }
      if (contourId2) {
        const c2 = findContour(contourId2)
        if (!c2) { setHint('找不到第二条轮廓'); return }
        const n1 = c.points.length
        const n2 = c2.points.length
        const a1 = c.points[edge1], b1 = c.points[(edge1 + 1) % n1]
        const a2 = c2.points[edge2], b2 = c2.points[(edge2 + 1) % n2]
        const I = lineCross(a1, b1, a2, b2)
        const labelPos = I
          ? { x: (a1.x + b1.x + a2.x + b2.x) / 4, y: (a1.y + b1.y + a2.y + b2.y) / 4 - 20 }
          : { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 - 20 }
        const label = `角度 ${degVal.toFixed(1)}°`
        const existing = c.constraints.find(x => x.id === replaceId)
          ?? c.constraints.find(x => x.type === 'angle' && x.edgeIndex === edge1 && x.edgeIndex2 === edge2 && x.contourId2 === contourId2)
        if (existing) {
          s.execute(new UpdateConstraintCommand(contourId, existing.id, { value: degVal, label, labelPos, driving: false, contourId2 }))
        } else {
          s.execute(new AddConstraintCommand(contourId, {
            id: newConsId(), type: 'angle', edgeIndex: edge1, edgeIndex2: edge2, contourId2,
            value: degVal, labelPos, driving: false, label,
          } as Constraint))
        }
        checkState(contourId)
        return
      }
    const n = c.points.length
    const e1b = (edge1 + 1) % n
    const e2b = (edge2 + 1) % n

    let result
    if (isOrtho(c)) {
      result = await orthoSolve(c, [angle(edge1, e1b, edge2, e2b, degVal)], s.project.config.pixelToMM, replaceId)
    } else {
      const fixed = Array.from({ length: n }, (_, i) => i)
        .filter(i => i !== edge1 && i !== e1b && i !== edge2 && i !== e2b)
      result = await solveSketch(c.points, [...existingConstraintsToSolver(c, s.project.config.pixelToMM, replaceId), angle(edge1, e1b, edge2, e2b, degVal)], { fixedIndices: withStableAnchor(c, fixed), closed: isClosedGeo(c) })
    }

    if (!result.success) {
      upsertDriven(c, contourId, {
        type: 'angle', edgeIndex: edge1, edgeIndex2: edge2, value: degVal,
        labelPos: edgePos(c, edge1, edge2),
      }, replaceId, `角度 ${degVal.toFixed(1)}°`)
      return
    }
    const old = c.points.map(p => ({ ...p }))
    c.points = result.points
    s.execute(new UpdateContourPointsCommand(contourId, old, result.points))

    const label = `角度 ${degVal.toFixed(1)}°`
    const existing = c.constraints.find(x => x.id === replaceId)
      ?? c.constraints.find(x => x.type === 'angle' && x.edgeIndex === edge1 && x.edgeIndex2 === edge2 && !x.contourId2)
    if (existing) {
      s.execute(new UpdateConstraintCommand(contourId, existing.id, {
        value: degVal, label, labelPos: edgePos(c, edge1, edge2),
      }))
    } else {
      s.execute(new AddConstraintCommand(contourId, {
        id: newConsId(), type: 'angle', edgeIndex: edge1, edgeIndex2: edge2,
        value: degVal, labelPos: edgePos(c, edge1, edge2), driving: true, label,
      } as Constraint))
    }
    checkState(contourId)
  }

  /** 约束标注位置: 边中点偏移, 双约束时偏向第二条边一侧 */
  function edgePos(c: Contour, edge1: number, edge2?: number): Point2D {
    const n = c.points.length
    const a = c.points[edge1], b = c.points[(edge1 + 1) % n]
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if (edge2 !== undefined) {
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len, ny = dx / len
      const e2a = c.points[edge2]
      const side = (e2a.x - mx) * nx + (e2a.y - my) * ny
      const k = side >= 0 ? 20 : -20
      return { x: mx + nx * k, y: my + ny * k }
    }
    return { x: mx, y: my - 20 }
  }

  /** 空白判定: 无轮廓/顶点/标注命中 (供画布"空白处左键拖动 = 平移") */
  function isEmptyAt(pos: Point2D): boolean {
    return !hitTest(pos) && !vertexHit(pos) && !constraintHit(pos)
  }

  return {
    handleClick, handleDoubleClick, handleKeyDown,
    handleDown, handleMove, handleUp,
    preview, hint, tool: activeTool, snapState, hoverConstraint,
    isEmptyAt,
  }
}
