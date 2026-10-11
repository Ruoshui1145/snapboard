import type { Contour, Constraint } from '../types/geometry'
import { CompositeCommand } from './Command'
import { AddConstraintCommand, UpdateConstraintCommand, UpdateContourPointsCommand } from './SketchCommands'

/** 圆的R与D描述同一自由度，换用另一种标注时替换旧的径向驱动。 */
export function circleSizeSolveContour(contour: Contour): Contour {
  return contour.shape === 'circle'
    ? { ...contour, constraints: contour.constraints.filter(item => item.type !== 'radius' && item.type !== 'diameter') }
    : contour
}

/** 几何与对应尺寸作为一次编辑撤销，防止恢复一半导致约束与模型分离。 */
export function dimensionEditCommand(
  contour: Contour,
  points: Contour['points'],
  patch: Partial<Contour>,
  constraint: Constraint,
  existingId?: string,
  geometryContour: Contour = contour,
): CompositeCommand {
  const radialReferences = contour.shape === 'circle' && (constraint.type === 'radius' || constraint.type === 'diameter')
    ? contour.constraints.filter(item => item.id !== existingId && (item.type === 'radius' || item.type === 'diameter'))
    : []
  const radiusMm = constraint.type === 'diameter' ? constraint.value / 2 : constraint.value
  return new CompositeCommand('修改智能尺寸', [
    new UpdateContourPointsCommand(geometryContour.id, geometryContour.points, points, patch),
    ...radialReferences.map(item => {
      const value = item.type === 'diameter' ? radiusMm * 2 : radiusMm
      return new UpdateConstraintCommand(contour.id, item.id, {
        value, driving: false, label: `${item.type === 'diameter' ? '直径' : 'R'} ${Number(value.toFixed(6))} mm`,
      })
    }),
    existingId
      ? new UpdateConstraintCommand(contour.id, existingId, constraint)
      : new AddConstraintCommand(contour.id, constraint),
  ])
}
