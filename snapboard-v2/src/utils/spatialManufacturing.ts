import { strToU8, zipSync } from 'fflate'
import type { SplitConfig, SplitPanel } from '../types/geometry'
import type { AssemblyMarkingConfig } from './assemblyMarking'
import { createDefaultBoardTexture } from './boardTexture'
import { createManufacturing3MF, type Manufacturing3MFSummary } from './export3mf'
import { safeFileName } from './projectFile'
import { createPrintedAngleConnector } from './spatialConnector'
import { writeSpatial3MF } from './spatial3mf'
import { createSpatialPanels, spatialConnectorMountsOpen, splitSpatialHeight } from './spatialPanels'
import { resolveSpatialManufacturing } from './spatialManufacturingPlan'
import { createOnePieceSolid, manifoldToPrinterMesh, spatialManifold, splitSolidForPrint } from './spatialSolid'
import { faceToWorld, type SpatialLayout, type SpatialLayoutConfig } from './spatialLayout'
import { engraveSpatialOrderSolid, engraveSpatialSideNumber, orderTraceMetadata, validateOrderEngravingPlan, type OrderEngravingPlan } from './orderEngraving'
import { manufacturingCatalog, orderManufacturingCatalog } from './manufacturingCatalog'
import { SNAPBOARD_PUBLICATION_NOTICE } from './snapboardAttribution'

export interface SpatialManufacturingInput {
  layout: SpatialLayoutConfig
  cfg: SplitConfig
  projectName: string
  projectVersion?: string
  assemblyMarking: AssemblyMarkingConfig
  orderEngraving?: OrderEngravingPlan
  signal?: AbortSignal
  onProgress?(message: string, progress?: number): void
}

const shiftPanel = (panel: SplitPanel, dx: number): SplitPanel => ({
  ...panel, x: panel.x + dx,
  contour: panel.contour?.map(point => ({ x: point.x + dx, y: point.y })),
  slots: panel.slots.map(point => ({ ...point, x: point.x + dx })),
  round_holes: panel.round_holes.map(point => ({ ...point, x: point.x + dx })),
  edge_holes: panel.edge_holes.map(point => ({ ...point, x: point.x + dx })),
  cutouts: panel.cutouts?.map(hole => hole.map(point => ({ x: point.x + dx, y: point.y }))),
})

