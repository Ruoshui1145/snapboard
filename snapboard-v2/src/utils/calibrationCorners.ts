export type CalibrationPoint = [number, number]

type Snapshot = { points: Array<CalibrationPoint | null>; active: number | null }
export type CalibrationCorners = Snapshot & { history: Snapshot[] }

export const emptyCalibrationCorners = (): CalibrationCorners => ({
  points: [null, null, null, null], active: 0, history: [],
})

type CornerAction =
  | { type: 'mark'; index: number; point: CalibrationPoint; advance?: boolean }
  | { type: 'select'; index: number }
  | { type: 'undo' }
  | { type: 'clear' }
  | { type: 'reset' }

export function calibrationCornerReducer(state: CalibrationCorners, action: CornerAction): CalibrationCorners {
  if (action.type === 'reset') return emptyCalibrationCorners()
  if (action.type === 'select') return { ...state, active: action.index }
  if (action.type === 'undo') {
    const previous = state.history.at(-1)
    return previous ? { ...previous, history: state.history.slice(0, -1) } : state
  }
  const history = [...state.history, { points: state.points, active: state.active }].slice(-32)
  if (action.type === 'clear') return state.points.every(point => !point)
    ? state : { ...emptyCalibrationCorners(), history }
  const points = state.points.map((item, index) => index === action.index ? action.point : item)
  const next = action.advance
    ? [1, 2, 3, 4].map(step => (action.index + step) % 4).find(index => !points[index]) ?? null
    : action.index
  return { points, active: next, history }
}

export function calibrationPointFromClick(
  clientX: number, clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  imageWidth: number, imageHeight: number,
): CalibrationPoint {
  return [
    Math.min(imageWidth - 1, Math.max(0, Math.round((clientX - rect.left) / rect.width * imageWidth))),
    Math.min(imageHeight - 1, Math.max(0, Math.round((clientY - rect.top) / rect.height * imageHeight))),
  ]
}

export function validCalibrationQuad(points: Array<CalibrationPoint | null>, width: number, height: number): boolean {
  if (points.length !== 4 || points.some(point => !point || point[0] < 0 || point[0] >= width || point[1] < 0 || point[1] >= height)) return false
  const quad = points as CalibrationPoint[]
  const cross = quad.map((point, index) => {
    const next = quad[(index + 1) % 4], after = quad[(index + 2) % 4]
    return (next[0] - point[0]) * (after[1] - next[1]) - (next[1] - point[1]) * (after[0] - next[0])
  })
  return cross.every(value => value > 0) && Math.abs(quad.reduce((area, point, index) => {
    const next = quad[(index + 1) % 4]
    return area + point[0] * next[1] - next[0] * point[1]
  }, 0)) >= 128
}
