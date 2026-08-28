// ============================================================================
// contourMerge.ts — 轮廓闭合判定与开放轮廓端点合并 (纯函数, 零依赖)
//
// 背景: 用户用两个矩形拼成 L 型后擦除公共边, 会产生"端点相接的开放轮廓"。
// 系统层面它们各自 closed=false, 导致:
//   1) 自动分割只认 closed 标志 → 误报"没有可分割的外轮廓"
//   2) 智能尺寸对开放轮廓欠约束 → 改边长后变成梯形
//
// 这里提供:
//   - isClosedGeo(): 几何闭合判定 (closed 标志 或 首尾点重合)
//   - mergeOpenContours(): 把端点重合的开放轮廓链合并成闭合轮廓
//   - mergeOpenChainGroups(): 同上, 并跟踪每条合并链的源轮廓 id
//     (供擦除公共边后把合并结果写回草图, 使尺寸/分割直接可用)
//
// 合并策略 (端点链追踪, 统一处理三种场景):
//   - 双端点相接: 两个矩形擦除公共边 → 两条"缺一边"的 C 形链,
//     两个端点都互相重合 → 绕行一圈成 L 型 (内角点自动合并)
//   - 单端点相接: 多段折线逐段描边, 端点链式相接, 最后首尾相接闭合
//   - 已闭合: 直接保留
// ============================================================================

import type { Point2D } from '../types/geometry'

/** 闭合判定阈值 (px): 与草图绘制"靠近起点闭合"的吸附半径一致 */
export const CLOSE_RADIUS = 15

const dist = (a: Point2D, b: Point2D) => Math.hypot(b.x - a.x, b.y - a.y)

/** 几何闭合判定: 轮廓首尾点重合 (或已标记闭合) */
export function isClosedGeo(c: { closed: boolean; points: Point2D[] }): boolean {
  if (c.closed) return true
  const pts = c.points
  if (pts.length < 3) return false
  return dist(pts[0], pts[pts.length - 1]) < CLOSE_RADIUS
}

export interface ContourChain {
  contourId: string
  name: string
  /** 轮廓闭合标志 (false 时仍可按首尾点重合判定几何闭合) */
  closed: boolean
  /** 像素/世界坐标点序列 (保持原序) */
  points: Point2D[]
}

/** 合并组: 由若干源轮廓合并成的一条链 */
export interface MergedChainGroup {
  chain: ContourChain
  /** 参与合并的源轮廓 id (单条自闭合时只有它自己) */
  sourceIds: string[]
}

/** 去掉环上"共线同向"的冗余顶点 (180° 直点), 使 L 型等结果更干净 */
function removeCollinear(pts: Point2D[]): Point2D[] {
  const out = pts.map(p => ({ ...p }))
  let changed = true
  while (changed && out.length >= 3) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length]
      const b = out[i]
      const c = out[(i + 1) % out.length]
      const d1x = b.x - a.x, d1y = b.y - a.y
      const d2x = c.x - b.x, d2y = c.y - b.y
      const cross = Math.abs(d1x * d2y - d1y * d2x)
      const dot = d1x * d2x + d1y * d2y
      if (cross < 1e-6 && dot > 0) { // 共线且同向 → b 是冗余直点
        out.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return out
}

/** 顶点集合查重 (闭合环不允许重复顶点) */
function hasDuplicate(pts: Point2D[]): boolean {
  const seen = new Set<string>()
  for (const p of pts) {
    const k = p.x + ',' + p.y
    if (seen.has(k)) return true
    seen.add(k)
  }
  return false
}

/** 相邻边均水平/垂直且非零长 (正交轮廓) */
function isOrthoSeq(pts: Point2D[], closed: boolean): boolean {
  const n = pts.length
  const total = closed && n > 2 ? n : n - 1
  for (let i = 0; i < total; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    const dx = Math.abs(q.x - p.x)
    const dy = Math.abs(q.y - p.y)
    if (Math.min(dx, dy) > 0.5) return false // 斜边
    if (Math.max(dx, dy) < 1) return false    // 零长边
  }
  return true
}

