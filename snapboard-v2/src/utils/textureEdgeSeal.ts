export const DEFAULT_TEXTURE_EDGE_SEAL_WIDTH_MM = 0.5

/**
 * 彩色光学层的基材封边判定。
 *
 * distanceMm 是单元中心到外轮廓或任意孔壁的最短距离。额外加入少量
 * 栅格半径，确保会碰到边界的彩色矩形全部退让给基材色；这能避免同一
 * 条外墙被拆成大量短彩色线段。封边对外边和孔边使用同一规则。
 */
export function isTextureEdgeSealCell(
  distanceMm: number,
  samplePitchMm: number,
  enabled: boolean,
  widthMm: number,
): boolean {
  if (!enabled || !Number.isFinite(distanceMm) || distanceMm <= 0) return false
  const width = Math.max(0, Number.isFinite(widthMm) ? widthMm : DEFAULT_TEXTURE_EDGE_SEAL_WIDTH_MM)
  const samplingAllowance = Math.max(0, samplePitchMm) * 0.35
  return distanceMm <= width + samplingAllowance
}

/** 纯数组入口，供制造回归验证外边与孔边都会形成连续封边。 */
export function buildTextureEdgeSealMask(
  materialMask: Uint8Array,
  distanceUnits: Uint16Array,
  samplePitchMm: number,
  enabled = true,
  widthMm = DEFAULT_TEXTURE_EDGE_SEAL_WIDTH_MM,
): Uint8Array {
  const output = new Uint8Array(materialMask.length)
  for (let index = 0; index < materialMask.length; index++) {
    if (!materialMask[index]) continue
    const distanceMm = distanceUnits[index] / 3 * samplePitchMm
    output[index] = isTextureEdgeSealCell(distanceMm, samplePitchMm, enabled, widthMm) ? 1 : 0
  }
  return output
}
