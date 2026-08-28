// ============ 自动分割算法 — 沿孔间中线切割 ============
// 输入: 板轮廓 + 孔阵列 + 最大单块尺寸
// 输出: 分割线列表 (垂直/水平), 每块 ≤ maxPieceSize

export interface CutLine {
  id: string
  type: 'vertical' | 'horizontal'
  /** 切割位置 (mm, 板子局部坐标) */
  position: number
  manual?: boolean
}

export interface SplitConfig {
  maxPieceSize: number   // mm (默认 220)
  enabled: boolean
}

/**
 * 自动分割: 贪心沿孔间中线切割
 * @param width 板宽 mm
 * @param height 板高 mm
 * @param spacingX 孔横向间距
 * @param spacingY 孔纵向间距
 * @param marginX 水平边距
 * @param marginY 垂直边距
 * @param config 分割配置
 */
export function autoSplit(
  width: number,
  height: number,
  spacingX: number,
  spacingY: number,
  marginX: number,
  marginY: number,
  config: SplitConfig,
): CutLine[] {
  const cuts: CutLine[] = []
  if (!config.enabled) return cuts

  // 沿 X 方向 (垂直切割线)
  // 切割位置 = 第 i 列孔心 + spacingX/2 (孔间中线)
  // 从 marginX 开始, 每 pieceSize 切一次, 吸附到最近的孔间中线
  const usableWidth = width - 2 * marginX
  if (usableWidth > config.maxPieceSize) {
    // 第一个切割位置: 从边缘算起, 使第一块 ≤ maxPieceSize
    let pos = marginX + config.maxPieceSize
    while (pos < width - marginX - 1) {
      // 吸附到最近的孔间中线
      const snapped = snapToSlotMidline(pos, spacingX, marginX, width)
      if (snapped > marginX && snapped < width - marginX) {
        cuts.push({ id: `cutV${cuts.length}`, type: 'vertical', position: snapped })
      }
      pos += config.maxPieceSize
    }
  }

  // 沿 Y 方向 (水平切割线)
  const usableHeight = height - 2 * marginY
  if (usableHeight > config.maxPieceSize) {
    let pos = marginY + config.maxPieceSize
    while (pos < height - marginY - 1) {
      const snapped = snapToSlotMidline(pos, spacingY, marginY, height)
      if (snapped > marginY && snapped < height - marginY) {
        cuts.push({ id: `cutH${cuts.length}`, type: 'horizontal', position: snapped })
      }
      pos += config.maxPieceSize
    }
  }

  return cuts
}

/**
 * 将位置吸附到最近的孔间中线
 * 孔心在 margin + n*spacing, 中线在 margin + n*spacing + spacing/2
 */
function snapToSlotMidline(pos: number, spacing: number, margin: number, size: number): number {
  // 可能的孔间中线位置
  let best = pos
  let bestDist = Infinity
  for (let n = 0; margin + n * spacing + spacing / 2 < size - margin; n++) {
    const midline = margin + n * spacing + spacing / 2
    const d = Math.abs(midline - pos)
    if (d < bestDist) {
      bestDist = d
      best = midline
    }
  }
  return best
}
