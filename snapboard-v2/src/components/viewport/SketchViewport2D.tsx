// ============ 2D 草图视口 — Canvas 按需重绘 v3 ============
// 渲染: 折线+弧实体边 / 无限长构造线 / 圆 / 槽口(含R标注) / 多边形(中心标记)
// 预览: line/rect/circle(实时R)/polygon(参考圆+中心)/slot(实时宽+R)/arc/拖动/擦除高亮
// 吸附高亮: 金色圆环+十字+标签; 内轮廓(开孔)固定红
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { playHoleTapSound } from '../../utils/interactionSound'
import { viewportCamera } from '../../engine/viewportCamera'
import type { ArcEntity, Constraint, Contour, Feature, Point2D, SplitPanel, SplitConfig } from '../../types/geometry'
import type { GuideLine, SketchPreview } from '../../hooks/useSketchTool'
import { contourCenter, edgeArc, ptSegDist, standaloneArc } from '../../utils/entities'
import { circumcenter, normAngle, getCircleArcSegments } from '../../utils/arc'
import {
  DIMENSION_LABEL_FONT, DIMENSION_LABEL_RADIUS, dimensionLabelBounds,
} from '../../utils/dimensionLabel'

// ---- 主题色 (深灰中性 + 青绿强调) ----
const C = {
  bg: '#1c1f26',
  panel: '#23262e',
  border: '#353a45',
  text: '#d7dbe2',
  textDim: '#8b93a3',
  accent: '#3ec6b0',        // 青绿强调
  outer: '#57c7b5',         // 外轮廓
  inner: '#ff6b6b',         // 内轮廓 (开孔)
  stateUnder: '#4fc3f7',
  stateFully: '#d8dde6',
  stateOver: '#ff6b6b',
  select: '#ffd166',        // 选中金
  snap: '#ffd166',
  erase: '#ff6b6b',
  construction: 'rgba(255,255,255,0.32)',
  dim: '#3ec6b0',           // 尺寸标注
  geom: '#b39ddb',          // 几何关系
}

interface Camera {
  offsetX: number
  offsetY: number
  scale: number
}

interface Props {
  onCanvasClick?: (pos: Point2D) => void
  onCanvasMove?: (pos: Point2D) => void
  onCanvasMouseDown?: (pos: Point2D) => void
  onCanvasMouseUp?: () => void
  onCanvasDoubleClick?: (pos: Point2D) => void
  preview?: SketchPreview | null
  hint?: string | null
  /** 悬停中的约束标注 id (高亮 + 手型光标) */
  hoverConstraintId?: string | null
}

