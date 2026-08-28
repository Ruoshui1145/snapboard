// ============ planegcs 约束求解器封装 (FreeCAD 引擎 WASM 版) ============
// 所有 2D 草图几何约束和尺寸驱动都通过此模块求解
//
// planegcs primitive 约定 (见 node_modules/@salusoft89/planegcs/dist/planegcs_dist/constraints.d.ts):
// - 点:  { id: 'p0', type: 'point', x, y, fixed }
// - 线:  { id: 'l0-1', type: 'line', p1_id: 'p0', p2_id: 'p1' }  ← 必须先显式声明, 约束才能引用
// - 约束字段: horizontal_l/vertical_l 用 l_id; parallel/perpendicular/equal_length 用 l1_id/l2_id
//
// ★ 并发保护: WASM GcsSystem 是单例, 多次求解共用同一底层状态 (clear_data 全局清空),
//   并行调用会互相污染。所有 solveSketch 通过模块级 Promise 队列串行执行。
import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs'
import wasm_url from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'
import type { Point2D } from '../types/geometry'

// ---- 单例: WASM 模块只初始化一次 ----
let _gcs: GcsWrapper | null = null
let _initPromise: Promise<GcsWrapper> | null = null

export async function getSolver(): Promise<GcsWrapper> {
  if (_gcs) return _gcs
  if (!_initPromise) {
    _initPromise = (async () => {
      const mod = await init_planegcs_module({ locateFile: () => wasm_url })
      _gcs = new GcsWrapper(new mod.GcsSystem())
      return _gcs
    })()
  }
  return _initPromise
}

// ---- 串行求解队列: 保证同一时刻只有一次 solve 在操作 WASM 单例 ----
let _solveQueue: Promise<unknown> = Promise.resolve()

// ---- 约束类型 (与 planegcs primitives 对应) ----

export interface SolverConstraint {
  type: string
  [key: string]: unknown
}

export interface SolveResult {
  success: boolean
  points: Point2D[]
  message?: string
  /** 是否存在冲突约束 (过约束冲突) */
  conflict?: boolean
  /** 是否存在冗余约束 */
  redundant?: boolean
}

export interface SolveOpts {
  /** 固定点索引 (默认 [0]: 固定第一点消除平移自由度) */
  fixedIndices?: number[]
  /** 轮廓是否闭合: 决定自动生成 n 条 (闭合) 还是 n-1 条 (开放) 边线 (默认 true) */
  closed?: boolean
}

/** 边线 id: 点 a → 点 b 组成的线 (索引自动排序保证稳定) */
export const lineId = (a: number, b: number) => `l${Math.min(a, b)}-${Math.max(a, b)}`

/** 线段相交检测（不含端点接触） */
function segIntersect(a1: Point2D, b1: Point2D, a2: Point2D, b2: Point2D): boolean {
  const d1x = b1.x - a1.x, d1y = b1.y - a1.y
  const d2x = b2.x - a2.x, d2y = b2.y - a2.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return false
  const t = ((a2.x - a1.x) * d2y - (a2.y - a1.y) * d2x) / den
  const u = ((a2.x - a1.x) * d1y - (a2.y - a1.y) * d1x) / den
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98
}

/** 求解结果合法性：不允许零长度边、退化或自相交轮廓 */
function isValidSolvedPoints(points: Point2D[], closed: boolean): boolean {
  const n = points.length
  if (n < 2) return false
  const total = closed && n > 2 ? n : n - 1
  for (let i = 0; i < total; i++) {
    const a = points[i], b = points[(i + 1) % n]
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return false
  }
  if (!closed || n < 4) return true
  for (let i = 0; i < n; i++) {
    const a1 = points[i], b1 = points[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue
      if (segIntersect(a1, b1, points[j], points[(j + 1) % n])) return false
    }
  }
  return true
}

