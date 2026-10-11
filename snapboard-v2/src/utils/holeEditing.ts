import type { HolePos, SplitPanel, SplitConfig } from '../types/geometry'
import { createSplitPanelShape } from './boardMesh'
import { sweptCircleFitsMaterial } from './pegboardSplit'
import { holeGroups as groups, sameHole, holeCoordinateKey, panelHoleEntries, onPanelBoundary, originalPanelHoles, restoreOriginalHole, type HoleMode } from './holeEditingState'
export { sameHole, holeCoordinateKey, panelHoleEntries, originalPanelHoles } from './holeEditingState'
export type { HoleMode, HoleGroup, HoleSelection } from './holeEditingState'

/** 原始阵列生成以后才改孔型；不移动孔心，也不重新生成板缝。 */
export function changePanelHole(panel: SplitPanel, x: number, y: number, mode: HoleMode | 'restore', cfg: SplitConfig): SplitPanel {
  const matches = panelHoleEntries(panel).filter(item => sameHole(item.hole, x, y))
  const entry = matches.find(item => item.hole.editOrigin) ?? matches[0]
  if (!entry) throw new Error('该孔位已不存在，请重新选择')
  if (mode === 'restore' && !entry.hole.editOrigin || mode === entry.mode && entry.hole.editOrigin && matches.length === 1) return panel
  const { hole, group } = entry
  if (mode === 'restore') return restoreOriginalHole(panel, hole)
  const origin = hole.editOrigin ?? { group: group === 'closed_holes' ? 'edge_holes' : group,
    index: Math.max(0, (originalPanelHoles(panel)[group] ?? []).findIndex(item => sameHole(item, x, y))),
    ...(hole.knocked !== undefined ? { knocked: hole.knocked } : {}),
    ...(hole.manual !== undefined ? { manual: hole.manual } : {}) }
  const next = { ...panel, slots: [...panel.slots], round_holes: [...panel.round_holes], edge_holes: [...panel.edge_holes],
    closed_holes: [...(panel.closed_holes ?? [])] }
  for (const key of groups) next[key] = next[key].filter(item => !sameHole(item, x, y))
  {
    if (mode !== 'closed' && !(mode === 'round' && origin.group === 'edge_holes' && onPanelBoundary(panel, hole))) {
      const shape = createSplitPanelShape(next, cfg, 12)
      const radius = (mode === 'slot' ? cfg.slotWidth : cfg.jointDiameter) / 2
      const half = mode === 'slot' ? Math.max(0, (cfg.slotLength - cfg.slotWidth) / 2) : 0
      if (!sweptCircleFitsMaterial({ x, y: y - half }, { x, y: y + half }, radius,
        Math.max(0, cfg.holeBoundaryClearance), shape.getPoints(24), shape.holes.map(path => path.getPoints(24)))) {
        throw new Error('该孔型会碰到板边、圆角或其他开孔，请保留原孔型或关闭此孔')
      }
    }
    const edited: HolePos = { x: hole.x, y: hole.y, manual: true, editOrigin: origin }
    const destination = mode === 'slot' ? 'slots' : mode === 'round' ? origin.group === 'edge_holes' ? 'edge_holes' : 'round_holes' : 'closed_holes'
    if (mode === 'round') edited.knocked = true
    if (destination === origin.group) {
      const missing = panelHoleEntries(next).filter(item => item.group !== origin.group && item.hole.editOrigin?.group === origin.group &&
        (item.hole.editOrigin.index ?? Infinity) < (origin.index ?? Infinity)).length
      next[destination].splice(Math.max(0, (origin.index ?? next[destination].length) - missing), 0, edited)
    } else next[destination].push(edited)
  }
  if (!next.closed_holes.length) delete (next as SplitPanel).closed_holes
  return next
}

export function preserveEditedHoles(next: SplitPanel[], previous: SplitPanel[], cfg: SplitConfig) {
  const edits = new Map(previous.flatMap(panel => panelHoleEntries(panel).filter(item => item.hole.editOrigin)
    .map(item => [holeCoordinateKey(item.hole.x, item.hole.y), item.mode] as const)))
  for (const panel of next) for (const { hole } of panelHoleEntries(panel)) {
    const mode = edits.get(holeCoordinateKey(hole.x, hole.y))
    if (mode) Object.assign(panel, changePanelHole(panel, hole.x, hole.y, mode, cfg))
  }
}

export function applySpatialHoleTypes(panel: SplitPanel, phaseU: number, offsetY: number,
  types: Record<string, HoleMode> | undefined, cfg: SplitConfig): SplitPanel {
  if (!types) return panel
  let next = panel
  for (const { hole } of panelHoleEntries(panel)) {
    const mode = types[holeCoordinateKey(phaseU + hole.x, offsetY + hole.y)]
    if (mode) next = changePanelHole(next, hole.x, hole.y, mode, cfg)
  }
  return next
}
