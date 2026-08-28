/**
 * 端面环形采样会受三角网格和采样步长影响，接近 X/Y 主轴时可能产生约 7.5° 的抖动。
 * SnapBoard 标准孔阵列是正交晶格；在 12.7° 内归正到主轴，其余真实斜向锚点保持不变。
 */
export function stabilizeSlotAxis(axis: [number, number]): [number, number] {
  const length = Math.hypot(axis[0], axis[1])
  if (!Number.isFinite(length) || length < 1e-6) return [0, 1]
  const x = axis[0] / length
  const y = axis[1] / length
  const threshold = 0.22
  if (Math.abs(x) <= threshold) return [0, y < 0 ? -1 : 1]
  if (Math.abs(y) <= threshold) return [x < 0 ? -1 : 1, 0]
  return [x, y]
}
