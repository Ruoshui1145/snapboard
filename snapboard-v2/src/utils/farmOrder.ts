import type { ProjectWorkspaceData } from './projectFile'
import { summarizeSnapBoardProject } from '../../../apps/order-workbench/shared/domain.mjs'
import { resolveSpatialManufacturing } from './spatialManufacturingPlan'
import { createSpatialPanels, spatialConnectorMountsOpen, splitSpatialHeight } from './spatialPanels'
import { alignSpatialConnectionEdges } from './spatialLayout'
import { manufacturingIdentityJson } from '../../../apps/order-workbench/shared/manufacturing-identity.mjs'

export async function projectManufacturingFingerprint(workspace: ProjectWorkspaceData): Promise<string> {
  const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manufacturingIdentityJson(workspace)))
  return Array.from(new Uint8Array(fingerprint), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Explicit save action only: use the same split engine as the actual 3MF export. */
export async function summarizeCurrentDesign(workspace: ProjectWorkspaceData) {
  const filename = workspace.project.metadata.name + '.snapboard'
  const summary = summarizeSnapBoardProject({ format: 'snapboard-project', schemaVersion: 1, workspace }, filename, { allowEmpty: true })
  if (workspace.spatialLayout.enabled) {
    const { createOnePieceSolid, splitSolidForPrint } = await import('./spatialSolid')
    const design = alignSpatialConnectionEdges(workspace.spatialLayout, workspace.splitConfig), plan = resolveSpatialManufacturing(design, workspace.splitConfig)
    if (plan.error) throw new Error(plan.error)
    const connector = plan.mode !== 'monolithic' && design.printedAngleConnector
    const pieces = await createSpatialPanels(plan.layout, plan.printCfg, plan.mode, connector, undefined, undefined, design)
    const panels: Array<{ code: string; quantity: number; widthMm: number; heightMm: number; depthMm?: number; notes: string; sourcePanelId: string }> = []
    if (plan.mode === 'monolithic') {
      for (const section of splitSpatialHeight(plan.layout, pieces, plan.printHeight, plan.printCfg)) {
        const { solid, wasm } = await createOnePieceSolid(section.layout, section.panels, plan.printCfg, design)
        try {
          const parts = splitSolidForPrint(solid, plan.printCfg, design, wasm, section.panels, section.offsetY)
          try { for (const part of parts) {
            const box = part.solid.boundingBox(), index = panels.length + 1
            panels.push({ code: `P${String(index).padStart(2, '0')}`, quantity: 1,
              widthMm: box.max[0] - box.min[0], heightMm: box.max[1] - box.min[1],
              depthMm: box.max[2] - box.min[2],
              notes: `立体件 M${String(index).padStart(2, '0')} · 深 ${(box.max[2] - box.min[2]).toFixed(2)}mm · 第${section.index + 1}节`,
              sourcePanelId: `M${String(index).padStart(2, '0')}` })
          } } finally { parts.forEach(part => part.solid.delete()) }
        } finally { solid.delete() }
      }
    } else pieces.forEach(({ face, panel }, index) => panels.push({ code: `P${String(index + 1).padStart(2, '0')}`, quantity: 1,
      widthMm: panel.w, heightMm: panel.h, notes: face.id, sourcePanelId: panel.id }))
    summary.panels = panels
    summary.product.widthMm = design.width
    summary.product.heightMm = design.height
    // Spatial exports currently manufacture plain bodies, regardless of planar texture controls.
    summary.product.mappingCode = 'M0'; summary.product.colourCode = 'C00'; summary.product.profile = ''
    summary.product.notes = `立体规格：${JSON.stringify({ template: design.template, mode: plan.mode, width: design.width,
      depth: design.depth, height: design.height, angle: design.angleDegrees, sides: design.polygonSides })}`
    const count = connector && spatialConnectorMountsOpen(plan.layout, pieces)
      ? plan.layout.junctions.length * (plan.layout.faces[0].height >= 100 ? 2 : 1) : 0
    summary.warning = [`已按当前安全打印空间读取 ${panels.length} 个实际板体制造件；尺寸为装配方向包围盒，立体深度保存在板件备注。`,
      count ? `另需 ${count} 个定角连接件（不计入板体块数）。` : '',
      !summary.product.layoutCode ? '此形态没有默认编码，请先在台账编码库登记，再选择对应形态。' : ''].filter(Boolean).join(' ')
  }
  return { ...summary, designFingerprint: await projectManufacturingFingerprint(workspace) }
}
