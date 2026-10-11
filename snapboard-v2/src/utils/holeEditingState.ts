import type { HolePos, SplitPanel } from '../types/geometry'
import type { SpatialFace } from './spatialLayout'

export type HoleMode = 'slot' | 'round' | 'closed'
export type HoleGroup = 'slots' | 'round_holes' | 'edge_holes' | 'closed_holes'
export interface HoleSelection { panel: SplitPanel; x: number; y: number; spatialKey?: string; spatialFace?: SpatialFace; spatialOffsetY?: number }
export const holeGroups: HoleGroup[] = ['slots', 'round_holes', 'edge_holes', 'closed_holes']
export const sameHole = (hole: HolePos, x: number, y: number) => Math.abs(hole.x - x) < .01 && Math.abs(hole.y - y) < .01
export const holeCoordinateKey = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`
export function onPanelBoundary(panel: SplitPanel, hole: HolePos) {
  return Math.abs(hole.x - panel.x) < .5 || Math.abs(hole.x - panel.x - panel.w) < .5 ||
    Math.abs(hole.y - panel.y) < .5 || Math.abs(hole.y - panel.y - panel.h) < .5
}
export function panelHoleEntries(panel: SplitPanel) {
  return holeGroups.flatMap(group => (panel[group] ?? []).map(hole => ({ hole, group,
    mode: (group === 'slots' ? 'slot' : group === 'closed_holes' ? 'closed'
      : group === 'round_holes' || hole.knocked || onPanelBoundary(panel, hole) ? 'round' : 'closed') as HoleMode })))
}
export function restoreOriginalHole(panel: SplitPanel, hole: HolePos): SplitPanel {
  const origin = hole.editOrigin
  if (!origin) return panel
  const next = { ...panel, slots: panel.slots.filter(item => !sameHole(item, hole.x, hole.y)),
    round_holes: panel.round_holes.filter(item => !sameHole(item, hole.x, hole.y)),
    edge_holes: panel.edge_holes.filter(item => !sameHole(item, hole.x, hole.y)),
    closed_holes: (panel.closed_holes ?? []).filter(item => !sameHole(item, hole.x, hole.y)) }
  const original: HolePos = { x: hole.x, y: hole.y,
    ...(origin.knocked !== undefined ? { knocked: origin.knocked } : {}),
    ...(origin.manual !== undefined ? { manual: origin.manual } : {}) }
  const missing = panelHoleEntries(next).filter(item => item.group !== origin.group && item.hole.editOrigin?.group === origin.group &&
    (item.hole.editOrigin.index ?? Infinity) < (origin.index ?? Infinity)).length
  next[origin.group].splice(Math.max(0, (origin.index ?? next[origin.group].length) - missing), 0, original)
  if (!next.closed_holes.length) delete (next as SplitPanel).closed_holes
  return next
}
/** 只还原阵列元数据；独立于渲染和 WASM，配件锚点也读取同一原顺序。 */
export function originalPanelHoles(panel: SplitPanel): SplitPanel {
  let next = panel
  for (const { hole } of panelHoleEntries(panel)) if (hole.editOrigin) next = restoreOriginalHole(next, hole)
  return next
}
