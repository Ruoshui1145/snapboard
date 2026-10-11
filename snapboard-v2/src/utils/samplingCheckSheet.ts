import type { BoardTextureConfig, Point2D, SplitConfig, SplitPanel } from '../types/geometry'
import type { PlacedPart } from '../partLibrary/types'
import { buildSurfaceMarkingPlan, type AssemblyMarkingConfig } from './assemblyMarking'
import { createBoardTextureCanvas, getSplitPanelTextureBounds } from './boardTexture'
import { samplingPanelKey, type LastTextureSampling } from './textureSampling'
import { SNAPBOARD_PUBLICATION_NOTICE } from './snapboardAttribution'

/** One printable overview: front texture/crops and mirrored back assembly notes. */
export async function createSamplingCheckSheet(
  panels: SplitPanel[], texture: BoardTextureConfig, cfg: SplitConfig,
  marking: AssemblyMarkingConfig, parts: PlacedPart[], projectName: string,
  record: LastTextureSampling,
): Promise<Blob> {
  const bounds = getSplitPanelTextureBounds(panels)
  const scale = Math.min(600 / bounds.width, 520 / bounds.height, 8)
  const viewWidth = bounds.width * scale, viewHeight = bounds.height * scale
  const frontX = 100, backX = 850, top = 145
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  canvas.height = Math.ceil(Math.max(740, top + viewHeight + 120 + record.locations.length * 29))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('核对图片画布不可用')
  ctx.fillStyle = '#0e1726'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#f4f8ff'; ctx.font = 'bold 32px sans-serif'
  ctx.fillText(`${projectName} · 抽样与安装核对`, 64, 58, 1160)
  ctx.fillStyle = '#9eb0c5'; ctx.font = '18px sans-serif'
  ctx.fillText(`${record.exportedAt}  |  ${record.manufacturingFile}`, 65, 92, 1160)
  ctx.save()
  ctx.textAlign = 'right'; ctx.fillStyle = '#b2d9d2'; ctx.font = 'bold 18px sans-serif'
  ctx.fillText(SNAPBOARD_PUBLICATION_NOTICE, canvas.width - 64, 58)
  ctx.font = '15px sans-serif'; ctx.fillText('snapboard.cn', canvas.width - 64, 86)
  ctx.restore()
  ctx.fillStyle = '#e3edfb'; ctx.font = 'bold 23px sans-serif'
  ctx.fillText('正面 · 纹理与取样位置', frontX, 130)
  ctx.fillText('背面 · 板号与安装标识', backX, 130)
  const point = (p: Point2D, x: number, rear = false) => ({
    x: x + (rear ? bounds.maxX - p.x : p.x - bounds.minX) * scale,
    y: top + (bounds.maxY - p.y) * scale,
  })
  const ring = (points: Point2D[], x: number, rear = false) => {
    points.forEach((p, index) => { const v = point(p, x, rear); if (!index) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y) })
    ctx.closePath()
  }
  const outline = (panel: SplitPanel) => panel.contour?.length ? panel.contour : [
    { x: panel.x, y: panel.y }, { x: panel.x + panel.w, y: panel.y },
    { x: panel.x + panel.w, y: panel.y + panel.h }, { x: panel.x, y: panel.y + panel.h },
  ]
  const trace = (x: number, rear = false) => {
    ctx.beginPath()
    for (const panel of panels) {
      ring(outline(panel), x, rear)
      for (const cutout of panel.cutouts ?? []) ring(cutout, x, rear)
    }
  }
  ctx.save()
  trace(frontX); ctx.clip('evenodd')
  const preview = await createBoardTextureCanvas(texture, bounds.width / bounds.height, panels)
  if (preview) ctx.drawImage(preview, frontX, top, viewWidth, viewHeight)
  else { ctx.fillStyle = '#758b9b'; ctx.fillRect(frontX, top, viewWidth, viewHeight) }
  ctx.restore()
  trace(frontX); ctx.strokeStyle = '#8cf0df'; ctx.lineWidth = 2; ctx.stroke()
  trace(backX, true); ctx.fillStyle = '#34465a'; ctx.fill('evenodd')
  ctx.strokeStyle = '#9ac3d1'; ctx.lineWidth = 2; ctx.stroke()

  const plan = buildSurfaceMarkingPlan(panels, cfg, marking, texture, projectName)
  ctx.textAlign = 'center'; ctx.font = 'bold 16px sans-serif'
  for (const [index, panel] of panels.entries()) {
    const center = { x: panel.x + panel.w / 2, y: panel.y + panel.h / 2 }
    const p = point(center, backX, true)
    ctx.fillStyle = '#e9f6fd'; ctx.fillText(plan.panels[index]?.panelId ?? panel.id, p.x, p.y)
  }
  if (marking.enabled) for (const panel of plan.panels) for (const mark of panel.marks) {
    const p = point(mark, backX, true)
    ctx.fillStyle = '#ffd58a'; ctx.fillText(mark.text, p.x, p.y + 20)
  }
  for (const [index, part] of parts.entries()) {
    const placed = part.placement
    if (!placed) continue
    const p = point({ x: placed.position[0], y: placed.position[1] }, placed.side === 'back' ? backX : frontX, placed.side === 'back')
    ctx.fillStyle = '#ff968b'; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill()
    ctx.fillText(`M${index + 1}`, p.x, p.y - 10)
  }
  for (const location of record.locations) {
    const p = point(location, frontX)
    const half = record.sizeMm * scale / 2
    ctx.strokeStyle = '#ffce72'; ctx.lineWidth = 3; ctx.strokeRect(p.x - half, p.y - half, half * 2, half * 2)
    ctx.fillStyle = '#ffce72'; ctx.fillText(location.sampleId, p.x, p.y - half - 8)
  }
  ctx.textAlign = 'left'; ctx.font = '18px sans-serif'; ctx.fillStyle = '#d6e7f3'
  const tableTop = top + viewHeight + 55
  record.locations.forEach((location, index) => {
    const panelIndex = panels.findIndex(panel => panel.id === location.panelId && samplingPanelKey(panel) === location.geometryKey)
    const boardId = plan.panels[panelIndex]?.panelId ?? location.panelId
    ctx.fillText(`${location.sampleId} → ${boardId}   中心 X ${location.x.toFixed(2)} / Y ${location.y.toFixed(2)} mm   边长 ${record.sizeMm} mm`, 80, tableTop + index * 29)
  })
  ctx.fillStyle = '#9eb0c5'; ctx.font = '15px sans-serif'
  ctx.fillText('正面与背面为相反观察方向；M 为已放置配件，具体结构以 3MF 和项目文件为准。', 80, canvas.height - 38, 1180)
  ctx.textAlign = 'right'; ctx.fillText(SNAPBOARD_PUBLICATION_NOTICE, canvas.width - 64, canvas.height - 38)
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('核对图片生成失败')), 'image/png'))
}
