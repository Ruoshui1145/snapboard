import type { SplitConfig, SplitPanel } from '../types/geometry'
import { type AssemblyMarkingConfig, type AssemblyMarkPlacement } from './assemblyMarking'
import { createSideLogoCutterGeometry } from './sideLogo'
import type { Manifold, ManifoldToplevel } from 'manifold-3d'
import { faceToWorld } from './spatialLayout'
import type { SpatialPanel } from './spatialPanels'

export interface OrderEngravingInstance {
  panelCode: string
  sourcePanelId: string
  widthMm: number
  heightMm: number
  depthMm?: number
  setIndex: number
  copy: number
  instanceIndex: number
  lines: string[]
}
/** Production-only DTO. Never pass the order/customer record to manufacturing. */
export interface OrderEngravingPlan {
  orderNumber: string
  revision: number
  productionCode: string
  markingKey: string
  designFingerprint: string
  kitQuantity: number
  perSetPanelCount: number
  totalPanelCount: number
  panels: OrderEngravingInstance[]
}

export function orderInstanceLines(plan: OrderEngravingPlan, _instance: OrderEngravingInstance): string[] {
  return [plan.orderNumber]
}

export function validateOrderEngravingPlan(plan: OrderEngravingPlan): void {
  const number = /^SB-(\d{8})-(\d{4})$/.exec(plan.orderNumber)
  if (!number || plan.markingKey !== number[1].slice(2) + number[2] || !/^[a-f0-9]{64}$/.test(plan.designFingerprint)
    || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || !Number.isSafeInteger(plan.kitQuantity) || plan.kitQuantity < 1
    || !Number.isSafeInteger(plan.perSetPanelCount) || plan.perSetPanelCount < 1
    || plan.totalPanelCount !== plan.kitQuantity * plan.perSetPanelCount || plan.totalPanelCount > 100_000
    || plan.panels.length !== plan.totalPanelCount) throw new Error('订单制造追溯清单无效，请重新保存并确认订单')
  for (const [index, instance] of plan.panels.entries()) {
    if (instance.instanceIndex !== index + 1 || instance.setIndex !== Math.floor(index / plan.perSetPanelCount) + 1
      || !Number.isSafeInteger(instance.copy) || instance.copy < 1 || !/^P\d{2,5}$/.test(instance.panelCode)
      || !instance.sourcePanelId || ![instance.widthMm, instance.heightMm].every(value => Number.isFinite(value) && value > 0)
      || ![orderInstanceLines(plan, instance), [plan.markingKey, `R${String(plan.revision).padStart(2, '0')}-${instance.panelCode}`, `${instance.instanceIndex}/${plan.totalPanelCount}`]].some(lines => JSON.stringify(instance.lines) === JSON.stringify(lines))) {
      throw new Error('订单实物编号与制造清单不一致，已停止导出')
    }
  }
}

export function validateOrderPanel(instance: OrderEngravingInstance, panel: SplitPanel): void {
  if (instance.sourcePanelId !== panel.id || Math.abs(instance.widthMm - panel.w) > .02 || Math.abs(instance.heightMm - panel.h) > .02)
    throw new Error(`${instance.panelCode} 订单板件与当前制造件不一致，请保存当前设计并重新确认订单`)
}

export interface OrderSideEngraving {
  surface: 'side'
  zMm: number
  depthMm: number
  marks: AssemblyMarkPlacement[]
  layout: 'side'
  segments: Array<{ lineIndex: number; charStart: number; charEnd: number; text: string;
    xMm: number; yMm: number; rotationRad: number; textHeightMm: number }>
}

/** Only the complete order number is physical text; panel/revision/copy stay in metadata. */
export function orderSideEngravings(panel: SplitPanel, cfg: SplitConfig, plan: OrderEngravingPlan,
  instance: OrderEngravingInstance, marking?: AssemblyMarkingConfig): OrderSideEngraving[] {
  return sideOrderNumberEngravings(panel,cfg,plan.orderNumber,marking,instance.panelCode)
}

export function sideOrderNumberEngravings(panel: SplitPanel, cfg: SplitConfig, text: string,
  marking?: AssemblyMarkingConfig, panelCode = panel.id): OrderSideEngraving[] {
  if (!/^SB-\d{8}-\d{4}$/.test(text)) throw new Error('侧刻必须使用完整订单号')
  const depthMm = marking?.sideDepth ?? .24
  const geometry = createSideLogoCutterGeometry(panel, cfg, text, depthMm, marking?.sideTextHeight ?? 3.5, false)
  if (!geometry) throw new Error(`${panelCode} 现有侧壁放不下完整订单号 ${text}；请调整板厚或板件尺寸，不会省略订单号或添加背壳`)
  try {
    const box = geometry.boundingBox!, x = (box.min.x + box.max.x) / 2, y = box.max.y - .04
    const height = box.max.z - box.min.z
    return [{ surface: 'side', zMm: (box.min.z + box.max.z) / 2, depthMm, layout: 'side',
      marks: [{ id: `order-${panelCode}-side`, kind: 'identity', panelIndex: 0,
        panelId: panelCode, text, x, y, rotation: 0, width: box.max.x - box.min.x,
        height, textHeightMm: height, polygons: [] }],
      segments: [{ lineIndex: 0, charStart: 0, charEnd: text.length, text,
        xMm: x, yMm: y, rotationRad: 0, textHeightMm: height }] }]
  } finally { geometry.dispose() }
}