/** 将近似正交的求解结果吸附到水平/垂直，避免微小浮点误差把矩形拉成梯形 */
function snapMostlyOrthogonal(points: Point2D[], closed: boolean): Point2D[] {
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
      if (maxAxis > 1e-6 && minAxis <= maxAxis * 0.15) {
        if (dx >= dy) {
          ys[i].push(result[j].y)
          ys[j].push(result[i].y)
        } else {
          xs[i].push(result[j].x)
          xs[j].push(result[i].x)
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (xs[i].length > 0) result[i].x = xs[i].reduce((a, b) => a + b, 0) / xs[i].length
      if (ys[i].length > 0) result[i].y = ys[i].reduce((a, b) => a + b, 0) / ys[i].length
    }
  }
  return result
}



/**
 * 求解 2D 草图约束系统 (串行队列保护, 见文件头说明)
 *
 * 自动构建: 所有点 + 轮廓边线 (line) + 约束 primitives
 *
 * @param points 顶点初始位置 (px)
 * @param constraints 约束列表 (planegcs primitives)
 * @param opts 求解选项
 * @returns 求解后的顶点位置
 */
export function solveSketch(
  points: Point2D[],
  constraints: SolverConstraint[],
  opts?: SolveOpts,
): Promise<SolveResult> {
  const run = async (): Promise<SolveResult> => {
    try {
      const gcs = await getSolver()
      const fixed = opts?.fixedIndices ?? [0]
      const closed = opts?.closed ?? true
      const n = points.length

      // 重要: 单例 GcsSystem 的 push 会去重累积 (push_point 有 id 判重),
      // 每次求解前必须清空, 否则旧点/约束残留导致结果错误
      gcs.clear_data()

      // 提高迭代次数: 默认 100 次对 equal_length 等非线性约束收敛不足 (实测需要 ~2000)
      gcs.set_max_iterations(2000)

      // 构建 primitives: 点 + 边线 + 约束
      const primitives: Array<Record<string, unknown>> = []
      for (let i = 0; i < n; i++) {
        primitives.push({
          id: `p${i}`,
          type: 'point',
          x: points[i].x,
          y: points[i].y,
          fixed: fixed.includes(i),
        })
      }
      // 闭合 n=2 (槽口胶囊两点定中心线) 只生成 1 条边:
      // 否则 i=0→j=1 与 i=1→j=0 生成同 id 线 primitive (lineId 排序后均为 l0-1), 导致重复
      const edgeCount = closed && n > 2 ? n : Math.max(0, n - 1)
      for (let i = 0; i < edgeCount; i++) {
        const j = (i + 1) % n
        // planegcs 要求: 线的 p1_id 必须低于 p2_id
        primitives.push({
          id: lineId(i, j), type: 'line',
          p1_id: `p${Math.min(i, j)}`, p2_id: `p${Math.max(i, j)}`,
        })
      }
        // 过滤引用不存在边线的约束（开放轮廓被误当成闭合轮廓时传入的“最后一条闭合边”约束）
        const validLineIds = new Set(primitives.filter(p => p.type === 'line').map(p => String(p.id)))
        const validConstraints = constraints.filter(c => {
          const l = c.l_id as string | undefined
          const l1 = c.l1_id as string | undefined
          const l2 = c.l2_id as string | undefined
          if (l !== undefined && !validLineIds.has(l)) return false
          if (l1 !== undefined && !validLineIds.has(l1)) return false
          if (l2 !== undefined && !validLineIds.has(l2)) return false
          return true
        })
        // 自动锁正交：对当前几何中接近水平/垂直的边，补充 H/V 约束。
        // 这样即使调用方没有显式加 H/V，L 形开放折线等正交轮廓也不会被拉成梯形。
        const autoOrtho: SolverConstraint[] = []
        for (let i = 0; i < edgeCount; i++) {
          const j = (i + 1) % n
          const a = points[i], b = points[j]
          const dx = Math.abs(b.x - a.x)
          const dy = Math.abs(b.y - a.y)
          const maxAxis = Math.max(dx, dy)
          const minAxis = Math.min(dx, dy)
          if (maxAxis < 1e-6 || minAxis > maxAxis * 0.15) continue
          const isH = dx >= dy
          const type = isH ? 'horizontal_l' : 'vertical_l'
          const id = isH ? `h_${i}_${j}` : `v_${i}_${j}`
          const lid = lineId(i, j)
          const duplicated = validConstraints.some(c =>
            (c.type === type && c.l_id === lid) || c.id === id)
          if (!duplicated) autoOrtho.push({ type, id, l_id: lid })
        }
        primitives.push(...autoOrtho as Array<Record<string, unknown>>)
      primitives.push(...validConstraints as Array<Record<string, unknown>>)

      gcs.push_primitives_and_params(primitives as never)
      gcs.solve()
      gcs.apply_solution()

      const solved = gcs.sketch_index.get_primitives() as { id: string; type: string; x: number; y: number }[]

      // 保留 0.1px 精度: 整数取整会使角度/平行求解逐次漂移
      const rawResult = points.map((_, i) => {
        const p = solved.find(s => s.id === `p${i}`)
        const rx = p?.x ?? points[i].x
        const ry = p?.y ?? points[i].y
        return { x: Math.round(rx * 10) / 10, y: Math.round(ry * 10) / 10 }
      })
        const result = snapMostlyOrthogonal(rawResult, closed)

        if (!isValidSolvedPoints(result, closed)) {
          return {
            success: false,
            points,
            message: 'solved geometry is degenerate or self-intersecting',
          }
        }
      return {
        success: true,
        points: result,
        conflict: gcs.has_gcs_conflicting_constraints(),
        redundant: gcs.has_gcs_redundant_constraints(),
      }
    } catch (err) {
      console.error('Solver failed:', err)
      return { success: false, points, message: String(err) }
    }
  }

  // 串行队列: 上一次求解 (无论成败) 完成后再执行本次
  const p = _solveQueue.then(run, run)
  _solveQueue = p.then(() => undefined, () => undefined)
  return p
}

