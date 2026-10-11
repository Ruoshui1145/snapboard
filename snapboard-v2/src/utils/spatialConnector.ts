import type { Manifold, ManifoldToplevel } from 'manifold-3d'

/** One printed fixed-angle bracket; M3 fasteners attach its two wings to neighbouring boards. */
export function createPrintedAngleConnector(wasm: ManifoldToplevel, angleDegrees: number,
  boardThickness = 5, clearanceMm = 0.25): Manifold {
  if (!Number.isFinite(angleDegrees) || angleDegrees < 40 || angleDegrees > 150) {
    throw new Error('连接件内角须在 40° 至 150° 之间')
  }
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0.1 || clearanceMm > 0.7) {
    throw new Error('M3 螺母嵌槽余量须在 0.1–0.7 mm 之间')
  }
  if (!Number.isFinite(boardThickness) || boardThickness <= 0) throw new Error('板厚无效')
  const height = 30, thickness = 5, bore = 1.7
  // Both wings sit flush on the OUTSIDE surfaces. Their offset planes meet
  // beyond the board corner, so the mounting hole must move out by this shift.
  const offset = (boardThickness + thickness) / 2
  const cornerShift = offset * Math.tan((180 - angleDegrees) * Math.PI / 360)
  const mountDistance = 20 + cornerShift
  const length = mountDistance + 12
  const circle = (x: number, y: number) => Array.from({ length: 32 }, (_, index): [number, number] => [
    x + bore * Math.cos(index * Math.PI / 16),
    y + bore * Math.sin(index * Math.PI / 16),
  ])
  const wing = (x0: number, holeX: number) => {
    const cross = new wasm.CrossSection([
      [[x0, 0], [x0 + length, 0], [x0 + length, height], [x0, height]],
      circle(holeX, height / 2),
    ], 'EvenOdd')
    const raw = cross.extrude(thickness)
    cross.delete()
    const centered = raw.translate(0, 0, -thickness / 2)
    raw.delete()
    const radius = (5.5 + 2 * clearanceMm) / Math.sqrt(3)
    const hex = new wasm.CrossSection(Array.from({ length: 6 }, (_, index): [number, number] => {
      const angle = Math.PI / 6 + index * Math.PI / 3
      return [holeX + radius * Math.cos(angle), height / 2 + radius * Math.sin(angle)]
    }))
    const pocket = hex.extrude(2.6 + clearanceMm)
    hex.delete()
    const result = centered.subtract(pocket)
    centered.delete(); pocket.delete()
    return result
  }
  const first = wing(-length, -mountDistance)
  const secondFlat = wing(0, mountDistance)
  const second = secondFlat.rotate(0, 180 - angleDegrees, 0)
  secondFlat.delete()
  const hubFlat = wasm.Manifold.cylinder(height, thickness / 2, thickness / 2, 32, true)
  const hubTurned = hubFlat.rotate(90, 0, 0)
  hubFlat.delete()
  const hub = hubTurned.translate(0, height / 2, 0)
  hubTurned.delete()
  try {
    const result = wasm.Manifold.union([first, second, hub])
    if (result.isEmpty() || result.decompose().length !== 1) {
      result.delete()
      throw new Error('固定角连接件未形成单个闭合实体')
    }
    return result
  } finally { first.delete(); second.delete(); hub.delete() }
}