/**
 * 开放轮廓端点合并 (带源 id 追踪):
 * 从每条开放链出发, 沿重合端点 (距离 < CLOSE_RADIUS) 链式追踪拼接,
 * 直到无法继续; 首尾相接的链自动闭合。
 * 返回结果: 已闭合的链 (几何闭合) + 无法闭合的开放链 (原样保留, closed=false)。
 */
export function mergeOpenChainGroups(contours: ContourChain[]): MergedChainGroup[] {
  type G = MergedChainGroup
  const clone = (c: ContourChain): G => ({
    chain: { contourId: c.contourId, name: c.name, closed: c.closed, points: c.points.map(p => ({ ...p })) },
    sourceIds: [c.contourId],
  })

  const results: G[] = []
  const open: G[] = contours.map(clone)

  while (open.length > 0) {
    const g = open.shift()!
    let group: G = g
    // 向后延伸: 当前链尾端点 接 另一链首/尾
    // 向前延伸: 当前链首端点 接 另一链尾/首
    // 拼接时丢弃重合的接头点 (两矩形擦除公共边后, 两条链共享内角点),
    // 否则环上会出现重复顶点导致无法闭合。
    let extended = true
    while (extended) {
      extended = false
      const pts = group.chain.points
      const first = pts[0]
      const last = pts[pts.length - 1]
      // 已闭合/本身闭合并的链不再延伸 (保持原子性)
      if (group.chain.closed || dist(first, last) < CLOSE_RADIUS) break
      for (let i = 0; i < open.length; i++) {
        const h = open[i]
        const hp = h.chain.points
        const hFirst = hp[0]
        const hLast = hp[hp.length - 1]
        if (dist(last, hFirst) < CLOSE_RADIUS) {
          group = {
            chain: { ...group.chain, points: [...pts, ...hp.slice(1).map(p => ({ ...p }))] },
            sourceIds: [...group.sourceIds, ...h.sourceIds],
          }
          open.splice(i, 1); extended = true; break
        }
        if (dist(last, hLast) < CLOSE_RADIUS) {
          group = {
            chain: { ...group.chain, points: [...pts, ...[...hp].reverse().slice(1).map(p => ({ ...p }))] },
            sourceIds: [...group.sourceIds, ...h.sourceIds],
          }
          open.splice(i, 1); extended = true; break
        }
        if (dist(first, hLast) < CLOSE_RADIUS) {
          group = {
            chain: { ...group.chain, points: [...hp.map(p => ({ ...p })), ...pts.slice(1)] },
            sourceIds: [...h.sourceIds, ...group.sourceIds],
          }
          open.splice(i, 1); extended = true; break
        }
        if (dist(first, hFirst) < CLOSE_RADIUS) {
          group = {
            chain: { ...group.chain, points: [[...hp].reverse().map(p => ({ ...p })), ...pts.slice(1)].flat() },
            sourceIds: [...h.sourceIds, ...group.sourceIds],
          }
          open.splice(i, 1); extended = true; break
        }
      }
    }

    const pts = group.chain.points
    const closed = isClosedGeo(group.chain) || dist(pts[0], pts[pts.length - 1]) < CLOSE_RADIUS
    const hadDupEnd = dist(pts[0], pts[pts.length - 1]) < CLOSE_RADIUS
    const cleaned = removeCollinear(hadDupEnd ? pts.slice(0, -1) : pts)
    const ok = closed
      ? cleaned.length >= 3 && isOrthoSeq(cleaned, true) && !hasDuplicate(cleaned)
      : cleaned.length >= 2 && isOrthoSeq(cleaned, false) && !hasDuplicate(cleaned)
    if (ok) {
      results.push({
        chain: { ...group.chain, points: cleaned, closed },
        sourceIds: group.sourceIds,
      })
    } else if (group.sourceIds.length === 1 && !group.chain.closed) {
      // 无法追踪/非正交的原始开放链原样放回 (不丢几何)
      results.push(group)
    } else if (group.sourceIds.length === 1 && group.chain.closed) {
      results.push(group)
    }
    // 多源但无法可靠闭合的追踪结果丢弃 (避免把画布画乱)
  }
  return results
}

/** 开放轮廓端点合并 (仅返回合并后闭合的链) */
export function mergeOpenContours(contours: ContourChain[]): ContourChain[] {
  return mergeOpenChainGroups(contours)
    .filter(g => isClosedGeo(g.chain))
    .map(g => g.chain)
}
