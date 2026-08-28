// ============ 草图绘制命令 — 所有绘图操作 ============
import { useAppStore } from '../store/useAppStore'
import type { Command } from './Command'
import type { ArcEntity, Constraint, Contour, Point2D, SketchFeature } from '../types/geometry'
import { remapArcEntity } from '../utils/entities'
import { getCircleArcSegments, type CircleArcSegment } from '../utils/arc'
import { trimClosedEdgeRange, trimOpenEdgeRange, type TrimmedPath } from '../utils/sketchTrim'

let _idCounter = 0

/** 深拷贝轮廓 (撤销/重做安全) */
function cloneContour(c: Contour): Contour {
  return {
    ...c,
    points: c.points.map(p => ({ ...p })),
    center: c.center ? { ...c.center } : undefined,
    arcs: c.arcs?.map(a => ({ ...a, center: { ...a.center } })),
    constraints: c.constraints.map(x => ({ ...x, labelPos: { ...x.labelPos } })),
  }
}

const nextId = (prefix: string) => `${prefix}${++_idCounter}`

interface TrimContourState {
  points: Point2D[]
  closed: boolean
  constraints: Constraint[]
  arcs: ArcEntity[]
  originAnchorIdx?: number
}

/** 把未被修剪的约束/圆弧映射到新的点、边索引；跨轮廓约束保守丢弃，避免留下悬空引用。 */
function stateFromTrimmedPath(c: Contour, path: TrimmedPath): TrimContourState {
  const remapVertex = (idx: number | undefined): number | undefined => {
    if (idx === undefined || idx < 0) return idx
    return path.oldVertexMap.get(idx)
  }
  const remapEdge = (idx: number | undefined): number | undefined => {
    if (idx === undefined) return undefined
    return path.oldEdgeMap.get(idx)
  }
  const constraints: Constraint[] = []
  for (const cons of c.constraints) {
    if (cons.contourId2) continue
    const edgeIndex = remapEdge(cons.edgeIndex)
    const edgeIndex2 = remapEdge(cons.edgeIndex2)
    const vertexIdx1 = remapVertex(cons.vertexIdx1)
    const vertexIdx2 = remapVertex(cons.vertexIdx2)
    if ((cons.edgeIndex !== undefined && edgeIndex === undefined) ||
        (cons.edgeIndex2 !== undefined && edgeIndex2 === undefined) ||
        (cons.vertexIdx1 !== undefined && vertexIdx1 === undefined) ||
        (cons.vertexIdx2 !== undefined && vertexIdx2 === undefined)) continue
    constraints.push({ ...cons, edgeIndex, edgeIndex2, vertexIdx1, vertexIdx2 })
  }
  const arcs: ArcEntity[] = []
  for (const arc of c.arcs ?? []) {
    const mapped = remapArcEntity(arc, remapVertex)
    if (mapped) arcs.push(mapped)
  }
  const originAnchorIdx = c.originAnchorIdx === undefined
    ? undefined
    : path.oldVertexMap.get(c.originAnchorIdx)
  return {
    points: path.points.map(p => ({ ...p })),
    closed: false,
    constraints,
    arcs,
    originAnchorIdx,
  }
}

/**
 * 创建轮廓命令
 * 用于: 矩形/圆形/多边形/画笔闭合/圆弧/等距结果
 */
export class CreateContourCommand implements Command {
  label = '创建轮廓'
  private contour: Contour
  private sketchId: string | null = null

  constructor(contour: Contour) {
    this.contour = contour
    // 普通折线在创建时若有顶点精确吸附原点，持久记录它；不能只靠“默认固定顶点0”。
    if (contour.originAnchorIdx === undefined && contour.shape === undefined && !contour.construction) {
      const idx = contour.points.findIndex(p => Math.hypot(p.x, p.y) <= 0.25)
      if (idx >= 0) contour.originAnchorIdx = idx
    }
  }

  execute(): void {
    const s = useAppStore.getState()
    // 如果没有激活的草图，创建一个
    if (!s.ui.activeSketchId) {
      const sketchId = nextId('sketch')
      const sketch = { id: sketchId, name: '草图 1', type: 'sketch' as const, plane: 'xy' as const, contours: [] }
      s.project.parts[0]?.features.push(sketch)
      this.sketchId = sketchId
      useAppStore.setState({ ui: { ...s.ui, activeSketchId: sketchId } })
    }
    // 添加到当前草图
    const sketch = s.project.parts[0]?.features.find(f => f.id === (this.sketchId ?? s.ui.activeSketchId))
    if (sketch && sketch.type === 'sketch') {
      sketch.contours.push(this.contour)
    }
  }

