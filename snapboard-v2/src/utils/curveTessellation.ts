const DEFAULT_MAX_CHORD_ERROR_MM = 0.05
const DEFAULT_MAX_ANGLE = (7.5 * Math.PI) / 180

/** 按毫米弦高误差自适应计算圆弧离散段数，并保留 7.5° 的旧上限。 */
export function curveSegmentCount(
  radiusWorld: number,
  worldToMM: number,
  spanRadians: number,
  maxChordErrorMM = DEFAULT_MAX_CHORD_ERROR_MM,
): number {
  const radiusMM = Math.abs(radiusWorld * worldToMM)
  const span = Math.abs(spanRadians)
  if (!Number.isFinite(radiusMM) || !Number.isFinite(span) || radiusMM <= 1e-9 || span <= 1e-9) return 1
  const ratio = Math.max(-1, Math.min(1, 1 - Math.max(1e-6, maxChordErrorMM) / radiusMM))
  const chordLimitedAngle = 2 * Math.acos(ratio)
  const step = Math.max(1e-4, Math.min(DEFAULT_MAX_ANGLE, chordLimitedAngle || DEFAULT_MAX_ANGLE))
  return Math.max(4, Math.min(4096, Math.ceil(span / step)))
}

export function chordHeightErrorMM(radiusWorld: number, worldToMM: number, segments: number, spanRadians: number): number {
  if (segments <= 0) return Number.POSITIVE_INFINITY
  const radiusMM = Math.abs(radiusWorld * worldToMM)
  return radiusMM * (1 - Math.cos(Math.abs(spanRadians) / segments / 2))
}