export function SketchViewport2D({
  onCanvasClick, onCanvasMove, onCanvasMouseDown, onCanvasMouseUp, onCanvasDoubleClick, preview, hint, hoverConstraintId,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [camera, setCamera] = useState<Camera>({ offsetX: 80, offsetY: 80, scale: 1 })
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  const project = useAppStore(s => s.project)
  const pixelToMM = project.config.pixelToMM

  // 同步相机到共享引用: 命中/吸附阈值 (屏幕 px) 需换算世界单位
  useEffect(() => {
    viewportCamera.scale = camera.scale
    viewportCamera.offsetX = camera.offsetX
    viewportCamera.offsetY = camera.offsetY
  }, [camera])

  const activeSketchId = useAppStore(s => s.ui.activeSketchId)
  const selectedContourId = useAppStore(s => s.ui.selectedContourId)
  const selectedConstraintId = useAppStore(s => s.ui.selectedConstraintId)
  const solveStates = useAppStore(s => s.ui.solveStates)
  // ---- 自动分割结果 (分割预览覆盖层) ----
  const splitResult = useAppStore(s => s.splitResult)
  const splitCfg = useAppStore(s => s.splitConfig)
  const toggleEdgeHole = useAppStore(s => s.toggleEdgeHole)
  const [hoverEdgeHole, setHoverEdgeHole] = useState(false)
  const pendingEdgeHoleRef = useRef<{
    panelId: string; panelX: number; panelY: number; holeX: number; holeY: number
  } | null>(null)

  const sketch = project.parts
    .flatMap(p => p.features)
    .find(f => f.type === 'sketch' && f.id === activeSketchId) as
    | { type: 'sketch'; contours: Contour[] }
    | undefined

  // ★ 按需重绘
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (rect) {
        canvas.width = rect.width
        canvas.height = rect.height
      }
    }
    resize()

    const draw = () => {
      const { offsetX, offsetY, scale } = cameraRef.current
      ctx.fillStyle = C.bg
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // 背景网格
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      const gridSize = 40 * scale
      const startX = offsetX % gridSize
      const startY = offsetY % gridSize
      for (let x = startX; x < canvas.width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
      }
      for (let y = startY; y < canvas.height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
      }

      // 坐标系原点标志 (X/Y 小标志)
      drawOriginMarker(ctx, cameraRef.current)

      // 绘制轮廓 + 约束
      if (sketch) {
        const splitSourceIds = new Set(splitResult?.sources.flatMap(src => src.sourceIds ?? [src.contourId]) ?? [])
        for (const c of sketch.contours) {
          // 分割预览已有独立的 R8 面板外轮廓；隐藏对应原始方角草图线，
          // 否则圆角外残留的源轮廓会在视觉上把圆角重新补成方角。
          if (splitSourceIds.has(c.id)) continue
          drawContour(ctx, c, cameraRef.current)
        }
        const sel = sketch.contours.find(c => c.id === selectedContourId)
        if (sel && !splitSourceIds.has(sel.id)) drawContour(ctx, sel, cameraRef.current, C.select, true)
        for (const cc of sketch.contours) {
          for (const cons of cc.constraints) {
            drawConstraint(ctx, cc, cons, cameraRef.current)
          }
        }
      }

      // 分割预览覆盖层: 板块划分 + R角倒角 + 长圆孔 + 5mm拼接孔 + 编号
      if (splitResult && splitResult.panels.length > 0) {
        drawSplitPreview(ctx, splitResult.panels, splitCfg, cameraRef.current)
      }

      // 空画布引导
      if (!sketch || sketch.contours.length === 0) {
        ctx.font = '15px sans-serif'
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        ctx.textAlign = 'center'
        ctx.fillText('从顶部工具栏选择工具开始绘制 (P 直线 · R 矩形 · C 圆 · A 弧 · G 多边形)', canvas.width / 2, canvas.height / 2)
        ctx.textAlign = 'left'
      }

      // 绘制中的实时预览 (橡皮筋)
      if (preview) drawPreview(ctx, preview, cameraRef.current)

      // 操作提示
      if (hint) {
        ctx.font = '13px sans-serif'
        const w = ctx.measureText(hint).width
        ctx.fillStyle = 'rgba(35,38,46,0.92)'
        ctx.fillRect(canvas.width / 2 - w / 2 - 14, canvas.height - 48, w + 28, 28)
        ctx.strokeStyle = 'rgba(62,198,176,0.55)'
        ctx.strokeRect(canvas.width / 2 - w / 2 - 14, canvas.height - 48, w + 28, 28)
        ctx.fillStyle = C.accent
        ctx.fillText(hint, canvas.width / 2 - w / 2, canvas.height - 28)
      }
    }

    draw()
    const redrawAtCurrentSize = () => {
      resize()
      draw()
    }
    const parent = canvas.parentElement
    const resizeObserver = new ResizeObserver(redrawAtCurrentSize)
    if (parent) resizeObserver.observe(parent)
    window.addEventListener('resize', redrawAtCurrentSize)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', redrawAtCurrentSize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drawContour/drawPreview 仅在本 effect 内使用
  }, [camera, sketch, selectedContourId, selectedConstraintId, solveStates, preview, hint, pixelToMM, hoverConstraintId, splitResult, splitCfg])

  /** 轮廓状态色: 蓝欠定义 / 白完全定义 / 红过定义; 内轮廓固定红 (开孔) */
  const stateColor = (c: Contour): string | null => {
    const st = solveStates[c.id]
    if (!st) return null
    if (st === 'over') return C.stateOver
    if (st === 'fully') return C.stateFully
    return C.stateUnder
  }

  const sx = (p: Point2D, cam: Camera) => cam.offsetX + p.x * cam.scale
  const sy = (p: Point2D, cam: Camera) => cam.offsetY + p.y * cam.scale

  /** 按 id 找轮廓 (预览渲染共用) */
  const findContourById = (id: string): Contour | undefined =>
    project.parts.flatMap(p => p.features)
      .find((f): f is Extract<Feature, { type: 'sketch' }> =>
        f.type === 'sketch' && f.contours.some(x => x.id === id))
      ?.contours.find(x => x.id === id)

  /** 2D 坐标系原点标志: 小号 X(红)/Y(绿) 轴 + 原点 (方便定位) */
  const drawOriginMarker = (ctx: CanvasRenderingContext2D, cam: Camera) => {
    const ox = cam.offsetX, oy = cam.offsetY
    const L = 40
    ctx.save()
    ctx.lineWidth = 1.5
    // X 轴 (红, 向右)
    ctx.strokeStyle = '#ff6b6b'
    ctx.beginPath()
    ctx.moveTo(ox, oy)
    ctx.lineTo(ox + L, oy)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(ox + L, oy)
    ctx.lineTo(ox + L - 7, oy - 4)
    ctx.lineTo(ox + L - 7, oy + 4)
    ctx.closePath()
    ctx.fillStyle = '#ff6b6b'
    ctx.fill()
    // Y 轴 (绿, 向上)
    ctx.strokeStyle = '#7bd88f'
    ctx.beginPath()
    ctx.moveTo(ox, oy)
    ctx.lineTo(ox, oy - L)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(ox, oy - L)
    ctx.lineTo(ox - 4, oy - L + 7)
    ctx.lineTo(ox + 4, oy - L + 7)
    ctx.closePath()
    ctx.fillStyle = '#7bd88f'
    ctx.fill()
    // 原点
    ctx.fillStyle = '#d7dbe2'
    ctx.beginPath()
    ctx.arc(ox, oy, 2.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = '10px sans-serif'
    ctx.fillStyle = '#ff6b6b'
    ctx.fillText('X', ox + L + 4, oy + 3)
    ctx.fillStyle = '#7bd88f'
    ctx.fillText('Y', ox + 2, oy - L - 4)
    ctx.restore()
  }


  /** 分割预览调色板 (按面板序号交替) */
  const PANEL_FILLS = ['rgba(62,198,176,0.14)', 'rgba(255,209,102,0.11)', 'rgba(179,157,219,0.15)', 'rgba(94,164,255,0.12)']
  const PANEL_STROKES = ['#3ec6b0', '#ffd166', '#b39ddb', '#5ea4ff']

  /**
   * 四角独立圆角矩形路径 (画布 y 向下): r = { tl, tr, br, bl } 每角半径 (px)。
   * 半径 0 = 直角。用于分割预览: 接缝/内部角直角、外轮廓凸角圆角, 拼装紧密平齐。
   */
  const panelRectPath = (
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    r: { tl: number; tr: number; br: number; bl: number },
  ) => {
    const mt = (v: number) => Math.max(0, Math.min(v, w / 2, h / 2))
    const rTL = mt(r.tl), rTR = mt(r.tr), rBR = mt(r.br), rBL = mt(r.bl)
    ctx.beginPath()
    ctx.moveTo(x + rTL, y)
    ctx.lineTo(x + w - rTR, y)
    ctx.arcTo(x + w, y, x + w, y + rTR, rTR)
    ctx.lineTo(x + w, y + h - rBR)
    ctx.arcTo(x + w, y + h, x + w - rBR, y + h, rBR)
    ctx.lineTo(x + rBL, y + h)
    ctx.arcTo(x, y + h, x, y + h - rBL, rBL)
    ctx.lineTo(x, y + rTL)
    ctx.arcTo(x, y, x + rTL, y, rTL)
    ctx.closePath()
  }

  /** 竖向长圆孔(胶囊)路径 (画布 y 向下): 中心 (cx,cy), 半长 halfL, 端部半径 r */
  const capsulePath = (ctx: CanvasRenderingContext2D, cx: number, cy: number, halfL: number, r: number) => {
    const topY = cy - (halfL - r) // 上端半圆圆心 (画布 y 向下, 上方为小 y)
    const botY = cy + (halfL - r) // 下端半圆圆心
    ctx.beginPath()
    ctx.moveTo(cx - r, topY)
    ctx.lineTo(cx - r, botY)
    ctx.ellipse(cx, botY, r, r, 0, Math.PI, 0, true)   // 下端半圆 (经 π/2, 画布下方)
    ctx.lineTo(cx + r, topY)
    ctx.ellipse(cx, topY, r, r, 0, 0, Math.PI, true)   // 上端半圆 (经 -π/2, 画布上方)
    ctx.closePath()
  }

  /**
   * 正交多边形面板路径 (画布 y 向下): pts 为屏幕坐标顶点, roundIdx 顶点圆角 (px)。
   * 矩形/L 型通用; 接缝/内部角直角, 外轮廓凸角圆角。
   */
  const panelPolyPath = (
    ctx: CanvasRenderingContext2D,
    pts: { x: number; y: number }[],
    roundIdx: number[],
    r: number,
  ) => {
    const n = pts.length
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n]
      const cur = pts[i]
      const next = pts[(i + 1) % n]
      const inLen = Math.hypot(prev.x - cur.x, prev.y - cur.y)
      const outLen = Math.hypot(next.x - cur.x, next.y - cur.y)
      const rad = roundIdx.includes(i) ? Math.min(r, inLen / 2, outLen / 2) : 0
      const entry = rad > 0.01
        ? { x: cur.x + (prev.x - cur.x) * rad / inLen, y: cur.y + (prev.y - cur.y) * rad / inLen }
        : cur
      const exit = rad > 0.01
        ? { x: cur.x + (next.x - cur.x) * rad / outLen, y: cur.y + (next.y - cur.y) * rad / outLen }
        : cur
      if (i === 0) ctx.moveTo(entry.x, entry.y)
      else ctx.lineTo(entry.x, entry.y)
      if (rad > 0.01) ctx.arcTo(cur.x, cur.y, exit.x, exit.y, rad)
      else ctx.lineTo(cur.x, cur.y)
    }
    ctx.closePath()
  }

  /**
   * 分割预览: 在 2D 画布上把分割结果叠画到原轮廓上
   *  - 每块面板轮廓 (矩形/L 型, 圆角 R = cornerRadius 倒角预览)
   *  - 长圆孔阵列 (竖向胶囊 slotWidth × slotLength, 端部 R = slotWidth/2)
   *  - 候选圆孔 (已打孔=黄色环+实心; 未打孔=虚线位置提示)
   *  - 板编号 + 尺寸标注
   * 数据为全局 mm (y 向上), 画布世界坐标为像素 (y 向下), 需换算
   */
  const drawSplitPreview = (
    ctx: CanvasRenderingContext2D,
    panels: SplitPanel[],
    cfg: SplitConfig,
    cam: Camera,
  ) => {
    const px = pixelToMM // mm → 世界(像素) 换算
    if (px <= 0) return
    // mm (y 向上) → 世界坐标 (y 向下, 与画布一致)
    const m2w = (mx: number, my: number) => ({ x: mx / px, y: -my / px })
    // 世界坐标 → 屏幕坐标 (相机变换, 与轮廓渲染一致)
    const w2s = (wx: number, wy: number) => ({ x: cam.offsetX + wx * cam.scale, y: cam.offsetY + wy * cam.scale })
    const S = cam.scale

    ctx.save()
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i]
      const tl = w2s(m2w(p.x, p.y + p.h).x, m2w(p.x, p.y + p.h).y) // 画布左上 (mm 右上角)
      const w = (p.w / px) * S
      const h = (p.h / px) * S
      const fill = PANEL_FILLS[i % PANEL_FILLS.length]
      const stroke = PANEL_STROKES[i % PANEL_STROKES.length]

      // ---- 面板本体: 矩形/L 型轮廓 (仅外轮廓凸角 R 倒角, 接缝/内部角直角) ----
      const rad = Math.min((cfg.cornerRadius / px) * S, w / 2, h / 2)
      const oc = p.outerCorners ?? [true, true, true, true]
      if (p.contour && p.contour.length >= 4) {
        const cpts = p.contour.map(pt => w2s(m2w(pt.x, pt.y).x, m2w(pt.x, pt.y).y))
        panelPolyPath(ctx, cpts, p.roundIdx ?? [], rad)
      } else {
        panelRectPath(ctx, tl.x, tl.y, w, h, {
          tl: oc[3] ? rad : 0, // 画布左上 = mm 顶左
          tr: oc[2] ? rad : 0, // 画布右上 = mm 顶右
          br: oc[1] ? rad : 0, // 画布右下 = mm 底右
          bl: oc[0] ? rad : 0, // 画布左下 = mm 底左
        })
      }
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = stroke
      ctx.lineWidth = Math.max(1, 1.6 * S)
      ctx.stroke()

      // ---- 用户内轮廓通孔 (插座/开关盒等): 显示为真正挖空区域 ----
      for (const cutout of p.cutouts ?? []) {
        if (cutout.length < 3) continue
        const pts = cutout.map(pt => w2s(m2w(pt.x, pt.y).x, m2w(pt.x, pt.y).y))
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let ci = 1; ci < pts.length; ci++) ctx.lineTo(pts[ci].x, pts[ci].y)
        ctx.closePath()
        ctx.fillStyle = C.bg
        ctx.fill()
        ctx.setLineDash([])
        ctx.strokeStyle = 'rgba(255,107,107,0.95)'
        ctx.lineWidth = Math.max(1.2, 1.6 * S)
        ctx.stroke()
      }

      // ---- 竖向长圆孔(胶囊)阵列 (错列晶体, 与工程图一致) ----
      const halfL = Math.max(0.8, (cfg.slotLength / 2 / px) * S)       // 半长 (长轴/2)
      const sr = Math.max(0.6, (cfg.slotWidth / 2 / px) * S)           // 端部半圆半径 (短轴/2)
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = Math.max(0.8, S)
      for (const s of p.slots) {
        const m = m2w(s.x, s.y)
        const c = w2s(m.x, m.y)
        capsulePath(ctx, c.x, c.y, halfL, sr)
        ctx.fill()
        ctx.stroke()
      }

      // ---- 副对角线固定孔 (板内整圆, φ=jointDiameter=6, 距角 10mm; 全板仅 2 个) ----
      const cr = Math.max(0.6, (cfg.jointDiameter / 2 / px) * S)
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = Math.max(0.8, S)
      for (const rh of p.round_holes) {
        const m = m2w(rh.x, rh.y)
        const c = w2s(m.x, m.y)
        ctx.beginPath()
        ctx.arc(c.x, c.y, cr, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }

      // ---- 候选圆孔 (φ5): 已启用=真实通孔; 未启用=完整板面上的虚线位置提示 ----
      const jr = Math.max(0.6, (cfg.jointDiameter / 2 / px) * S)
      ctx.lineWidth = Math.max(0.8, S)
      for (const eh of p.edge_holes) {
        const m = m2w(eh.x, eh.y)
        const c = w2s(m.x, m.y)
        const onBoundary = Math.abs(eh.x - p.x) < 0.5 || Math.abs(eh.x - (p.x + p.w)) < 0.5 ||
          Math.abs(eh.y - p.y) < 0.5 || Math.abs(eh.y - (p.y + p.h)) < 0.5
        if (onBoundary || eh.knocked) {
          // 已打孔: 单一黄色孔圈 + 深色通孔。
          // 不再额外画第二层外光晕，避免视觉上被误认成两个圆孔重叠。
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.arc(c.x, c.y, jr, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(0,0,0,0.55)'
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,209,102,0.95)'
          ctx.lineWidth = Math.max(1.4, 1.8 * S)
          ctx.stroke()
        } else {
          // 未打孔: 虚线位置提示 + 中心定位点（不代表实体薄盖）。
          ctx.setLineDash([Math.max(2, 2.4 * S), Math.max(1.5, 1.8 * S)])
          ctx.beginPath()
          ctx.arc(c.x, c.y, jr, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'
          ctx.stroke()
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.arc(c.x, c.y, Math.max(0.8, 0.5 * S), 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(0,0,0,0.35)'
          ctx.fill()
        }
      }

      // ---- 板编号 + 尺寸 (字号随缩放, 限制范围) ----
      const cm = m2w(p.x + p.w / 2, p.y + p.h / 2)
      const cc = w2s(cm.x, cm.y)
      const fs = Math.min(16, Math.max(8, 12 * S))
      ctx.textAlign = 'center'
      ctx.font = 'bold ' + fs + 'px sans-serif'
      ctx.fillStyle = stroke
      ctx.fillText(p.id, cc.x, cc.y + 2)
      ctx.font = Math.max(7, fs - 2.5) + 'px sans-serif'
      ctx.fillStyle = 'rgba(255,255,255,0.65)'
      ctx.fillText(p.w + 'x' + p.h, cc.x, cc.y + fs + 2)
      ctx.textAlign = 'left'
    }
    ctx.restore()
  }

  /** 圆心十字标记 */
  const drawCenterMark = (ctx: CanvasRenderingContext2D, p: Point2D, cam: Camera, col = 'rgba(255,255,255,0.4)') => {
    const cx = sx(p, cam), cy = sy(p, cam)
    ctx.strokeStyle = col
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy)
    ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5)
    ctx.stroke()
  }

  /** 通用轮廓路径: 折线 + 弧实体边 */
  const drawPath = (
    ctx: CanvasRenderingContext2D,
    points: Point2D[],
    closed: boolean,
    arcs: ArcEntity[] | undefined,
    cam: Camera,
    col: string,
    thick: boolean,
  ) => {
    const n = points.length
    if (n < 2) return
    ctx.beginPath()
    ctx.moveTo(sx(points[0], cam), sy(points[0], cam))
    const total = closed && n > 2 ? n : n - 1
    for (let i = 0; i < total; i++) {
      const j = (i + 1) % n
      const arc = arcs?.find(a => a.p1 === i && a.p2 === j)
      if (arc) {
        const a1 = Math.atan2(points[i].y - arc.center.y, points[i].x - arc.center.x)
        const a2 = Math.atan2(points[j].y - arc.center.y, points[j].x - arc.center.x)
        ctx.arc(sx(arc.center, cam), sy(arc.center, cam), arc.radius * cam.scale, a1, a2, arc.sweep === 'cw')
      } else {
        ctx.lineTo(sx(points[j], cam), sy(points[j], cam))
      }
    }
    if (closed) ctx.closePath()
    ctx.strokeStyle = col
    ctx.lineWidth = thick ? 3 : 2
    ctx.stroke()
  }

  /** 无限长构造线 */
  const drawInfiniteLine = (ctx: CanvasRenderingContext2D, p0: Point2D, p1: Point2D, cam: Camera, col: string) => {
    const dx = p1.x - p0.x, dy = p1.y - p0.y
    const len = Math.hypot(dx, dy)
    if (len < 0.001) return
    const ux = dx / len, uy = dy / len
    const t = 100000
    ctx.save()
    ctx.strokeStyle = col
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(sx({ x: p0.x - ux * t, y: p0.y - uy * t }, cam), sy({ x: p0.x - ux * t, y: p0.y - uy * t }, cam))
    ctx.lineTo(sx({ x: p0.x + ux * t, y: p0.y + uy * t }, cam), sy({ x: p0.x + ux * t, y: p0.y + uy * t }, cam))
    ctx.stroke()
    ctx.restore()
  }

  const drawContour = (
    ctx: CanvasRenderingContext2D,
    c: Contour,
    cam: Camera,
    color?: string,
    thick = false,
  ) => {
    // 颜色: 选中金 > 内轮廓红 (开孔) > 状态色 > 默认青绿
    // 开放轮廓 (未闭合) 用浅灰蓝, 闭合轮廓保持主题色 (SolidWorks 式区分)
    let col = color ?? (c.type === 'inner' ? C.inner : (stateColor(c) ?? C.outer))
    if (!color && !c.construction && c.type !== 'inner' && !c.closed) {
      col = '#9aa4b5'
    }

    // 无限长构造线
    if (c.construction && c.infinite && !c.closed && c.points.length >= 2) {
      drawInfiniteLine(ctx, c.points[0], c.points[1], cam, color === C.select ? C.select : C.construction)
      return
    }

    // 槽口 (胶囊): 两点定中心线 + 宽度 + R 标注
    if (c.slotWidth !== undefined && c.points.length >= 2) {
      drawSlotShape(ctx, c.points[0], c.points[1], c.slotWidth, cam, col, thick)
      // 中心线 (虚线)
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(sx(c.points[0], cam), sy(c.points[0], cam))
      ctx.lineTo(sx(c.points[1], cam), sy(c.points[1], cam))
      ctx.stroke()
      ctx.restore()
      // R 标注 (端部)
      const p2 = c.points[1]
      const dx = p2.x - c.points[0].x, dy = p2.y - c.points[0].y
      const len = Math.hypot(dx, dy)
      if (len > 0.001) {
        const ux = dx / len, uy = dy / len
        const rMM = (c.slotWidth / 2) * pixelToMM
        ctx.font = '11px sans-serif'
        ctx.fillStyle = C.dim
        ctx.fillText(`R ${rMM.toFixed(1)}`, sx({ x: p2.x + ux * (c.slotWidth / 2 + 14), y: p2.y + uy * (c.slotWidth / 2 + 14) }, cam), sy({ x: p2.x + ux * (c.slotWidth / 2 + 14), y: p2.y + uy * (c.slotWidth / 2 + 14) }, cam) + 4)
      }
      return
    }

    if (c.shape === 'circle' && c.center && c.radius) {
      ctx.beginPath()
      ctx.arc(sx(c.center, cam), sy(c.center, cam), c.radius * cam.scale, 0, Math.PI * 2)
      ctx.strokeStyle = col
      ctx.lineWidth = thick ? 3 : 2
      ctx.stroke()
      drawCenterMark(ctx, c.center, cam)
      return
    }
    if (c.points.length < 2) return

    // 折线 + 弧实体边 / 构造线虚线
    ctx.save()
    if (c.construction) {
      ctx.setLineDash([4, 4])
      const consCol = color === C.select ? C.select : C.construction
      ctx.strokeStyle = consCol
      ctx.lineWidth = 1
      drawPath(ctx, c.points, c.closed, c.arcs, cam, consCol, false)
    } else {
      drawPath(ctx, c.points, c.closed, c.arcs, cam, col, thick)
    }
    ctx.restore()

    // 多边形中心标记
    if (c.shape === 'polygon' && c.center) {
      drawCenterMark(ctx, c.center, cam, 'rgba(255,209,102,0.7)')
      ctx.strokeStyle = 'rgba(255,209,102,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(sx(c.center, cam), sy(c.center, cam), 6, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 弧实体圆心标记
    for (const arc of c.arcs ?? []) {
      drawCenterMark(ctx, arc.center, cam)
    }

    // 顶点 (构造线不画顶点)
    if (!c.construction) {
      ctx.fillStyle = c.type === 'inner' ? C.inner : '#e8ecf2'
      for (const p of c.points) {
        ctx.beginPath()
        ctx.arc(sx(p, cam), sy(p, cam), 3, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  /** 槽口胶囊形状: 两半圆 + 两直线 */
  const drawSlotShape = (
    ctx: CanvasRenderingContext2D,
    p1: Point2D, p2: Point2D, w: number,
    cam: Camera, col: string, thick: boolean,
  ) => {
    const dx = p2.x - p1.x, dy = p2.y - p1.y
    const len = Math.hypot(dx, dy)
    if (len < 0.001) return
    const ux = dx / len, uy = dy / len
    const nx = -uy, ny = ux
    const half = w / 2
    const A = { x: sx(p1, cam) - nx * half * cam.scale, y: sy(p1, cam) - ny * half * cam.scale }
    const B = { x: sx(p1, cam) + nx * half * cam.scale, y: sy(p1, cam) + ny * half * cam.scale }
    const D = { x: sx(p2, cam) - nx * half * cam.scale, y: sy(p2, cam) - ny * half * cam.scale }
    const r = half * cam.scale
    ctx.beginPath()
    ctx.moveTo(A.x, A.y)
    ctx.lineTo(D.x, D.y)
    ctx.arc(sx(p2, cam), sy(p2, cam), r, Math.atan2(-ny, -nx), Math.atan2(ny, nx), false)
    ctx.lineTo(B.x, B.y)
    ctx.arc(sx(p1, cam), sy(p1, cam), r, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false)
    ctx.closePath()
    ctx.strokeStyle = col
    ctx.lineWidth = thick ? 3 : 2
    ctx.stroke()
  }

  /** 高亮单条边 (擦除悬停/扫过 / 选择与尺寸悬停微高亮) */
  const drawEdgeHighlight = (
    ctx: CanvasRenderingContext2D,
    c: Contour,
    edgeIdx: number,
    cam: Camera,
    col: string = C.erase,
    t1 = 0,
    t2 = 1,
  ) => {
      if (c.construction && c.infinite && !c.closed && c.points.length >= 2) {
        drawInfiniteLine(ctx, c.points[0], c.points[1], cam, col)
        return
      }
      if (c.shape === 'circle' && c.center && c.radius) {
        if (edgeIdx === -1) {
          ctx.strokeStyle = col
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(sx(c.center, cam), sy(c.center, cam), c.radius * cam.scale, 0, Math.PI * 2)
          ctx.stroke()
          return
        }
        const segs = getCircleArcSegments(c, sketch?.contours ?? [])
        if (segs && edgeIdx >= 0 && edgeIdx < segs.length) {
          const seg = segs[edgeIdx]
          ctx.save()
          ctx.strokeStyle = col
          ctx.lineWidth = 3
          ctx.setLineDash([6, 3])
          ctx.beginPath()
          ctx.arc(sx(seg.center, cam), sy(seg.center, cam), seg.radius * cam.scale, seg.startAngle, seg.endAngle, seg.sweep === 'cw')
          ctx.stroke()
          ctx.restore()
          return
        }
        return
      }
      const n2 = c.points.length
      const total2 = c.closed && n2 > 2 ? n2 : n2 - 1
      if (edgeIdx < 0 || edgeIdx >= total2) return
      const j2 = (edgeIdx + 1) % n2
      const arc2 = edgeArc(c, edgeIdx)
      ctx.strokeStyle = col
      ctx.lineWidth = 3
      ctx.beginPath()
      if (arc2) {
        const a1 = Math.atan2(c.points[edgeIdx].y - arc2.center.y, c.points[edgeIdx].x - arc2.center.x)
        const a2 = Math.atan2(c.points[j2].y - arc2.center.y, c.points[j2].x - arc2.center.x)
        ctx.arc(sx(arc2.center, cam), sy(arc2.center, cam), arc2.radius * cam.scale, a1, a2, arc2.sweep === 'cw')
      } else {
        const a = c.points[edgeIdx]
        const b = c.points[j2]
        const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 }
        const p2 = { x: a.x + (b.x - a.x) * t2, y: a.y + (b.y - a.y) * t2 }
        ctx.moveTo(sx(p1, cam), sy(p1, cam))
        ctx.lineTo(sx(p2, cam), sy(p2, cam))
      }
      ctx.stroke()
      // (下方旧实现已由上文完整覆盖, 历史遗留死代码已删除)
  }

  /** 推理参考线 (对齐引导): 贯穿视口的横/竖虚线 + 参考点菱形标记 */
  const drawGuides = (ctx: CanvasRenderingContext2D, guides: GuideLine[], cam: Camera) => {
    for (const g of guides) {
      const solid = g.kind !== 'axis-soft'
      ctx.save()
      ctx.strokeStyle = solid ? 'rgba(62,198,176,0.85)' : 'rgba(62,198,176,0.30)'
      ctx.lineWidth = 1
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      if (g.dir === 'h') {
        const y = sy({ x: 0, y: g.at }, cam)
        ctx.moveTo(0, y)
        ctx.lineTo(ctx.canvas.width, y)
      } else {
        const x = sx({ x: g.at, y: 0 }, cam)
        ctx.moveTo(x, 0)
        ctx.lineTo(x, ctx.canvas.height)
      }
      ctx.stroke()
      ctx.setLineDash([])
      // 参考顶点菱形标记
      const mx = sx(g.marker, cam), my = sy(g.marker, cam)
      ctx.strokeStyle = solid ? 'rgba(255,209,102,0.9)' : 'rgba(255,209,102,0.4)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(mx, my - 4); ctx.lineTo(mx + 4, my); ctx.lineTo(mx, my + 4); ctx.lineTo(mx - 4, my)
      ctx.closePath()
      ctx.stroke()
      ctx.restore()
    }
  }

  /** 实心箭头 (尖端在 tip, 指向 ang) */
  const drawArrowHead = (ctx: CanvasRenderingContext2D, tip: { x: number; y: number }, ang: number, size: number, col: string) => {
    ctx.save()
    ctx.translate(tip.x, tip.y)
    ctx.rotate(ang)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(-size, -size * 0.45)
    ctx.lineTo(-size, size * 0.45)
    ctx.closePath()
    ctx.fillStyle = col
    ctx.fill()
    ctx.restore()
  }

  /** 浅色底框标签 (数字带框, 悬停/选中高亮) */
  const boxedLabel = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, col: string, highlight: boolean) => {
    ctx.save()
    ctx.font = DIMENSION_LABEL_FONT
    const box = dimensionLabelBounds(text, x, y, value => ctx.measureText(value).width)
    ctx.beginPath()
    ctx.roundRect(box.left, box.top, box.width, box.height, DIMENSION_LABEL_RADIUS)
    ctx.fillStyle = highlight ? 'rgba(12,16,22,0.98)' : 'rgba(28,32,40,0.82)'
    if (highlight) {
      ctx.shadowColor = 'rgba(255,209,102,0.45)'
      ctx.shadowBlur = 6
    }
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = highlight ? C.select : col
    ctx.lineWidth = highlight ? 1.5 : 1
    ctx.stroke()
    ctx.fillStyle = highlight ? C.select : col
    ctx.fillText(text, x, y)
    ctx.restore()
  }

  /** 两直线交点 (角度标注用); 平行返回 null */
  const lineIntersect = (a1: Point2D, b1: Point2D, a2: Point2D, b2: Point2D): Point2D | null => {
    const d1x = b1.x - a1.x, d1y = b1.y - a1.y
    const d2x = b2.x - a2.x, d2y = b2.y - a2.y
    const den = d1x * d2y - d1y * d2x
    if (Math.abs(den) < 1e-9) return null
    const t = ((a2.x - a1.x) * d2y - (a2.y - a1.y) * d2x) / den
    return { x: a1.x + t * d1x, y: a1.y + t * d1y }
  }

  /** 线性尺寸: 两端引出线 + 尺寸线 + 双向箭头 */
  const drawLinearDim = (ctx: CanvasRenderingContext2D, a: Point2D, b: Point2D, labelPos: Point2D, cam: Camera, col: string) => {
    const dx = b.x - a.x, dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return
    const ux = dx / len, uy = dy / len
    const nx = -uy, ny = ux
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const proj = (labelPos.x - mid.x) * nx + (labelPos.y - mid.y) * ny
    const s = proj >= 0 ? 1 : -1
    const off = Math.max(14, Math.abs(proj))
    const a2 = { x: a.x + nx * off * s, y: a.y + ny * off * s }
    const b2 = { x: b.x + nx * off * s, y: b.y + ny * off * s }
    const A2 = { x: sx(a2, cam), y: sy(a2, cam) }
    const B2 = { x: sx(b2, cam), y: sy(b2, cam) }
    ctx.save()
    ctx.strokeStyle = col
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.55
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(sx(a, cam), sy(a, cam)); ctx.lineTo(A2.x, A2.y)
    ctx.moveTo(sx(b, cam), sy(b, cam)); ctx.lineTo(B2.x, B2.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.moveTo(A2.x, A2.y); ctx.lineTo(B2.x, B2.y)
    ctx.stroke()
    ctx.restore()
    // 双箭头: 尖端指向被测端点
    drawArrowHead(ctx, A2, Math.atan2(A2.y - B2.y, A2.x - B2.x), 7, col)
    drawArrowHead(ctx, B2, Math.atan2(B2.y - A2.y, B2.x - A2.x), 7, col)
  }

  /** 绘制约束 (尺寸标注): 带箭头与底框数字, 悬停/选中高亮 */
  const drawConstraint = (ctx: CanvasRenderingContext2D, c: Contour, cons: Constraint, cam: Camera) => {
    const labelPos = cons.labelPos
    if (!labelPos) return
    const lx = sx(labelPos, cam)
    const ly = sy(labelPos, cam)
    const highlight = selectedConstraintId === cons.id || hoverConstraintId === cons.id
    const col = highlight ? C.select : (!cons.driving ? '#8b93a3' : (['length', 'angle', 'diameter', 'radius', 'arcLength', 'distance'].includes(cons.type) ? C.dim : C.geom))
    const n = c.points.length

    if (cons.type === 'length' && cons.edgeIndex !== undefined) {
      drawLinearDim(ctx, c.points[cons.edgeIndex % n], c.points[(cons.edgeIndex + 1) % n], labelPos, cam, col)
    } else if (cons.type === 'distance' && cons.vertexIdx1 !== undefined && cons.vertexIdx2 !== undefined) {
      const c2 = cons.contourId2 ? (findContourById(cons.contourId2) ?? c) : c
      const resolveP = (contour: Contour, idx: number): Point2D => {
        if (idx === -3) return { x: 0, y: 0 }
        if (idx === -2) return contourCenter(contour) ?? contour.points[0]
        return contour.points[idx]
      }
      drawLinearDim(ctx, resolveP(c, cons.vertexIdx1), resolveP(c2, cons.vertexIdx2), labelPos, cam, col)
    } else if (cons.type === 'distance' && cons.edgeIndex !== undefined && cons.edgeIndex2 !== undefined) {
      // 平行边间距: 垂直尺寸线 + 双箭头 + 引出线
      const a1 = c.points[cons.edgeIndex % n], b1 = c.points[(cons.edgeIndex + 1) % n]
      const c2 = cons.contourId2 ? (findContourById(cons.contourId2) ?? c) : c
      const a2 = c2.points[cons.edgeIndex2 % c2.points.length], b2 = c2.points[(cons.edgeIndex2 + 1) % c2.points.length]
      const dx = b1.x - a1.x, dy = b1.y - a1.y
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len, ny = dx / len
      const ux = dx / len, uy = dy / len
      // 统一沿边坐标 + 第一条边法向：即使两边长度、起点和中点完全不同，尺寸线也保持正交。
      const t = (labelPos.x - a1.x) * ux + (labelPos.y - a1.y) * uy
      const p1 = { x: a1.x + ux * t, y: a1.y + uy * t }
      const gap = (a2.x - a1.x) * nx + (a2.y - a1.y) * ny
      const p2 = { x: p1.x + nx * gap, y: p1.y + ny * gap }
      const P1 = { x: sx(p1, cam), y: sy(p1, cam) }
      const P2 = { x: sx(p2, cam), y: sy(p2, cam) }
      const closestOnSegment = (p: Point2D, a: Point2D, b: Point2D): Point2D => {
        const vx = b.x - a.x, vy = b.y - a.y
        const ll = vx * vx + vy * vy
        const tt = ll < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / ll))
        return { x: a.x + vx * tt, y: a.y + vy * tt }
      }
      const e1 = closestOnSegment(p1, a1, b1)
      const e2 = closestOnSegment(p2, a2, b2)
      ctx.save()
      ctx.strokeStyle = col
      ctx.lineWidth = 1
      // 当尺寸线被拖到有限边段之外，用虚线尺寸界线明确指出它引用的是哪两条边。
      ctx.globalAlpha = 0.55
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      if (Math.hypot(e1.x - p1.x, e1.y - p1.y) > 0.25) {
        ctx.moveTo(sx(e1, cam), sy(e1, cam)); ctx.lineTo(P1.x, P1.y)
      }
      if (Math.hypot(e2.x - p2.x, e2.y - p2.y) > 0.25) {
        ctx.moveTo(sx(e2, cam), sy(e2, cam)); ctx.lineTo(P2.x, P2.y)
      }
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.moveTo(P1.x, P1.y); ctx.lineTo(P2.x, P2.y)
      ctx.stroke()
      ctx.restore()
      drawArrowHead(ctx, P1, Math.atan2(P1.y - P2.y, P1.x - P2.x), 7, col)
      drawArrowHead(ctx, P2, Math.atan2(P2.y - P1.y, P2.x - P1.x), 7, col)
    } else if (cons.type === 'distance' && cons.edgeIndex !== undefined && cons.vertexIdx1 !== undefined && cons.vertexIdx2 === undefined) {
      // 点-线距离: 顶点 → 边垂足, 双箭头
      const a = c.points[cons.edgeIndex % n], b = c.points[(cons.edgeIndex + 1) % n]
      const c2 = cons.contourId2 ? (findContourById(cons.contourId2) ?? c) : c
      const v = cons.vertexIdx1 === -2 ? contourCenter(c2) : c2.points[cons.vertexIdx1]
      if (!v) return
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.hypot(dx, dy)
      if (len > 1e-6) {
        const ux = dx / len, uy = dy / len
        const proj = (v.x - a.x) * ux + (v.y - a.y) * uy
        const q = { x: a.x + ux * proj, y: a.y + uy * proj }
        const V = { x: sx(v, cam), y: sy(v, cam) }
        const Q = { x: sx(q, cam), y: sy(q, cam) }
        ctx.save()
        ctx.strokeStyle = col
        ctx.lineWidth = 1
        // 垂足在有限边之外时，补上虚线延长线，避免尺寸箭头悬空。
        const segT = Math.max(0, Math.min(len, proj))
        const qe = { x: a.x + ux * segT, y: a.y + uy * segT }
        if (Math.hypot(qe.x - q.x, qe.y - q.y) > 0.25) {
          ctx.globalAlpha = 0.55
          ctx.setLineDash([4, 4])
          ctx.beginPath()
          ctx.moveTo(sx(qe, cam), sy(qe, cam))
          ctx.lineTo(Q.x, Q.y)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1
        }
        ctx.beginPath()
        ctx.moveTo(V.x, V.y)
        ctx.lineTo(Q.x, Q.y)
        ctx.stroke()
        ctx.restore()
        const angVQ = Math.atan2(Q.y - V.y, Q.x - V.x)
        drawArrowHead(ctx, V, angVQ, 7, col)
        drawArrowHead(ctx, Q, angVQ + Math.PI, 7, col)
      }
    } else if (cons.type === 'arcLength') {
        // 弧长: 沿弧线绘制尺寸弧 + 数字
        const arc = standaloneArc(c) ?? (cons.edgeIndex !== undefined ? edgeArc(c, cons.edgeIndex) : null)
        if (arc) {
          const a1 = Math.atan2(c.points[arc.p1].y - arc.center.y, c.points[arc.p1].x - arc.center.x)
          const a2 = Math.atan2(c.points[arc.p2].y - arc.center.y, c.points[arc.p2].x - arc.center.x)
          ctx.save()
          ctx.strokeStyle = col
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(sx(arc.center, cam), sy(arc.center, cam), arc.radius * cam.scale, a1, a2, arc.sweep === 'cw')
          ctx.stroke()
          ctx.restore()
        }
      } else if (cons.type === 'radius') {
      // 圆心 → 圆周 箭头 + R
      const center = c.center ?? standaloneArc(c)?.center
      if (center) {
        const r = c.radius ?? standaloneArc(c)?.radius
        if (r) {
          const ang = Math.atan2(labelPos.y - center.y, labelPos.x - center.x)
          const q = { x: center.x + r * Math.cos(ang), y: center.y + r * Math.sin(ang) }
          ctx.save()
          ctx.strokeStyle = col
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(sx(center, cam), sy(center, cam))
          ctx.lineTo(sx(q, cam), sy(q, cam))
          ctx.stroke()
          ctx.restore()
          drawArrowHead(ctx, { x: sx(q, cam), y: sy(q, cam) }, ang, 7, col)
        }
      }
    } else if (cons.type === 'diameter') {
      // 直径: 贯穿圆心的尺寸线 + 双箭头
      const center = c.center
      const r = c.radius
      if (center && r) {
        const ang = Math.atan2(labelPos.y - center.y, labelPos.x - center.x)
        const q1 = { x: center.x - r * Math.cos(ang), y: center.y - r * Math.sin(ang) }
        const q2 = { x: center.x + r * Math.cos(ang), y: center.y + r * Math.sin(ang) }
        ctx.save()
        ctx.strokeStyle = col
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(sx(q1, cam), sy(q1, cam))
        ctx.lineTo(sx(q2, cam), sy(q2, cam))
        ctx.stroke()
        ctx.restore()
        drawArrowHead(ctx, { x: sx(q1, cam), y: sy(q1, cam) }, ang + Math.PI, 7, col)
        drawArrowHead(ctx, { x: sx(q2, cam), y: sy(q2, cam) }, ang, 7, col)
      }
    } else if (cons.type === 'angle' && cons.edgeIndex !== undefined && cons.edgeIndex2 !== undefined) {
      // 角度: 交点处圆弧 + 切向双箭头
      const a1 = c.points[cons.edgeIndex % n], b1 = c.points[(cons.edgeIndex + 1) % n]
      const c2 = cons.contourId2 ? (findContourById(cons.contourId2) ?? c) : c
        const n2 = c2.points.length
        const a2 = c2.points[cons.edgeIndex2 % n2], b2 = c2.points[(cons.edgeIndex2 + 1) % n2]
      const I = lineIntersect(a1, b1, a2, b2)
      if (I) {
        const ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x)
        const ang2 = Math.atan2(b2.y - a2.y, b2.x - a2.x)
        const span = normAngle(ang2 - ang1)
        const labAng = Math.atan2(labelPos.y - I.y, labelPos.x - I.x)
        const mid1 = ang1 + span / 2
        const mid2 = ang2 + normAngle(ang1 - ang2) / 2
        const ccw = Math.abs(normAngle(labAng - mid1)) <= Math.abs(normAngle(labAng - mid2))
        const start = ccw ? ang1 : ang2
        const end = ccw ? ang1 + span : ang2 - span
        // 弧半径随标注距离 (放置时鼠标拖动决定)
        const R = Math.max(22, Math.min(240, Math.hypot(labelPos.x - I.x, labelPos.y - I.y)))
        const cx = sx(I, cam), cy = sy(I, cam)
        const rr = R * cam.scale
        ctx.save()
        ctx.strokeStyle = col
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(cx, cy, rr, start, end, ccw)
        ctx.stroke()
        ctx.restore()
        if (ccw) {
          drawArrowHead(ctx, { x: cx + rr * Math.cos(start), y: cy + rr * Math.sin(start) }, start - Math.PI / 2, 7, col)
          drawArrowHead(ctx, { x: cx + rr * Math.cos(end), y: cy + rr * Math.sin(end) }, end + Math.PI / 2, 7, col)
        } else {
          drawArrowHead(ctx, { x: cx + rr * Math.cos(start), y: cy + rr * Math.sin(start) }, start + Math.PI / 2, 7, col)
          drawArrowHead(ctx, { x: cx + rr * Math.cos(end), y: cy + rr * Math.sin(end) }, end - Math.PI / 2, 7, col)
        }
      }
    }
    boxedLabel(ctx, cons.label, lx, ly, col, highlight)
  }

  /** 吸附高亮: 金色圆环 + 十字 + 标签 */
  const drawSnap = (ctx: CanvasRenderingContext2D, p: Point2D, label: string, cam: Camera) => {
    const cx = sx(p, cam), cy = sy(p, cam)
    ctx.strokeStyle = C.snap
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(cx, cy, 9, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 5, cy)
    ctx.moveTo(cx + 5, cy); ctx.lineTo(cx + 12, cy)
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 5)
    ctx.moveTo(cx, cy + 5); ctx.lineTo(cx, cy + 12)
    ctx.stroke()
    if (label) {
      ctx.font = '11px sans-serif'
      const w = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(35,38,46,0.92)'
      ctx.fillRect(cx - w / 2 - 4, cy + 12, w + 8, 15)
      ctx.fillStyle = C.snap
      ctx.fillText(label, cx - w / 2, cy + 23)
    }
  }

  /** 绘制实时预览 */
  const drawPreview = (ctx: CanvasRenderingContext2D, pv: SketchPreview, cam: Camera) => {
    // 悬停预览: 顶点/圆心吸附高亮 (选择/智能尺寸/绘图工具落点前) + 边微高亮
    if (pv.kind === 'hover') {
      const c = pv.hoverContourId ? findContourById(pv.hoverContourId) : undefined
      if (c && pv.hoverEdgeIdx !== undefined) {
        if (pv.hoverWhole) {
          // 整轮廓高亮 (等距实体选型)
          if (c.shape === 'circle' && c.center && c.radius) {
            ctx.strokeStyle = 'rgba(62,198,176,0.6)'
            ctx.lineWidth = 2.5
            ctx.beginPath()
            ctx.arc(sx(c.center, cam), sy(c.center, cam), c.radius * cam.scale, 0, Math.PI * 2)
            ctx.stroke()
          } else if (c.slotWidth !== undefined && c.points.length >= 2) {
            drawSlotShape(ctx, c.points[0], c.points[1], c.slotWidth, cam, 'rgba(62,198,176,0.6)', true)
          } else {
            drawPath(ctx, c.points, c.closed, c.arcs, cam, 'rgba(62,198,176,0.6)', true)
          }
        } else {
          drawEdgeHighlight(ctx, c, pv.hoverEdgeIdx, cam, 'rgba(62,198,176,0.5)')
        }
      }
      if (pv.snapPos) drawSnap(ctx, pv.snapPos, pv.snapLabel ?? '', cam)
      return
    }

    // 等距实体: 源轮廓金色高亮 + 实时偏移预览 + 距离数值
    if (pv.kind === 'offsetPreview') {
      const src = pv.offsetContourId ? findContourById(pv.offsetContourId) : undefined
      if (src) {
        if (src.shape === 'circle' && src.center && src.radius) {
          ctx.strokeStyle = C.select
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(sx(src.center, cam), sy(src.center, cam), src.radius * cam.scale, 0, Math.PI * 2)
          ctx.stroke()
        } else if (src.slotWidth !== undefined && src.points.length >= 2) {
          drawSlotShape(ctx, src.points[0], src.points[1], src.slotWidth, cam, C.select, true)
        } else {
          drawPath(ctx, src.points, src.closed, src.arcs, cam, C.select, true)
        }
      }
      const shp = pv.offsetPreview
      if (shp) {
        ctx.save()
        ctx.strokeStyle = C.accent
        ctx.lineWidth = 1.5
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        if (shp.kind === 'circle' && shp.center && shp.r !== undefined) {
          ctx.arc(sx(shp.center, cam), sy(shp.center, cam), shp.r * cam.scale, 0, Math.PI * 2)
        } else if (shp.kind === 'slot' && shp.p1 && shp.p2 && shp.w !== undefined) {
          drawSlotShape(ctx, shp.p1, shp.p2, shp.w, cam, C.accent, false)
        } else if (shp.kind === 'arc' && shp.center && shp.r !== undefined && shp.pts && shp.pts.length >= 2) {
          const a1 = Math.atan2(shp.pts[0].y - shp.center.y, shp.pts[0].x - shp.center.x)
          const a2 = Math.atan2(shp.pts[1].y - shp.center.y, shp.pts[1].x - shp.center.x)
          ctx.arc(sx(shp.center, cam), sy(shp.center, cam), shp.r * cam.scale, a1, a2, shp.sweep === 'cw')
        } else if (shp.kind === 'poly' && shp.points) {
          shp.points.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p, cam), sy(p, cam)) : ctx.lineTo(sx(p, cam), sy(p, cam))))
          ctx.closePath()
        }
        ctx.stroke()
        ctx.restore()
      }
      // 实时偏移量
      if (pv.offsetDist !== undefined) {
        const dMM = pv.offsetDist * pixelToMM
        ctx.font = '11px sans-serif'
        const label = `偏移 ${Math.abs(dMM).toFixed(1)} mm`
        const tx = sx(pv.current, cam) + 12, ty = sy(pv.current, cam) - 12
        ctx.fillStyle = 'rgba(35,38,46,0.92)'
        const tw = ctx.measureText(label).width
        ctx.fillRect(tx - 3, ty - 11, tw + 6, 15)
        ctx.fillStyle = C.accent
        ctx.fillText(label, tx, ty + 1)
      }
      return
    }

    // 智能尺寸放置预览: 复用约束渲染 (箭头+底框数字), 标注位置随鼠标拖拽
    if (pv.kind === 'dimPlace') {
      const c = pv.dimContourId ? findContourById(pv.dimContourId) : undefined
      if (c && pv.dimCons) {
        ctx.save()
        drawConstraint(ctx, c, pv.dimCons, cam)
        ctx.restore()
      }
      return
    }

    // 点擦除悬停高亮
    if (pv.kind === 'eraserHover') {
      const c = pv.hoverContourId ? findContourById(pv.hoverContourId) : undefined
      if (c && pv.hoverEdgeIdx !== undefined) {
        drawEdgeHighlight(ctx, c, pv.hoverEdgeIdx, cam, C.erase, pv.hoverT1 ?? 0, pv.hoverT2 ?? 1)
      }
      return
    }

    // 快速擦除: 橡皮线 + 已标记边红色高亮
    if (pv.kind === 'eraserSweep') {
      const hits = pv.sweepHits ?? []
      for (const h of hits) {
        const c = findContourById(h.contourId)
        if (c) drawEdgeHighlight(ctx, c, h.edgeIdx, cam)
      }
      // 自由曲线轨迹 (按真实鼠标路径)
      if (pv.points.length > 1) {
        ctx.save()
        ctx.strokeStyle = C.erase
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        pv.points.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p, cam), sy(p, cam)) : ctx.lineTo(sx(p, cam), sy(p, cam))))
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(sx(pv.current, cam), sy(pv.current, cam), 6, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
      return
    }

    // 拖动预览: 按新点集重画轮廓 + 拖动点高亮
    if (pv.kind === 'drag') {
      const c = pv.contourId ? findContourById(pv.contourId) : undefined
      if (!c) return
      if (c.shape === 'circle' && pv.radius !== undefined && pv.center) {
        ctx.strokeStyle = C.select
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(sx(pv.center, cam), sy(pv.center, cam), pv.radius * cam.scale, 0, Math.PI * 2)
        ctx.stroke()
        drawCenterMark(ctx, pv.center, cam, C.select)
        if (pv.guides?.length) drawGuides(ctx, pv.guides, cam)
        if (pv.snapPos) drawSnap(ctx, pv.snapPos, pv.snapLabel ?? '', cam)
        return
      }
      if (c.slotWidth !== undefined && pv.points.length >= 2) {
        drawSlotShape(ctx, pv.points[0], pv.points[1], c.slotWidth, cam, C.select, true)
        if (pv.guides?.length) drawGuides(ctx, pv.guides, cam)
        if (pv.snapPos) drawSnap(ctx, pv.snapPos, pv.snapLabel ?? '', cam)
        return
      }
      drawPath(ctx, pv.points, c.closed, pv.arcs ?? c.arcs, cam, C.select, true)
      if (pv.dragIdx !== undefined && pv.points[pv.dragIdx]) {
        const p = pv.points[pv.dragIdx]
        ctx.fillStyle = C.select
        ctx.beginPath()
        ctx.arc(sx(p, cam), sy(p, cam), 5, 0, Math.PI * 2)
        ctx.fill()
      }
      if (pv.guides?.length) drawGuides(ctx, pv.guides, cam)
      if (pv.snapPos) drawSnap(ctx, pv.snapPos, pv.snapLabel ?? '', cam)
      return
    }

    ctx.save()
    ctx.strokeStyle = 'rgba(62,198,176,0.9)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    if (pv.kind === 'pen') {
      const pts = pv.points
      // 已确认线段: 实线 + 端点圆点 (画线即实线, 不等到闭合)
      if (pts.length) {
        ctx.save()
        ctx.setLineDash([])
        ctx.strokeStyle = 'rgba(62,198,176,0.95)'
        ctx.lineWidth = 2
        ctx.beginPath()
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p, cam), sy(p, cam)) : ctx.lineTo(sx(p, cam), sy(p, cam))))
        ctx.stroke()
        ctx.fillStyle = C.accent
        for (const p of pts) {
          ctx.beginPath()
          ctx.arc(sx(p, cam), sy(p, cam), 3, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }
      // 最后一段橡皮筋: 虚线
      ctx.beginPath()
      if (pts.length) {
        ctx.moveTo(sx(pts[pts.length - 1], cam), sy(pts[pts.length - 1], cam))
        ctx.lineTo(sx(pv.current, cam), sy(pv.current, cam))
      }
    } else if (pv.kind === 'rect') {
      const p1 = pv.points[0], p2 = pv.current
      ctx.rect(Math.min(sx(p1, cam), sx(p2, cam)), Math.min(sy(p1, cam), sy(p2, cam)), Math.abs(sx(p2, cam) - sx(p1, cam)), Math.abs(sy(p2, cam) - sy(p1, cam)))
    } else if (pv.kind === 'rectCenter') {
      const c0 = pv.points[0], cur = pv.current
      const hw = Math.abs(cur.x - c0.x), hh = Math.abs(cur.y - c0.y)
      ctx.rect(sx({ x: c0.x - hw, y: c0.y - hh }, cam), sy({ x: c0.x - hw, y: c0.y - hh }, cam), hw * 2 * cam.scale, hh * 2 * cam.scale)
      ctx.moveTo(sx(c0, cam), sy(c0, cam) - 4)
      ctx.lineTo(sx(c0, cam), sy(c0, cam) + 4)
    } else if (pv.kind === 'rect3pt') {
      if (pv.points.length >= 2) {
        const p1 = pv.points[0], p2 = pv.points[1], cur = pv.current
        const dx = p2.x - p1.x, dy = p2.y - p1.y
        const len = Math.hypot(dx, dy)
        if (len > 1e-6) {
          const nx = -dy / len, ny = dx / len
          const w = (cur.x - p1.x) * nx + (cur.y - p1.y) * ny
          const p3 = { x: p2.x + nx * w, y: p2.y + ny * w }
          const p4 = { x: p1.x + nx * w, y: p1.y + ny * w }
          ctx.moveTo(sx(p1, cam), sy(p1, cam))
          ctx.lineTo(sx(p2, cam), sy(p2, cam))
          ctx.lineTo(sx(p3, cam), sy(p3, cam))
          ctx.lineTo(sx(p4, cam), sy(p4, cam))
          ctx.closePath()
          ctx.stroke()
          ctx.setLineDash([])
          ctx.font = '11px sans-serif'
          const label = `宽 ${(w * pixelToMM).toFixed(1)} mm`
          ctx.fillStyle = 'rgba(35,38,46,0.92)'
          const tw = ctx.measureText(label).width
          ctx.fillRect(sx(cur, cam) + 10, sy(cur, cam) - 20, tw + 8, 16)
          ctx.fillStyle = C.accent
          ctx.fillText(label, sx(cur, cam) + 14, sy(cur, cam) - 8)
        }
      }
    } else if (pv.kind === 'circle') {
      const cc = pv.points[0]
      const r = Math.hypot(pv.current.x - cc.x, pv.current.y - cc.y)
      // 半径虚线
      ctx.moveTo(sx(cc, cam), sy(cc, cam))
      ctx.lineTo(sx(pv.current, cam), sy(pv.current, cam))
      // 圆
      ctx.arc(sx(cc, cam), sy(cc, cam), r * cam.scale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      drawCenterMark(ctx, cc, cam, C.accent)
      // 实时半径数值
      const rMM = r * pixelToMM
      ctx.font = '12px sans-serif'
      const label = `R ${rMM.toFixed(1)} mm`
      const mx = (sx(cc, cam) + sx(pv.current, cam)) / 2
      const my = (sy(cc, cam) + sy(pv.current, cam)) / 2
      ctx.fillStyle = 'rgba(35,38,46,0.92)'
      const tw = ctx.measureText(label).width
      ctx.fillRect(mx - tw / 2 - 4, my - 18, tw + 8, 16)
      ctx.fillStyle = C.accent
      ctx.fillText(label, mx - tw / 2, my - 6)
    } else if (pv.kind === 'circle3pt') {
      if (pv.points.length >= 2) {
        const p1 = pv.points[0], p2 = pv.points[1], cur = pv.current
        const cc = circumcenter(p1, p2, cur)
        if (cc) {
          ctx.arc(sx(cc.center, cam), sy(cc.center, cam), cc.radius * cam.scale, 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])
          drawCenterMark(ctx, cc.center, cam, C.accent)
          const rMM = cc.radius * pixelToMM
          ctx.font = '12px sans-serif'
          const label = `R ${rMM.toFixed(1)} mm`
          const mx = (sx(cc.center, cam) + sx(cur, cam)) / 2
          const my = (sy(cc.center, cam) + sy(cur, cam)) / 2
          ctx.fillStyle = 'rgba(35,38,46,0.92)'
          const tw = ctx.measureText(label).width
          ctx.fillRect(mx - tw / 2 - 4, my - 18, tw + 8, 16)
          ctx.fillStyle = C.accent
          ctx.fillText(label, mx - tw / 2, my - 6)
        }
      }
    } else if (pv.kind === 'polygon') {
      const cc = pv.points[0]
      const sides = pv.polygonSides ?? 6
      const circumscribed = pv.polygonCircumscribed ?? false
      const r = Math.hypot(pv.current.x - cc.x, pv.current.y - cc.y)
      // 参考圆 (内切圆/外接圆)
      ctx.arc(sx(cc, cam), sy(cc, cam), r * cam.scale, 0, Math.PI * 2)
      const rOut = circumscribed ? r / Math.cos(Math.PI / sides) : r
      const a0 = Math.atan2(pv.current.y - cc.y, pv.current.x - cc.x)
      for (let i = 0; i < sides; i++) {
        const a = a0 + (2 * Math.PI * i) / sides
        const px = sx({ x: cc.x + rOut * Math.cos(a), y: cc.y + rOut * Math.sin(a) }, cam)
        const py = sy({ x: cc.x + rOut * Math.cos(a), y: cc.y + rOut * Math.sin(a) }, cam)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.stroke()
      ctx.setLineDash([])
      drawCenterMark(ctx, cc, cam, C.accent)
      // 实时参考半径 + 边长
      ctx.font = '11px sans-serif'
      const rMM = r * pixelToMM
      const sideMM = 2 * rOut * Math.sin(Math.PI / sides) * pixelToMM
      const modeLabel = circumscribed ? '外切' : '内切'
      const rot = Math.round(((a0 * 180 / Math.PI) % 360 + 360) % 360)
      const label = `${sides}边 · ${modeLabel}R ${rMM.toFixed(1)} mm · 边长 ${sideMM.toFixed(1)} mm · 旋转 ${rot}°`
      ctx.fillStyle = 'rgba(35,38,46,0.92)'
      const tw = ctx.measureText(label).width
      ctx.fillRect(sx(cc, cam) + 8, sy(cc, cam) - 24, tw + 8, 16)
      ctx.fillStyle = C.accent
      ctx.fillText(label, sx(cc, cam) + 12, sy(cc, cam) - 12)
    } else if (pv.kind === 'slot') {
      if (pv.points.length === 1) {
        ctx.moveTo(sx(pv.points[0], cam), sy(pv.points[0], cam))
        ctx.lineTo(sx(pv.current, cam), sy(pv.current, cam))
        ctx.stroke()
      } else if (pv.points.length >= 2) {
        const p1 = pv.points[0], p2 = pv.points[1]
        // 实时宽度 = 鼠标到中心线距离 × 2
        const w = Math.max(1, 2 * ptSegDist(pv.current, p1, p2))
        // 中心线
        ctx.moveTo(sx(p1, cam), sy(p1, cam))
        ctx.lineTo(sx(p2, cam), sy(p2, cam))
        drawSlotShape(ctx, p1, p2, w, cam, 'rgba(62,198,176,0.9)', false)
        // R 数值
        const rMM = (w / 2) * pixelToMM
        ctx.font = '11px sans-serif'
        const label = `R ${rMM.toFixed(1)}`
        ctx.fillStyle = 'rgba(35,38,46,0.92)'
        const tw = ctx.measureText(label).width
        const tx = sx(pv.current, cam) + 10, ty = sy(pv.current, cam) - 8
        ctx.fillRect(tx - 3, ty - 11, tw + 6, 15)
        ctx.fillStyle = C.accent
        ctx.fillText(label, tx, ty + 1)
        ctx.stroke()
      }
      ctx.setLineDash([])
    } else if (pv.kind === 'arcCenter') {
      if (pv.points.length < 2) { ctx.restore(); return }
      const cc = pv.points[0], st = pv.points[1], cur = pv.current
      const r = Math.hypot(st.x - cc.x, st.y - cc.y)
      if (r < 0.001) { ctx.restore(); return }
      const a1 = Math.atan2(st.y - cc.y, st.x - cc.x)
      const a2 = Math.atan2(cur.y - cc.y, cur.x - cc.x)
      const endP = { x: cc.x + r * Math.cos(a2), y: cc.y + r * Math.sin(a2) }
      ctx.moveTo(sx(cc, cam), sy(cc, cam))
      ctx.lineTo(sx(endP, cam), sy(endP, cam))
      ctx.arc(sx(cc, cam), sy(cc, cam), r * cam.scale, a1, a2, false)
    } else if (pv.kind === 'arc3pt') {
      if (pv.points.length < 2) { ctx.restore(); return }
      const p1 = pv.points[0], p2 = pv.points[1], cur = pv.current
      const cc = circumcenter(p1, p2, cur)
      if (!cc) {
        ctx.moveTo(sx(p1, cam), sy(p1, cam))
        ctx.lineTo(sx(p2, cam), sy(p2, cam))
      } else {
        const a1 = Math.atan2(p1.y - cc.center.y, p1.x - cc.center.x)
        const a2 = Math.atan2(p2.y - cc.center.y, p2.x - cc.center.x)
        const a3 = Math.atan2(cur.y - cc.center.y, cur.x - cc.center.x)
        const anti = normAngle(a3 - a1) > normAngle(a2 - a1)
        ctx.arc(sx(cc.center, cam), sy(cc.center, cam), cc.radius * cam.scale, a1, a2, anti)
      }
    }
    ctx.stroke()
    ctx.setLineDash([])

    // 推理参考线 (对齐引导)
    if (pv.guides?.length) {
      drawGuides(ctx, pv.guides, cam)
    }

    // 吸附点高亮
    if (pv.snapPos) {
      drawSnap(ctx, pv.snapPos, pv.snapLabel ?? '', cam)
    }
    ctx.restore()
  }

  // 世界坐标 ↔ 屏幕坐标
  const toWorld = (e: React.MouseEvent): Point2D => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - camera.offsetX) / camera.scale,
      y: (e.clientY - rect.top - camera.offsetY) / camera.scale,
    }
  }

  /** 以固定屏幕容差命中板内候选孔；板边结构缺口不可切换。 */
  const findEdgeHoleAt = (world: Point2D) => {
    if (!splitResult || splitResult.panels.length === 0 || pixelToMM <= 0) return null
    const mm = { x: world.x * pixelToMM, y: -world.y * pixelToMM }
    const toleranceMM = splitCfg.jointDiameter / 2 + (7 * pixelToMM) / Math.max(camera.scale, 0.1)
    let best: { panelId: string; panelX: number; panelY: number; holeX: number; holeY: number } | null = null
    let bestD = toleranceMM
    for (const panel of splitResult.panels) {
      for (const hole of panel.edge_holes) {
        const onBoundary = Math.abs(hole.x - panel.x) < 0.5 || Math.abs(hole.x - (panel.x + panel.w)) < 0.5 ||
          Math.abs(hole.y - panel.y) < 0.5 || Math.abs(hole.y - (panel.y + panel.h)) < 0.5
        if (onBoundary) continue
        const d = Math.hypot(mm.x - hole.x, mm.y - hole.y)
        if (d <= bestD) {
          bestD = d
          best = { panelId: panel.id, panelX: panel.x, panelY: panel.y, holeX: hole.x, holeY: hole.y }
        }
      }
    }
    return best
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      // 左键 = 纯绘图/选择/擦除 (不做任何平移, 避免与绘图冲突)
      const world = toWorld(e)
      const edgeHole = findEdgeHoleAt(world)
      if (edgeHole) {
        pendingEdgeHoleRef.current = edgeHole
        return
      }
      pendingEdgeHoleRef.current = null
      onCanvasMouseDown?.(world)
      const onUp = () => {
        onCanvasMouseUp?.()
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mouseup', onUp)
    } else if (e.button === 1) {
      // 中键拖动 = 平移视图 (恢复原行为; 轮盘改由长按 Alt 呼出)
      e.preventDefault() // 阻止中键自动滚动/粘贴
      const start = { x: e.clientX, y: e.clientY }
      const startCam = camera
      const onMove = (ev: MouseEvent) => {
        setCamera({
          ...startCam,
          offsetX: startCam.offsetX + (ev.clientX - start.x),
          offsetY: startCam.offsetY + (ev.clientY - start.y),
        })
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
    // 中键短按: 什么都不做 (平移已交给上面; 轮盘走 Alt 长按)
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    const newScale = Math.max(0.1, Math.min(10, camera.scale * factor))
    setCamera({
      scale: newScale,
      offsetX: mx - (mx - camera.offsetX) * (newScale / camera.scale),
      offsetY: my - (my - camera.offsetY) * (newScale / camera.scale),
    })
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', cursor: hoverConstraintId || hoverEdgeHole ? 'pointer' : 'crosshair', background: C.bg }}
        onMouseDown={handleMouseDown}
        onMouseMove={e => {
          const world = toWorld(e)
          setHoverEdgeHole(!!findEdgeHoleAt(world))
          onCanvasMove?.(world)
        }}
        onMouseLeave={() => setHoverEdgeHole(false)}
        onClick={e => {
          const target = pendingEdgeHoleRef.current
          pendingEdgeHoleRef.current = null
          if (target) {
            if (e.detail === 1) {
              toggleEdgeHole(target.panelId, target.panelX, target.panelY, target.holeX, target.holeY)
              playHoleTapSound()
            }
            return
          }
          onCanvasClick?.(toWorld(e))
        }}
        onWheel={handleWheel}
        onDoubleClick={e => {
          if (!findEdgeHoleAt(toWorld(e))) onCanvasDoubleClick?.(toWorld(e))
        }}
      />
    </div>
  )
}
