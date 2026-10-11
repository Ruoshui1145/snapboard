/**
 * SnapColor 导入模式功能门。
 *
 * SVG 与像素模式已恢复；对应 MIME、解析、持久化与制造回归需要一起维护。
 */
export const SNAPCOLOR_FEATURE_GATES = Object.freeze({
  pixelArtImport: true,
  svgVectorImport: true,
})

export const SNAPCOLOR_RASTER_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'
export const SNAPCOLOR_IMAGE_ACCEPT = `${SNAPCOLOR_RASTER_ACCEPT},image/svg+xml,.svg`

export function snapColorModelingModeAvailable(mode: 'high-fidelity' | 'pixel' | 'vector'): boolean {
  if (mode === 'pixel') return SNAPCOLOR_FEATURE_GATES.pixelArtImport
  if (mode === 'vector') return SNAPCOLOR_FEATURE_GATES.svgVectorImport
  return true
}