// ---- 常用约束构造器 (均基于点索引, 引用 solver 自动生成的边线) ----

/** 水平约束 */
export const horizontal = (a: number, b: number) => ({ type: 'horizontal_l', id: `h_${a}_${b}`, l_id: lineId(a, b) })

/** 垂直约束 */
export const vertical = (a: number, b: number) => ({ type: 'vertical_l', id: `v_${a}_${b}`, l_id: lineId(a, b) })

/** 两点距离 (尺寸驱动) */
export const p2pDistance = (p1: number, p2: number, dist: number) => ({
  type: 'p2p_distance',
  id: `d_${p1}_${p2}`,
  p1_id: `p${p1}`,
  p2_id: `p${p2}`,
  distance: dist,
})

/** 共线/重合 */
export const coincident = (p1: number, p2: number) => ({
  type: 'p2p_coincident',
  id: `c_${p1}_${p2}`,
  p1_id: `p${p1}`,
  p2_id: `p${p2}`,
})

/** 平行 */
export const parallel = (a1: number, b1: number, a2: number, b2: number) => ({
  type: 'parallel',
  id: `par_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
})

/** 垂直 */
export const perpendicular = (a1: number, b1: number, a2: number, b2: number) => ({
  type: 'perpendicular_ll',
  id: `perp_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
})

/** 相等长度 */
export const equalLength = (a1: number, b1: number, a2: number, b2: number) => ({
  type: 'equal_length',
  id: `eq_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
})

/** 角度 (度数) */
export const angle = (a1: number, b1: number, a2: number, b2: number, deg: number) => ({
  type: 'l2l_angle_ll',
  id: `ang_${lineId(a1, b1)}_${lineId(a2, b2)}`,
  l1_id: lineId(a1, b1),
  l2_id: lineId(a2, b2),
  angle: (deg * Math.PI) / 180,
})