function assemblySvg(layout: SpatialLayout, name: string): string {
  const ends = layout.faces.flatMap(face => [faceToWorld(face, 0, 0), faceToWorld(face, face.width, 0)])
  const xs = ends.map(point => point[0]), ys = ends.map(point => -point[2])
  const minX = Math.min(...xs), minY = Math.min(...ys)
  const scale = Math.min(500 / Math.max(1, Math.max(...xs) - minX), 290 / Math.max(1, Math.max(...ys) - minY))
  const point = (x: number, y: number) => [50 + (x - minX) * scale, 55 + (y - minY) * scale]
  const esc = (value: string) => value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]!)
  const colors = ['#5cc9b2', '#f1c269', '#b4a6e6']
  const faces = layout.faces.map((face, index) => {
    const a = point(face.origin[0], -face.origin[2])
    const b = faceToWorld(face, face.width, 0)
    const end = point(b[0], -b[2])
    const center = [(a[0] + end[0]) / 2 - face.normal[0] * 24,
      (a[1] + end[1]) / 2 + face.normal[2] * 24]
    return `<line x1="${a[0]}" y1="${a[1]}" x2="${end[0]}" y2="${end[1]}" stroke="${colors[index % colors.length]}" stroke-width="12" stroke-linecap="round"/><text x="${center[0]}" y="${center[1]}" fill="#e9f5f3" text-anchor="middle" font-size="14">${face.id} · ${face.width.toFixed(1)} mm</text>`
  }).join('')
  const joints = layout.junctions.map((junction, index) => {
    const face = layout.faces.find(item => item.id === junction.from)!
    const end = faceToWorld(face, face.width, 0)
    const [x, y] = point(end[0], -end[2])
    return `<circle cx="${x}" cy="${y}" r="6" fill="#fff"/><text x="${x + 10}" y="${y + 20}" fill="#fff" font-size="13">J${index + 1} ${junction.angleDegrees.toFixed(1)}°</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 420" width="600" height="420"><rect width="600" height="420" fill="#152025"/><text x="26" y="28" fill="#fff" font-size="18">${esc(name)} · 立体装配俯视</text>${faces}${joints}<text x="26" y="389" fill="#c8d6d4" font-size="12">面号与 J 转角对应装配数据；连接件和开孔状态以本次导出为准，先试装再使用。</text><text x="574" y="409" text-anchor="end" fill="#b2d9d2" font-family="sans-serif" font-size="11">${SNAPBOARD_PUBLICATION_NOTICE} · snapboard.cn</text></svg>`
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('立体制造已取消', 'AbortError')
}

export async function createSpatialManufacturing3MF(input: SpatialManufacturingInput): Promise<Manufacturing3MFSummary> {
  checkAbort(input.signal)
  const order = input.orderEngraving
  if (order) {
    validateOrderEngravingPlan(order)
    if(input.assemblyMarking?.orderSideNumber && input.assemblyMarking.orderSideNumber!==order.orderNumber)throw new Error('侧刻订单号与关联生产订单不一致')
    input = { ...input, projectName: order.orderNumber }
  }
  const plan = resolveSpatialManufacturing(input.layout, input.cfg)
  if (plan.error) throw new Error(plan.error)
  const { layout, mode } = plan
  const connector = mode !== 'monolithic' && input.layout.printedAngleConnector
  input.onProgress?.('正在生成立体板件及固定孔…', 0.08)
  const pieces = await createSpatialPanels(layout, plan.printCfg, mode, connector, input.signal,
    (done, total) => input.onProgress?.(`正在按热床切分 ${done}/${total} 个面`, 0.08 + 0.28 * done / total), input.layout)
  const printConnector = connector && spatialConnectorMountsOpen(layout, pieces)
  checkAbort(input.signal)
  const name = safeFileName(input.projectName)
  const warnings: string[] = []
  const catalog=(panels:Array<{code:string;quantity:number;widthMm:number;heightMm:number;depthMm?:number;sourcePanelId:string}>,kitQuantity=1)=>({
    format:'snapboard-manufacturing-catalog',schemaVersion:1,kitQuantity,
    product:{layoutCode:layout.template==='prism' ? input.layout.polygonSides===3 ? 'T' : '' : ['L','U'].includes(layout.template) ? layout.template : '',
      mappingCode:'M0',colourCode:'C00',widthMm:layout.faces[0].width,heightMm:layout.faces[0].height,thicknessMm:input.cfg.thickness,material:'PETG'},panels})
  if (input.cfg.printerPreset === 'custom') warnings.push('自定义热床仅用于 SnapBoard 几何校验；导入切片器后须手动选择实际打印机与工艺配置。')
  if (connector && !printConnector) warnings.push('部分定角连接件固定孔已关闭；本次只导出板件，请使用匹配孔位的自绘连接件。')
  if (mode === 'monolithic') {
    const sections = splitSpatialHeight(layout, pieces, plan.printHeight, plan.printCfg)
    const files: Record<string, Uint8Array> = {}
    const printParts: Array<{ id: string; section: number; heightOffsetMm: number;
      bounds: ReturnType<import('manifold-3d').Manifold['boundingBox']>; file: string;
      holes: Array<{ face: string; unfoldedXmm: number; heightMm: number; through: boolean }> }> = []
    let sourcePartCount = 0, bundleBytes = 0
    const engravedInstances = new Set<number>()
    for (const section of sections) {
      checkAbort(input.signal)
      input.onProgress?.(`正在生成立体分节 ${section.index + 1}/${sections.length}`, 0.38 + 0.55 * section.index / sections.length)
      const { solid, wasm } = await createOnePieceSolid(section.layout, section.panels, plan.printCfg, input.layout)
      try {
        const parts = splitSolidForPrint(solid, plan.printCfg, input.layout, wasm, section.panels, section.offsetY)
        try {
          for (const part of parts) {
            const id = `M${String(++sourcePartCount).padStart(2, '0')}`
            const instances = order ? order.panels.filter(instance => instance.sourcePanelId === id) : [undefined]
            if (!instances.length) throw new Error(`${id} 不在已确认订单的制造清单中，请重新保存订单`)
            for (const instance of instances) {
            const box = part.solid.boundingBox()
            if (instance && (Math.abs(instance.widthMm - (box.max[0] - box.min[0])) > .02 ||
              Math.abs(instance.heightMm - (box.max[1] - box.min[1])) > .02 || instance.depthMm === undefined ||
              Math.abs(instance.depthMm - (box.max[2] - box.min[2])) > .02)) throw new Error(`${id} 与已确认订单的立体制造尺寸不符`)
            const label = sections.length > 1 ? `${name}-第${String(section.index + 1).padStart(2, '0')}节${parts.length > 1 ? `-${id}` : ''}` : `${name}-${id}`
            const traced = instance && order ? engraveSpatialOrderSolid(part.solid, part.faces, plan.printCfg, wasm, order, instance, input.assemblyMarking) : input.assemblyMarking?.orderSideNumber ? engraveSpatialSideNumber(part.solid,part.faces,plan.printCfg,wasm,input.assemblyMarking.orderSideNumber,input.assemblyMarking) : null
            const traceLabel = instance ? `${order!.orderNumber}-R${order!.revision}-${instance.panelCode}-${instance.instanceIndex}of${order!.totalPanelCount}` : label
            const file = instance ? `套${String(instance.setIndex).padStart(2, '0')}/${traceLabel}.3mf`
              : `${sections.length > 1 ? '高度分节' : '空间切分'}/${label}.3mf`
            try {
              const model = manifoldToPrinterMesh(traced ?? part.solid, plan.printCfg, traceLabel)
              files[file] = writeSpatial3MF([model], order?.orderNumber ?? input.projectName, {
                'Metadata/snapboard-manufacturing-catalog.json':strToU8(JSON.stringify(catalog([{code:instance?.panelCode || 'P01',quantity:1,
                  widthMm:box.max[0]-box.min[0],heightMm:box.max[1]-box.min[1],depthMm:box.max[2]-box.min[2],sourcePanelId:id}]))),
                ...(instance && order ? { 'Metadata/snapboard-order-engraving.json': strToU8(JSON.stringify(orderTraceMetadata(order, [instance]))) } : {}),
                ...(!order && input.assemblyMarking?.orderSideNumber?{'Metadata/snapboard-order-side-number.json':strToU8(JSON.stringify({format:'snapboard-order-side-number',schemaVersion:1,surface:'side',operation:'engrave',orderNumber:input.assemblyMarking.orderSideNumber,sourceOrderId:input.assemblyMarking.orderSideSourceId,appliedPanelCount:1}))}:{})}, input.cfg)
              bundleBytes += files[file].byteLength
              if (bundleBytes > 256 * 1024 * 1024) throw new Error('立体订单制造 ZIP 超过 256 MB 安全上限，请拆为较小生产批次')
              if (instance) engravedInstances.add(instance.instanceIndex)
            } finally { traced?.delete() }
            printParts.push({ id, section: section.index + 1, heightOffsetMm: section.offsetY, bounds: part.solid.boundingBox(), file,
              holes: part.faces.flatMap(({ face, panel }) => panel.edge_holes.map(hole => ({ face: face.id,
                unfoldedXmm: face.phaseU + hole.x, heightMm: hole.y + section.offsetY, through: !!hole.knocked }))) })
            if (!order && parts.length === 1 && sections.length === 1) {
              return { data: files[file], fileName: `${name}-立体${layout.template}-一体.3mf`, plateCount: 1,
                panelCount: 1, partCount: 0, sampleCount: 0, samplePlateCount: 0,
                uniqueObjectCount: 1, markingRequestedCount: 0, markingAppliedCount: 0,
                warnings: [...warnings, '一体板件已形成单个闭合实体；转角层向强度与悬垂仍需切片和实打印检查。'] }
            }
            }
          }
        } finally { parts.forEach(part => part.solid.delete()) }
      } finally { solid.delete() }
    }
    if (order) {
      if (engravedInstances.size !== order.totalPanelCount) throw new Error('订单立体件清单没有全部生成独立凹刻实例，已停止整单导出')
      files['订单制造追溯.json'] = strToU8(JSON.stringify(orderTraceMetadata(order), null, 2))
    }
    const hasHorizontalSplit = sourcePartCount > sections.length
    const grouped=new Map<string,{code:string;quantity:number;widthMm:number;heightMm:number;depthMm:number;sourcePanelId:string}>()
    for(const part of printParts) {
      const previous=grouped.get(part.id)
      if(previous)previous.quantity++
      else grouped.set(part.id,{code:order?.panels.find(p=>p.sourcePanelId===part.id)?.panelCode || `P${String(grouped.size+1).padStart(2,'0')}`,
        quantity:1,widthMm:part.bounds.max[0]-part.bounds.min[0],heightMm:part.bounds.max[1]-part.bounds.min[1],depthMm:part.bounds.max[2]-part.bounds.min[2],sourcePanelId:part.id})
    }
    files['制造信息.json']=strToU8(JSON.stringify(catalog([...grouped.values()].map(p=>({...p,quantity:p.quantity/(order?.kitQuantity || 1)})),order?.kitQuantity || 1)))
    if (sections.length > 1) {
      files['立体高度分节.json'] = strToU8(JSON.stringify({
        format: 'snapboard-spatial-height-sections', version: 1, units: 'millimeter',
        template: layout.template, connection: hasHorizontalSplit ? 'split-folded-solids-per-section' : 'one-piece-bend-per-section',
        totalHeightMm: layout.faces[0].height, safePrintHeightMm: plan.printHeight,
        sections: sections.map(section => ({ index: section.index + 1,
          offsetYmm: section.offsetY, heightMm: section.height })),
        betweenSectionConnector: 'user-supplied-pending',
      }, null, 2))
    }
    files['立体制造分件.json'] = strToU8(JSON.stringify({ format: 'snapboard-spatial-print-parts', version: 1,
      units: 'millimeter', safePrintHeightMm: plan.printHeight, usableBed: plan.printBounds,
      faces: layout.faces, parts: printParts, connector: 'user-supplied-pending' }, null, 2))
    files['立体装配俯视图.svg'] = strToU8(assemblySvg(layout, input.projectName))
    warnings.push(`已按安全打印空间拆为 ${printParts.length} 个独立立体件，每件单独 3MF；分件间连接件待适配。`)
    input.onProgress?.('立体制造分件已生成', 1)
    return { data: zipSync(files), fileName: order ? `${order.orderNumber}-R${order.revision}-立体订单制造.zip`
      : `${name}-立体${layout.template}-${sections.length > 1 && !hasHorizontalSplit ? '高度分节' : '空间切分'}.zip`,
      plateCount: printParts.length, panelCount: printParts.length, partCount: 0,
      sampleCount: 0, samplePlateCount: 0, uniqueObjectCount: printParts.length,
      markingRequestedCount: 0, markingAppliedCount: 0, warnings }
  }

  input.onProgress?.(`正在制作 ${pieces.length} 块平放板件…`, 0.45)
  const flatPanels = pieces.map(({ face, panel }) => shiftPanel(panel, face.phaseU + layout.faces.indexOf(face) * 40))
  let base: Manufacturing3MFSummary | undefined
  try {
  base = await createManufacturing3MF({
    panels: flatPanels, cfg: { ...plan.printCfg, cornerRadius: 0 }, placedParts: [],
    boardTexture: createDefaultBoardTexture(), assemblyMarking: input.assemblyMarking,
    orderEngraving: order,
    projectName: input.projectName, projectVersion: input.projectVersion,
    outputMode: 'single', signal: input.signal,
    onProgress: (message, progress) => input.onProgress?.(message, 0.45 + 0.35 * (progress ?? 0)),
  })
  checkAbort(input.signal)
  const boardData = base.streamedFile ? new Uint8Array(await base.streamedFile.arrayBuffer()) : base.data
  const map = {
    format: 'snapboard-spatial-assembly', version: 1, units: 'millimeter',
    template: layout.template, mode, thickness: layout.thickness,
    printer: { preset: input.cfg.printerPreset, bedW: input.cfg.bedW, bedH: input.cfg.bedH,
      safetyMarginMm: input.layout.printSafetyMarginMm,
      usableBedW: plan.printBounds.width, usableBedH: plan.printBounds.height,
      usableHeight: plan.printHeight },
    faces: layout.faces.map(face => ({ id: face.id, width: face.width, height: face.height,
      origin: face.origin, u: face.u, normal: face.normal,
      panelIds: pieces.filter(piece => piece.face.id === face.id).map(piece => piece.panel.id) })),
    junctions: layout.junctions.map(junction => ({ ...junction,
      connector: printConnector ? 'one-piece-printed-angle-M3' : 'user-supplied',
      quantity: printConnector ? (layout.faces[0].height >= 100 ? 2 : 1) : 0,
      mounts: printConnector ? {
        fromEdgeInsetMm: 20, toEdgeInsetMm: 20,
        heightCentersMm: layout.faces[0].height >= 100 ? [25, layout.faces[0].height - 25] : [layout.faces[0].height / 2],
        boardHoleDiameterMm: input.cfg.jointDiameter, connectorHoleDiameterMm: 3.4,
        m3NutPocketAcrossFlatsMm: 5.5 + 2 * input.layout.connectorClearanceMm,
      } : undefined })),
    hardware: printConnector ? '每件连接件配 2 套 M3 螺栓、螺母和垫片；实物试装确认长度与锁紧效果' : undefined,
  }
  const files: Record<string, Uint8Array> = {
    [order ? `${order.orderNumber}-平放订单.zip` : `${name}-平放板件.3mf`]: boardData,
    '立体装配数据.json': strToU8(JSON.stringify(map, null, 2)),
    '立体装配俯视图.svg': strToU8(assemblySvg(layout, input.projectName)),
  }
  const flatCatalog=order ? orderManufacturingCatalog(flatPanels,input.cfg,undefined,order) : manufacturingCatalog(flatPanels,input.cfg)
  files['制造信息.json']=strToU8(JSON.stringify(catalog(flatCatalog.panels,flatCatalog.kitQuantity)))
  if (order) files['订单制造追溯.json'] = strToU8(JSON.stringify(orderTraceMetadata(order), null, 2))
  if (printConnector) {
    input.onProgress?.('正在生成定角 M3 连接件…', 0.84)
    const wasm = await spatialManifold()
    for (let index = 0; index < layout.junctions.length; index++) {
      checkAbort(input.signal)
      const junction = layout.junctions[index]
      const bracket = createPrintedAngleConnector(wasm, junction.angleDegrees,
        input.cfg.thickness, input.layout.connectorClearanceMm)
      try {
        const model = manifoldToPrinterMesh(bracket, plan.printCfg,
          `J${index + 1}-定角${junction.angleDegrees.toFixed(1)}-M3`)
        const data = writeSpatial3MF([model], input.projectName, {}, input.cfg)
        const count = layout.faces[0].height >= 100 ? 2 : 1
        for (let copy = 1; copy <= count * (order?.kitQuantity ?? 1); copy++) files[`连接件/J${index + 1}-${copy}.3mf`] = data
      } finally { bracket.delete() }
    }
    warnings.push('定角连接件按每条转角的内角一体打印；M3 五金需另备，孔位与承重尚需试装。')
  }
  if (mode === 'bed-split') warnings.push(`当前热床将 ${layout.faces.length} 个侧面切成 ${pieces.length} 块；请按装配图确认同面接缝和转角。`)
  input.onProgress?.('正在封装立体板件与连接件…', 0.95)
  const data = zipSync(files)
  return { ...base, data, streamedFile: undefined, cleanup: undefined,
    fileName: order ? `${order.orderNumber}-R${order.revision}-立体订单制造.zip`
      : `${name}-立体${layout.template}-${mode === 'bed-split' ? '热床切分' : '按面分件'}.zip`,
    panelCount: order?.totalPanelCount ?? pieces.length, warnings: [...base.warnings, ...warnings] }
  } finally { await base?.cleanup?.() }
}