/** Enumerate fields so even an accidentally over-wide API payload cannot leak personal data. */
export function orderTraceMetadata(plan: OrderEngravingPlan, instances = plan.panels, sideEngravings?: OrderSideEngraving[]) {
  return { format: 'snapboard-order-engraving', schemaVersion: 1, operation: 'engrave',
    surface: 'side', physicalContent: 'order-number',
    orderNumber: plan.orderNumber, revision: plan.revision, productionCode: plan.productionCode,
    markingKey: plan.markingKey, designFingerprint: plan.designFingerprint, kitQuantity: plan.kitQuantity,
    perSetPanelCount: plan.perSetPanelCount, totalPanelCount: plan.totalPanelCount,
    panels: instances.map(instance => ({ panelCode: instance.panelCode, sourcePanelId: instance.sourcePanelId,
      setIndex: instance.setIndex, copy: instance.copy, instanceIndex: instance.instanceIndex,
      lines: orderInstanceLines(plan, instance),
      ...(sideEngravings ? { layout: sideEngravings[0]?.layout,
        readingOrder: 'top-edge-left-to-right', coordinateSpace: 'design-mm-before-print-orientation',
        segments: sideEngravings.flatMap(cut => cut.segments.map(segment => ({ ...segment, surface: cut.surface,
          zMm: cut.zMm, depthMm: cut.depthMm }))).map((segment, segmentIndex) => ({ segmentIndex, ...segment })),
        engravings: sideEngravings.map(cut => ({ surface: cut.surface, zMm: cut.zMm,
        depthMm: cut.depthMm, marks: cut.marks.map(mark => ({ xMm: mark.x, yMm: mark.y,
          rotationRad: mark.rotation, text: mark.text, textHeightMm: mark.textHeightMm })) })) } : {}) })) }
}

/** Cut a real plate edge in the folded solid, never its broad assembly/back face. */
export function engraveSpatialOrderSolid(solid: Manifold, faces: SpatialPanel[], cfg: SplitConfig, wasm: ManifoldToplevel,
  plan: OrderEngravingPlan, instance: OrderEngravingInstance, marking?: AssemblyMarkingConfig): Manifold {
  return engraveSpatialSideNumber(solid,faces,cfg,wasm,plan.orderNumber,marking,instance.panelCode)
}
export function engraveSpatialSideNumber(solid: Manifold, faces: SpatialPanel[], cfg: SplitConfig, wasm: ManifoldToplevel,
  number: string, marking?: AssemblyMarkingConfig, panelCode='立体件'): Manifold {
  if(!/^SB-\d{8}-\d{4}$/.test(number))throw new Error('侧刻必须使用完整订单号')
  const depth = marking?.sideDepth ?? .24
  for (const { face, panel } of [...faces].sort((a, b) => b.panel.w - a.panel.w)) {
    if (face.curve) continue
    const geometry = createSideLogoCutterGeometry(panel, cfg, number, depth, marking?.sideTextHeight ?? 3.5, false)
    if (!geometry) continue
    const position = geometry.getAttribute('position'), vertices = new Float32Array(position.count * 3)
    for (let i = 0; i < position.count; i++) vertices.set(faceToWorld(face, position.getX(i), position.getY(i), position.getZ(i) - cfg.thickness / 2), i * 3)
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: vertices,
      triVerts: Uint32Array.from(geometry.getIndex()?.array ?? Array.from({ length: position.count }, (_, i) => i)), tolerance: 1e-5 })
    geometry.dispose(); mesh.merge()
    const cutter = new wasm.Manifold(mesh)
    let engraved: Manifold | undefined
    try {
      if (cutter.status() !== 'NoError') throw new Error('订单侧刻字模网格未闭合')
      engraved = solid.subtract(cutter)
      if (engraved.status() !== 'NoError' || engraved.isEmpty()) throw new Error('立体订单侧刻未形成闭合实体')
      const expected = cutter.volume() * depth / (depth + .04)
      if (solid.volume() - engraved.volume() < expected * .999 - .001) { engraved.delete(); engraved = undefined; continue }
      return engraved
    } catch (error) { engraved?.delete(); throw error }
    finally { cutter.delete() }
  }
  throw new Error(`${panelCode} 立体件现有侧边放不下完整订单号 ${number}；请调整现有实体，不会改成背刻或添加材料`)
}