  undo(): void {
    const s = useAppStore.getState()
    const sketch = s.project.parts[0]?.features.find(f => f.id === (this.sketchId ?? s.ui.activeSketchId))
    if (sketch && sketch.type === 'sketch') {
      sketch.contours = sketch.contours.filter(c => c.id !== this.contour.id)
    }
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 修改轮廓顶点命令 (尺寸驱动后更新几何)
 * 可选 patch: 同时更新其他字段 (如圆的 radius/center、弧实体 arcs)
 */
export class UpdateContourPointsCommand implements Command {
  label = '更新轮廓顶点'
  private oldPoints: Point2D[]
  private newPoints: Point2D[]
  private contourId: string
  private patch: Partial<Contour> | null
  /** patch 前的旧值 (undo 时恢复) */
  private oldPatch: Partial<Contour> | null = null

  constructor(
    contourId: string,
    oldPoints: Point2D[],
    newPoints: Point2D[],
    patch?: Partial<Contour>,
  ) {
    this.contourId = contourId
    this.oldPoints = oldPoints.map(p => ({ ...p }))
    this.newPoints = newPoints.map(p => ({ ...p }))
    this.patch = patch ?? null
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  /** 深拷贝 patch 中的数组字段 (arcs), 保证 undo/redo 之间互不影响 */
  private clonePatchValue(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(x => ({ ...(x as object) }))
    if (typeof v === 'object' && v !== null) return { ...(v as object) }
    return v
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    // 首次执行时保存 patch 涉及字段的旧值
    if (this.patch && !this.oldPatch) {
      const old: Partial<Contour> = {}
      for (const k of Object.keys(this.patch) as (keyof Contour)[]) {
        const v = c[k]
        old[k] = this.clonePatchValue(v) as never
      }
      this.oldPatch = old
    }
    c.points = this.newPoints.map(p => ({ ...p }))
    if (this.patch) {
      const rec = c as unknown as Record<string, unknown>
      for (const k of Object.keys(this.patch) as (keyof Contour)[]) {
        rec[k] = this.clonePatchValue(this.patch[k])
      }
    }
  }

  undo(): void {
    const c = this.findContour()
    if (!c) return
    c.points = this.oldPoints.map(p => ({ ...p }))
    if (this.oldPatch) {
      const rec = c as unknown as Record<string, unknown>
      for (const k of Object.keys(this.oldPatch) as (keyof Contour)[]) {
        rec[k] = this.clonePatchValue(this.oldPatch[k])
      }
    }
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 合并开放轮廓命令 (擦除公共边后自动合并, 可撤销):
 * 把同一草图内若干条开放折线替换为一条闭合轮廓 (如两个矩形擦除公共边 → L 型)。
 * 合并结果保留源轮廓的 type/name, 约束置空 (修剪后边索引已失效, 重新标注);
 * 源轮廓从草图移除, 合并轮廓追加到草图末尾。
 */
export class MergeContoursCommand implements Command {
  label = '合并开放轮廓'
  private sketchId: string
  private groups: {
    mergedId: string
    removeIds: string[]
    type: 'outer' | 'inner'
    name: string
    points: Point2D[]
  }[]
  private before: Contour[] | null = null
  private after: Contour[] | null = null

  constructor(
    sketchId: string,
    groups: {
      mergedId: string
      removeIds: string[]
      type: 'outer' | 'inner'
      name: string
      points: Point2D[]
    }[],
  ) {
    this.sketchId = sketchId
    this.groups = groups
  }

  private findSketch(): SketchFeature | null {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      const f = part.features.find(x => x.id === this.sketchId)
      if (f?.type === 'sketch') return f
    }
    return null
  }

  private computeAfter(f: SketchFeature): Contour[] {
    const removeSet = new Set(this.groups.flatMap(g => g.removeIds))
    const kept = f.contours.filter(c => !removeSet.has(c.id))
    const merged: Contour[] = this.groups.map(g => ({
      id: g.mergedId,
      type: g.type,
      name: g.name,
      points: g.points.map(p => ({ ...p })),
      closed: true,
      constraints: [],
      arcs: [],
    }))
    return [...kept, ...merged]
  }

  execute(): void {
    const f = this.findSketch()
    if (!f) return
    if (!this.before) {
      this.before = f.contours.map(cloneContour)
      this.after = this.computeAfter(f)
    }
    f.contours = this.after!.map(cloneContour)
  }

  undo(): void {
    const f = this.findSketch()
    if (!f || !this.before) return
    f.contours = this.before.map(cloneContour)
  }

  redo(): void {
    this.execute()
  }
}

/** 删除轮廓命令 */
export class RemoveContourCommand implements Command {
  label = '删除轮廓'
  private contourId: string
  private removed: Contour | null = null
  private sketchId: string | null = null

  constructor(contourId: string) {
    this.contourId = contourId
  }

  execute(): void {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const idx = f.contours.findIndex(c => c.id === this.contourId)
          if (idx >= 0) {
            this.removed = f.contours[idx]
            this.sketchId = f.id
            f.contours.splice(idx, 1)
            return
          }
        }
      }
    }
  }

  undo(): void {
    if (this.removed && this.sketchId) {
      const s = useAppStore.getState()
      for (const part of s.project.parts) {
        const f = part.features.find(x => x.id === this.sketchId)
        if (f?.type === 'sketch') f.contours.push(this.removed)
      }
    }
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 添加约束命令 (标注尺寸 = 添加约束)
 */
export class AddConstraintCommand implements Command {
  label = '添加约束'
  private contourId: string
  private constraint: Constraint

  constructor(contourId: string, constraint: Constraint) {
    this.contourId = contourId
    this.constraint = constraint
  }

  execute(): void {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c && !c.constraints.find(x => x.id === this.constraint.id)) {
            c.constraints.push(this.constraint)
          }
        }
      }
    }
  }

  undo(): void {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) c.constraints = c.constraints.filter(x => x.id !== this.constraint.id)
        }
      }
    }
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 删除约束命令 (与 AddConstraintCommand 互逆)
 * 用于: 约束面板 🗑 删除几何关系/尺寸
 */
