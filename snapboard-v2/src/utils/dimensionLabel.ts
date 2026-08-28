// Shared geometry for smart-dimension labels. Rendering and hit-testing must use
// the same box, otherwise a label can look clickable while only its centre is.
export const DIMENSION_LABEL_FONT = '11px sans-serif'
export const DIMENSION_LABEL_PAD_X = 5
export const DIMENSION_LABEL_TOP = 13
export const DIMENSION_LABEL_BOTTOM = 5
export const DIMENSION_LABEL_RADIUS = 4
export const DIMENSION_LABEL_HIT_SLOP = 3

export interface DimensionLabelBounds {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

let measuringContext: CanvasRenderingContext2D | null | undefined

/** Measure with the browser's real canvas font; deterministic fallback keeps tests/SSR safe. */
export function dimensionLabelTextWidth(text: string, measure?: (value: string) => number): number {
  if (measure) return measure(text)
  if (measuringContext === undefined) {
    measuringContext = typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d')
    if (measuringContext) measuringContext.font = DIMENSION_LABEL_FONT
  }
  if (measuringContext) return measuringContext.measureText(text).width
  return Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? 11 : ch === ' ' ? 3.5 : 6.3), 0)
}

/** `x/y` are the same left-baseline anchor passed to canvas fillText. */
export function dimensionLabelBounds(
  text: string,
  x: number,
  y: number,
  measure?: (value: string) => number,
): DimensionLabelBounds {
  const width = dimensionLabelTextWidth(text, measure) + DIMENSION_LABEL_PAD_X * 2
  const height = DIMENSION_LABEL_TOP + DIMENSION_LABEL_BOTTOM
  const left = x - DIMENSION_LABEL_PAD_X
  const top = y - DIMENSION_LABEL_TOP
  return { left, top, right: left + width, bottom: top + height, width, height }
}

export function pointInDimensionLabel(
  text: string,
  anchorX: number,
  anchorY: number,
  pointX: number,
  pointY: number,
  screenPxToUnits = 1,
): boolean {
  const textWidth = dimensionLabelTextWidth(text) * screenPxToUnits
  const pad = (DIMENSION_LABEL_PAD_X + DIMENSION_LABEL_HIT_SLOP) * screenPxToUnits
  return pointX >= anchorX - pad
    && pointX <= anchorX + textWidth + pad
    && pointY >= anchorY - (DIMENSION_LABEL_TOP + DIMENSION_LABEL_HIT_SLOP) * screenPxToUnits
    && pointY <= anchorY + (DIMENSION_LABEL_BOTTOM + DIMENSION_LABEL_HIT_SLOP) * screenPxToUnits
}
