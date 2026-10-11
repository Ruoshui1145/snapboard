/** 输入展示不暴露计算尾数；未编辑确认时保留原几何精度。 */
export function formatDimensionInput(value: number): string {
  if (!Number.isFinite(value)) return ''
  // 常规尺寸保留至 0.001 mm；极小值避免被显示为零。
  return String(Math.abs(value) > 0 && Math.abs(value) < 0.001
    ? Number(value.toPrecision(3)) : Number(value.toFixed(3)))
}

export function parseDimensionInput(text: string, initial: number): number {
  if (!text.trim()) return Number.NaN
  if (text === formatDimensionInput(initial)) return initial
  return Number(text)
}