export class RemoveConstraintCommand implements Command {
  label = '删除约束'
  private contourId: string
  private constraintId: string
  private removed: Constraint | null = null

  constructor(contourId: string, constraintId: string) {
    this.contourId = contourId
    this.constraintId = constraintId
  }

  private findContour(): { contour: Contour; sketch: SketchFeature } | null {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return { contour: c, sketch: f }
        }
      }
    }
    return null
  }

  execute(): void {
    const found = this.findContour()
    if (!found) return
    const idx = found.contour.constraints.findIndex(x => x.id === this.constraintId)
    if (idx >= 0) {
      this.removed = found.contour.constraints[idx]
      found.contour.constraints.splice(idx, 1)
    }
  }

  undo(): void {
    if (this.removed) {
      const found = this.findContour()
      if (found && !found.contour.constraints.find(x => x.id === this.removed!.id)) {
        found.contour.constraints.push(this.removed)
      }
    }
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 添加圆弧实体命令: 把轮廓的直边 i 替换为圆弧 (圆角)
 * 同一边已有弧 → 替换 (记录旧弧供撤销)
 */
export class AddArcEntityCommand implements Command {
  label = '圆弧边 (圆角)'
  private contourId: string
  private arc: ArcEntity
  private oldArc: ArcEntity | null = null

  constructor(contourId: string, arc: ArcEntity) {
    this.contourId = contourId
    this.arc = { ...arc, center: { ...arc.center } }
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    const arcs = c.arcs ? [...c.arcs] : []
    const idx = arcs.findIndex(a => a.p1 === this.arc.p1 && a.p2 === this.arc.p2)
    if (idx >= 0) {
      this.oldArc = arcs[idx]
      arcs[idx] = this.arc
    } else {
      arcs.push(this.arc)
    }
    c.arcs = arcs
  }

  undo(): void {
    const c = this.findContour()
    if (!c) return
    if (this.oldArc) {
      c.arcs = (c.arcs ?? []).map(a => (a.p1 === this.arc.p1 && a.p2 === this.arc.p2 ? this.oldArc! : a))
    } else {
      c.arcs = (c.arcs ?? []).filter(a => a.id !== this.arc.id)
    }
  }

  redo(): void {
    this.execute()
  }
}

/** 移除圆弧实体命令: 弧边退回直边 (修剪弧边的行为) */
export class RemoveArcEntityCommand implements Command {
  label = '删除圆弧边'
  private contourId: string
  private arcId: string
  private removed: ArcEntity | null = null

  constructor(contourId: string, arcId: string) {
    this.contourId = contourId
    this.arcId = arcId
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    const idx = (c.arcs ?? []).findIndex(a => a.id === this.arcId)
    if (idx >= 0) {
      this.removed = c.arcs![idx]
      c.arcs = c.arcs!.filter(a => a.id !== this.arcId)
    }
  }

  undo(): void {
    const c = this.findContour()
    if (!c || !this.removed) return
    if (!(c.arcs ?? []).find(a => a.id === this.arcId)) {
      c.arcs = [...(c.arcs ?? []), this.removed]
    }
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 修剪边命令: 删除轮廓一条边 (闭合→开放折线)
 * 整轮廓快照 (points/closed/constraints/arcs) → 撤销/重做原子恢复;
 * 约束 edgeIndex 与弧实体 p1/p2 自动重映射, 引用被删边的约束/弧实体一并丢弃
 * (与 SolidWorks 行为一致)。注意: 修剪弧边本身请走 RemoveArcEntityCommand (弧退回直边)。
 */
export class TrimEdgeCommand implements Command {
  label = '修剪边'
  private contourId: string
  private edgeIdx: number
  private before: TrimContourState | null = null
  private after: TrimContourState | null = null

  constructor(contourId: string, edgeIdx: number) {
    this.contourId = contourId
    this.edgeIdx = edgeIdx
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  /** 修剪后的新状态: 移除边 + 约束/弧实体索引重映射 */
  private computeAfter(c: Contour) {
    if (!c.closed) return null
    return stateFromTrimmedPath(c, trimClosedEdgeRange(c.points, this.edgeIdx, { t1: 0, t2: 1 }))
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    if (!this.before) {
      this.before = {
        points: c.points.map(p => ({ ...p })),
        closed: c.closed,
        constraints: c.constraints.map(x => ({ ...x })),
        arcs: (c.arcs ?? []).map(a => ({ ...a, center: { ...a.center } })),
        originAnchorIdx: c.originAnchorIdx,
      }
      this.after = this.computeAfter(c)
    }
    if (this.after) this.apply(this.after)
  }

  undo(): void {
    if (this.before) this.apply(this.before)
  }

  redo(): void {
    this.execute()
  }

  private apply(st: TrimContourState) {
    const c = this.findContour()
    if (!c) return
    c.points = st.points.map(p => ({ ...p }))
    c.closed = st.closed
    c.constraints = st.constraints.map(x => ({ ...x }))
    c.arcs = st.arcs.map(a => ({ ...a, center: { ...a.center } }))
    c.originAnchorIdx = st.originAnchorIdx
  }
}

/**
 * 线段修剪命令 (点擦除公共边): 在闭合轮廓的直边 k 上剪掉中间段 (t1..t2),
 * 剩余部分变为开放折线 [P1, v_k, v_{k-1}, ..., v_0, v_{n-1}, ..., v_{k+1}, P2],
 * 两端 P1/P2 保留为端点 (相交/接触点成为端点结构, 公共边两侧同时修剪)。
 * 调用方负责: 0<t1<t2<1 且边 k 为直边。
 */
export class TrimEdgeSegmentCommand implements Command {
  label = '修剪线段'
  private contourId: string
  private edgeIdx: number
  private t1: number
  private t2: number
  private before: TrimContourState | null = null
  private after: TrimContourState | null = null

  constructor(contourId: string, edgeIdx: number, t1: number, t2: number) {
    this.contourId = contourId
    this.edgeIdx = edgeIdx
    this.t1 = t1
    this.t2 = t2
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  private computeAfter(c: Contour) {
    if (!c.closed) return null
    return stateFromTrimmedPath(c, trimClosedEdgeRange(c.points, this.edgeIdx, { t1: this.t1, t2: this.t2 }))
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    if (!this.before) {
      this.before = {
        points: c.points.map(p => ({ ...p })),
        closed: c.closed,
        constraints: c.constraints.map(x => ({ ...x })),
        arcs: (c.arcs ?? []).map(a => ({ ...a, center: { ...a.center } })),
        originAnchorIdx: c.originAnchorIdx,
      }
      this.after = this.computeAfter(c)
    }
    if (this.after) this.apply(this.after)
  }

  undo(): void {
    if (this.before) this.apply(this.before)
  }

  redo(): void {
    this.execute()
  }

  private apply(st: TrimContourState) {
    const c = this.findContour()
    if (!c) return
    c.points = st.points.map(p => ({ ...p }))
    c.closed = st.closed
    c.constraints = st.constraints.map(x => ({ ...x }))
    c.arcs = st.arcs.map(a => ({ ...a, center: { ...a.center } }))
    c.originAnchorIdx = st.originAnchorIdx
  }
}

/**
 * 开放折线修剪命令：删除内部边时把左右余段拆成两个独立轮廓。
 * 旧实现会直接删掉一个顶点，再把缺口两侧自动连成斜线；这里保留真实拓扑并支持撤销/重做。
 */
export class TrimOpenEdgeRangeCommand implements Command {
  label = '修剪开放折线'
  private contourId: string
  private edgeIdx: number
  private t1: number
  private t2: number
  private extraContourId: string
  private sketchId: string | null = null
  private originalIndex = -1
  private before: Contour | null = null
  private after: Contour[] | null = null

  constructor(contourId: string, edgeIdx: number, t1: number, t2: number, extraContourId: string) {
    this.contourId = contourId
    this.edgeIdx = edgeIdx
    this.t1 = t1
    this.t2 = t2
    this.extraContourId = extraContourId
  }

  private findSketch(): SketchFeature | null {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const feature of part.features) {
        if (feature.type === 'sketch' && (feature.id === this.sketchId || feature.contours.some(c => c.id === this.contourId))) {
          return feature
        }
      }
    }
    return null
  }

  private computeAfter(c: Contour): Contour[] {
    if (c.closed) return []
    const paths = trimOpenEdgeRange(c.points, this.edgeIdx, { t1: this.t1, t2: this.t2 })
    return paths.map((path, index) => {
      const state = stateFromTrimmedPath(c, path)
      return {
        ...cloneContour(c),
        id: index === 0 ? c.id : this.extraContourId,
        name: index === 0 ? c.name : `${c.name} · 余段`,
        points: state.points,
        closed: false,
        constraints: state.constraints,
        arcs: state.arcs,
        originAnchorIdx: state.originAnchorIdx,
      }
    })
  }

  execute(): void {
    const sketch = this.findSketch()
    if (!sketch) return
    if (!this.before) {
      const index = sketch.contours.findIndex(c => c.id === this.contourId)
      if (index < 0) return
      this.sketchId = sketch.id
      this.originalIndex = index
      this.before = cloneContour(sketch.contours[index])
      this.after = this.computeAfter(sketch.contours[index])
    }
    const ids = new Set([this.contourId, this.extraContourId])
    sketch.contours = sketch.contours.filter(c => !ids.has(c.id))
    const insertAt = Math.max(0, Math.min(this.originalIndex, sketch.contours.length))
    sketch.contours.splice(insertAt, 0, ...(this.after ?? []).map(cloneContour))
  }

  undo(): void {
    const sketch = this.findSketch()
    if (!sketch || !this.before) return
    const ids = new Set([this.contourId, this.extraContourId])
    sketch.contours = sketch.contours.filter(c => !ids.has(c.id))
    const insertAt = Math.max(0, Math.min(this.originalIndex, sketch.contours.length))
    sketch.contours.splice(insertAt, 0, cloneContour(this.before))
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 修剪圆上的圆弧段命令: 把一个被多边形切割的圆按交点拆成若干段,
 * 删除指定的若干段, 保留其余段为独立开放圆弧轮廓。
 * 整圆深拷贝备份, 失败/异常时不修改; 只有成功才由 CommandManager 入栈。
 */
export class TrimCircleSegmentsCommand implements Command {
  label = '修剪圆弧段'
  private contourId: string
  private segmentIndices: number[]
  private sketchId: string | null = null
  private originalIndex = -1
  private before: Contour | null = null
  private after: Contour[] = []
  private applied = false

  constructor(contourId: string, segmentIndices: number[]) {
    this.contourId = contourId
    this.segmentIndices = [...segmentIndices].sort((a, b) => a - b)
  }

  private findSketchById(id: string): SketchFeature | null {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch' && f.id === id) return f
      }
    }
    return null
  }

  private makeArcContour(src: Contour, seg: CircleArcSegment, order: number): Contour {
    return {
      id: nextId('arcseg'),
      type: src.type,
      name: `${src.name} 弧段${order + 1}`,
      points: [{ ...seg.start }, { ...seg.end }],
      closed: false,
      arcs: [{
        id: nextId('arc'),
        p1: 0,
        p2: 1,
        center: { ...seg.center },
        radius: seg.radius,
        sweep: seg.sweep,
      }],
      constraints: [],
    }
  }

  execute(): void {
    if (this.applied) return
    const s = useAppStore.getState()

    if (!this.before) {
      for (const part of s.project.parts) {
        for (const f of part.features) {
          if (f.type !== 'sketch') continue
          const idx = f.contours.findIndex(c => c.id === this.contourId)
          if (idx < 0) continue
          const c = f.contours[idx]
          if (c.shape !== 'circle' || !c.center || !c.radius) return
          const segments = getCircleArcSegments(c, f.contours)
          if (!segments || segments.length < 2) return
          const removeSet = new Set(this.segmentIndices.filter(i => i >= 0 && i < segments.length))
          if (removeSet.size === 0) return
          this.sketchId = f.id
          this.originalIndex = idx
          this.before = cloneContour(c)
          const remaining = segments.filter((_, i) => !removeSet.has(i))
          this.after = remaining.map((seg, i) => this.makeArcContour(c, seg, i))
          break
        }
      }
    }

    if (!this.before || !this.sketchId) return
    const sketch = this.findSketchById(this.sketchId)
    if (!sketch) return

    try {
        // 移除原圆（若存在）
    const oldIdx = sketch.contours.findIndex(c => c.id === this.contourId)
    if (oldIdx >= 0) sketch.contours.splice(oldIdx, 1)

    // 防止重复执行时残留上次生成的弧段
    const afterIds = new Set(this.after.map(c => c.id))
    sketch.contours = sketch.contours.filter(c => !afterIds.has(c.id))

    const insertAt = Math.max(0, Math.min(this.originalIndex, sketch.contours.length))
    sketch.contours.splice(insertAt, 0, ...this.after.map(cloneContour))
            this.applied = true
      } catch (e) {
        // 出错立即回滚：恢复原始圆，移除可能已插入的弧段
        const afterIds = new Set(this.after.map(c => c.id))
        sketch.contours = sketch.contours.filter(c => !afterIds.has(c.id))
        const oldIdx = sketch.contours.findIndex(c => c.id === this.contourId)
        if (oldIdx >= 0) sketch.contours.splice(oldIdx, 1)
        const insertAt = Math.max(0, Math.min(this.originalIndex, sketch.contours.length))
        sketch.contours.splice(insertAt, 0, cloneContour(this.before))
        this.applied = false
        throw e
      }
  }

  undo(): void {
    if (!this.before || !this.sketchId) return
    const sketch = this.findSketchById(this.sketchId)
    if (!sketch) return
    const afterIds = new Set(this.after.map(c => c.id))
    sketch.contours = sketch.contours.filter(c => !afterIds.has(c.id))
    const oldIdx = sketch.contours.findIndex(c => c.id === this.contourId)
    if (oldIdx >= 0) sketch.contours.splice(oldIdx, 1)
    const insertAt = Math.max(0, Math.min(this.originalIndex, sketch.contours.length))
    sketch.contours.splice(insertAt, 0, cloneContour(this.before))
    this.applied = false
  }

  redo(): void {
    this.execute()
  }
}


/**
 * 分割边命令 (在线吸附): 在直边 k 上的 point 处插入新顶点。
 * 旧边 k 变为两段 (k: v_k→Q, k+1: Q→v_{k+1}); 引用旧边 k 的约束保留在第一段。
 */
export class SplitEdgeCommand implements Command {
  label = '分割边'
  private contourId: string
  private edgeIdx: number
  private point: Point2D
  private before: { points: Point2D[]; constraints: Constraint[]; arcs: ArcEntity[] } | null = null
  private after: { points: Point2D[]; constraints: Constraint[]; arcs: ArcEntity[] } | null = null

  constructor(contourId: string, edgeIdx: number, point: Point2D) {
    this.contourId = contourId
    this.edgeIdx = edgeIdx
    this.point = point
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  private computeAfter(c: Contour) {
    const old = c.points
    const k = this.edgeIdx
    const points = [...old.slice(0, k + 1), { ...this.point }, ...old.slice(k + 1)]
    const remapV = (j: number | undefined): number | undefined => {
      if (j === undefined || j === -2) return j
      return j <= k ? j : j + 1
    }
    const remapE = (j: number | undefined): number | undefined => {
      if (j === undefined) return undefined
      if (j < k) return j
      if (j === k) return k
      return j + 1
    }
    const constraints: Constraint[] = []
    for (const cons of c.constraints) {
      constraints.push({ ...cons, edgeIndex: remapE(cons.edgeIndex), edgeIndex2: remapE(cons.edgeIndex2), vertexIdx1: remapV(cons.vertexIdx1), vertexIdx2: remapV(cons.vertexIdx2) })
    }
    const arcs: ArcEntity[] = []
    for (const arc of c.arcs ?? []) {
      const np1 = remapV(arc.p1)
      const np2 = remapV(arc.p2)
      if (np1 === undefined || np2 === undefined || np1 === -2 || np2 === -2) continue
      arcs.push({ ...arc, p1: np1, p2: np2 })
    }
    return { points, constraints, arcs }
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    if (!this.before) {
      this.before = {
        points: c.points.map(p => ({ ...p })),
        constraints: c.constraints.map(x => ({ ...x })),
        arcs: (c.arcs ?? []).map(a => ({ ...a, center: { ...a.center } })),
      }
      this.after = this.computeAfter(c)
    }
    this.apply(this.after!)
  }

  undo(): void {
    if (this.before) this.apply(this.before)
  }

  redo(): void {
    this.execute()
  }

  private apply(st: { points: Point2D[]; constraints: Constraint[]; arcs: ArcEntity[] }) {
    const c = this.findContour()
    if (!c) return
    c.points = st.points.map(p => ({ ...p }))
    c.constraints = st.constraints.map(x => ({ ...x }))
    c.arcs = st.arcs.map(a => ({ ...a, center: { ...a.center } }))
  }
}

/**
 * 更新约束命令 (与 AddConstraintCommand 互补: 编辑已有尺寸的 value/label/labelPos)
 * 首次执行时快照涉及字段的旧值, 撤销时恢复。
 */
export class UpdateConstraintCommand implements Command {
  label = '更新约束'
  private contourId: string
  private constraintId: string
  private patch: Partial<Constraint>
  private old: Partial<Constraint> | null = null

  constructor(contourId: string, constraintId: string, patch: Partial<Constraint>) {
    this.contourId = contourId
    this.constraintId = constraintId
    this.patch = patch
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    const cons = c.constraints.find(x => x.id === this.constraintId)
    if (!cons) return
    if (!this.old) {
      const old: Partial<Constraint> = {}
      for (const k of Object.keys(this.patch) as (keyof Constraint)[]) {
        const v = cons[k]
        old[k] = (typeof v === 'object' && v !== null ? { ...(v as object) } : v) as never
      }
      this.old = old
    }
    Object.assign(cons, this.patch)
  }

  undo(): void {
    const c = this.findContour()
    if (!c || !this.old) return
    const cons = c.constraints.find(x => x.id === this.constraintId)
    if (cons) Object.assign(cons, this.old)
  }

  redo(): void {
    this.execute()
  }
}

/**
 * 快速擦除命令: 一次删除轮廓的多条直边 (点序旋转/重映射与 TrimEdgeCommand 同规则)。
 * 保留第一条未删除边的连续段为开放折线 (其余段丢弃, 符合"修剪到最近端"简化定位)。
 * 调用方负责: 圆/槽口/独立弧整删、弧边先走 RemoveArcEntityCommand、全删走 RemoveContourCommand。
 */
export class QuickTrimCommand implements Command {
  label = '快速擦除'
  private contourId: string
  private edgeSet: Set<number>
  private before: { points: Point2D[]; closed: boolean; constraints: Constraint[]; arcs: ArcEntity[] } | null = null
  private after: { points: Point2D[]; closed: boolean; constraints: Constraint[]; arcs: ArcEntity[] } | null = null

  constructor(contourId: string, edges: number[]) {
    this.contourId = contourId
    this.edgeSet = new Set(edges)
  }

  private findContour() {
    const s = useAppStore.getState()
    for (const part of s.project.parts) {
      for (const f of part.features) {
        if (f.type === 'sketch') {
          const c = f.contours.find(c => c.id === this.contourId)
          if (c) return c
        }
      }
    }
    return null
  }

  /** 删除多条边后的新状态 (保留第一段连续未删边) */
  private computeAfter(c: Contour): { points: Point2D[]; closed: boolean; constraints: Constraint[]; arcs: ArcEntity[] } | null {
    const n = c.points.length
    const del = this.edgeSet
    if (del.size === 0) return null
    const keepMap = new Map<number, number>()  // 旧点索引 → 新点索引
    let points: Point2D[]

    if (c.closed) {
      // 从第一条未删边开始, 沿原顺序收集连续段直到遇到被删边
      let start = -1
      for (let i = 0; i < n; i++) if (!del.has(i)) { start = i; break }
      if (start < 0) return null   // 全删 → 调用方整删轮廓
      const pts: Point2D[] = []
      let i = start
      while (true) {
        pts.push({ ...c.points[i] })
        keepMap.set(i, pts.length - 1)
        if (del.has(i)) break
        i = (i + 1) % n
        if (i === start) break
      }
      points = pts
    } else {
      // 开放: 保留前缀直到第一条被删边
      const pts: Point2D[] = []
      for (let i = 0; i < n; i++) {
        pts.push({ ...c.points[i] })
        keepMap.set(i, i)
        if (i < n - 1 && del.has(i)) break
      }
      points = pts
    }

    const remap = (oldIdx: number | undefined): number | undefined =>
      oldIdx === undefined ? undefined : oldIdx === -2 ? -2 : keepMap.get(oldIdx)
    /** 边保留判定: 两端点都在保留段且在新点序中连续 */
    const edgeKept = (oldEdge: number | undefined): boolean => {
      if (oldEdge === undefined) return false
      const a = remap(oldEdge)
      const b = remap((oldEdge + 1) % n)
      return a !== undefined && b !== undefined && b === a + 1
    }

    const constraints: Constraint[] = []
    for (const cons of c.constraints) {
      const v1 = cons.vertexIdx1, v2 = cons.vertexIdx2
      if (cons.type === 'distance' && (v1 !== undefined || v2 !== undefined)) {
        const nv1 = remap(v1), nv2 = remap(v2)
        if (nv1 === undefined || nv2 === undefined) continue
        constraints.push({ ...cons, vertexIdx1: nv1, vertexIdx2: nv2, edgeIndex: undefined, edgeIndex2: undefined })
        continue
      }
      if (cons.edgeIndex === undefined && cons.edgeIndex2 === undefined) continue
      const e1ok = edgeKept(cons.edgeIndex)
      const e2ok = edgeKept(cons.edgeIndex2)
      if ((cons.edgeIndex !== undefined && !e1ok) || (cons.edgeIndex2 !== undefined && !e2ok)) continue
      constraints.push({ ...cons, edgeIndex: remap(cons.edgeIndex), edgeIndex2: remap(cons.edgeIndex2) })
    }
    const arcs: ArcEntity[] = []
    for (const arc of c.arcs ?? []) {
      const r = remapArcEntity(arc, remap)
      if (r) arcs.push(r)
    }
    return { points, closed: false, constraints, arcs }
  }

  execute(): void {
    const c = this.findContour()
    if (!c) return
    if (!this.before) {
      this.before = {
        points: c.points.map(p => ({ ...p })),
        closed: c.closed,
        constraints: c.constraints.map(x => ({ ...x })),
        arcs: (c.arcs ?? []).map(a => ({ ...a, center: { ...a.center } })),
      }
      this.after = this.computeAfter(c)
    }
    if (!this.after) return
    this.apply(this.after)
  }

  undo(): void {
    if (this.before) this.apply(this.before)
  }

  redo(): void {
    this.execute()
  }

  private apply(st: { points: Point2D[]; closed: boolean; constraints: Constraint[]; arcs: ArcEntity[] }) {
    const c = this.findContour()
    if (!c) return
    c.points = st.points.map(p => ({ ...p }))
    c.closed = st.closed
    c.constraints = st.constraints.map(x => ({ ...x }))
    c.arcs = st.arcs.map(a => ({ ...a, center: { ...a.center } }))
  }
}
