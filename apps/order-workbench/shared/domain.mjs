export const BACKUP_FORMAT = 'snapboard-orders-backup'
export const MARK_PLAN_FORMAT = 'snapboard-order-mark-plan'
export const SCHEMA_VERSION = 1
export const STATUS_LABELS = {
  draft: '待确认', confirmed: '待生产', producing: '生产中', ready: '待发货', shipped: '已发货', completed: '已完成', cancelled: '已取消',
}
export const STATUS_TRANSITIONS = {
  draft: ['confirmed', 'cancelled'], confirmed: ['producing', 'draft', 'cancelled'],
  producing: ['ready', 'cancelled'], ready: ['shipped', 'producing', 'cancelled'],
  shipped: ['completed'], completed: [], cancelled: [],
}
export const CODE_KINDS = { layout: '版面形态', mapping: '表面方式', colour: '色彩模式' }
export const DEFAULT_CODES = [
  ['layout', 'F', '平面板', '在同一平面内的板件组合'],
  ['layout', 'L', 'L 型', '带一个转角的立体版面'],
  ['layout', 'U', 'U 型', '带两个转角的立体版面'],
  ['layout', 'T', '三棱柱', '三面围合的立体版面'],
  ['mapping', 'M0', '无彩印', '只制造结构板体'],
  ['mapping', 'M1', '单面彩印', '正面彩色薄层'],
  ['mapping', 'M2', '双面彩印', '正背面独立彩色薄层'],
  ['mapping', 'MV', '材质贴面', '单卷材料贴面'],
  ['mapping', 'MW', '木纹贴面', '普通基材 + 薄仿木层；逐板算法纹路'],
  ['colour', 'C00', '无叠色', '无彩印或单卷贴面'],
  ['colour', 'C01', 'RYBW', '红 / 黄 / 蓝 / 白'],
  ['colour', 'C02', 'CMYW', '青 / 品红 / 黄 / 白'],
  ['colour', 'C03', '黑白', '黑 / 白'],
  ['colour', 'C04', '5 色', '白 / 红 / 黄 / 蓝 / 黑'],
  ['colour', 'C05', '6 色', '白 / 青 / 品红 / 绿 / 黄 / 黑'],
  ['colour', 'C06', '8 色', '白 / 青 / 品红 / 黄 / 黑 / 红 / 蓝 / 绿'],
].map(([kind, code, label, description]) => ({ kind, code, label, description }))

/** MW keeps its frozen codebook meaning; new choices use the material veneer category. */
export const codeChoices = (codes, kind, selected = '') => codes.filter(entry => entry.kind === kind && (kind !== 'mapping' || entry.code !== 'MW' || selected === 'MW'))
export const codeLabel = entry => entry?.code === 'MW' && (!entry.kind || entry.kind === 'mapping') ? '材质贴面 · 木纹（历史）' : entry?.label

export function businessDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
export function text(value, name, max = 200, required = false) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new Error(`${name}必须是文字`)
  const result = (value ?? '').trim()
  if (required && !result) throw new Error(`请填写${name}`)
  const invalidControl = Array.from(result).some(char => char.charCodeAt(0) < 32 && ![9,10,13].includes(char.charCodeAt(0)))
  if (result.length > max || invalidControl) throw new Error(`${name}过长或包含无效字符`)
  return result
}
export function number(value, name, min, max, integer = false) {
  if (!['string','number'].includes(typeof value)) throw new Error(`${name}必须是数值`)
  if (value === '' || value === null || value === undefined) throw new Error(`请填写${name}`)
  const result = Number(value)
  if (!Number.isFinite(result) || result < min || result > max || integer && !Number.isInteger(result)) throw new Error(`${name}应为 ${min}–${max}${integer ? ' 的整数' : ''}`)
  return result
}
export function normalizeCustomer(value) {
  if (!value || typeof value !== 'object') throw new Error('客户资料无效')
  return { name: text(value.name, '客户姓名或昵称', 80, true), phone: text(value.phone, '联系方式', 80),
    address: text(value.address, '收货地址', 1000), notes: text(value.notes, '客户备注', 2000) }
}
export function normalizeOrder(value, codes) {
  if (!value || typeof value !== 'object') throw new Error('订单数据无效')
  const customer = normalizeCustomer(value.customer)
  const selected = (kind, code) => {
    const entry = codes.find(item => item.kind === kind && item.code === code)
    if (!entry) throw new Error(`${CODE_KINDS[kind]}编码不存在，请从编码字典选择`)
    return { code: entry.code, label: entry.label, description: entry.description }
  }
  const source = value.product ?? {}
  const product = {
    name: text(source.name, '产品名称', 120, true),
    layout: selected('layout', source.layoutCode), mapping: selected('mapping', source.mappingCode), colour: selected('colour', source.colourCode),
    thicknessMm: number(source.thicknessMm, '板厚', .5, 100),
    widthMm: number(source.widthMm, '版面宽度', value.panels?.length ? 1 : 0, 1_000_000), heightMm: number(source.heightMm, '版面高度', value.panels?.length ? 1 : 0, 1_000_000),
    material: text(source.material, '材料', 120), profile: text(source.profile, '校色档案 / 批次', 200),
    projectFile: text(source.projectFile, '工程文件名', 240), notes: text(source.notes, '生产备注', 3000),
  }
  if (['M0', 'MV', 'MW'].includes(product.mapping.code) && product.colour.code !== 'C00') throw new Error('无彩印、材质贴面或木纹走线请选择“无叠色”')
  if (['M1', 'M2'].includes(product.mapping.code) && product.colour.code === 'C00') throw new Error('彩印订单需要选择色彩模式')
  const kitQuantity = number(value.kitQuantity, '套数', 1, 9999, true)
  if (!Array.isArray(value.panels) || value.panels.length > 5000) throw new Error('板件清单无效（最多 5000 种板件）；未设计可保存空清单草稿')
  const seen = new Set()
  const panels = value.panels.map((row, index) => {
    const code = text(row.code, `第 ${index + 1} 行板件编号`, 8, true).toUpperCase()
    if (!/^P\d{2,5}$/.test(code) || Number(code.slice(1)) < 1) throw new Error('板件编号使用 P01、P02 等格式，从 P01 开始')
    const canonical = Number(code.slice(1))
    if (seen.has(canonical)) throw new Error(`板件编号 ${code} 重复，请合并数量或修改编号`)
    seen.add(canonical)
    return { code: `P${String(canonical).padStart(2, '0')}`, quantity: number(row.quantity, `${code} 每套数量`, 1, 100_000, true),
      widthMm: number(row.widthMm, `${code} 宽度`, 1, 1_000_000), heightMm: number(row.heightMm, `${code} 高度`, 1, 1_000_000),
      ...(row.depthMm === undefined ? {} : { depthMm: number(row.depthMm, `${code} 深度`, .1, 1_000_000) }),
      notes: text(row.notes, `${code} 备注`, 400), sourcePanelId: text(row.sourcePanelId, `${code} 原工程板件 ID`, 200) }
  })
  const perSetPanelCount = panels.reduce((total, panel) => total + panel.quantity, 0)
  const totalPanelCount = perSetPanelCount * kitQuantity
  if (totalPanelCount > 100_000) throw new Error('单笔订单超过 100000 块，请拆成多个生产批次')
  const dueDate = text(value.dueDate, '交付日期', 10)
  if (dueDate && !validDate(dueDate)) throw new Error('交付日期无效')
  const designFingerprint = text(value.designFingerprint, '工程制造指纹', 64)
  if (designFingerprint && !/^[a-f0-9]{64}$/.test(designFingerprint)) throw new Error('工程制造指纹无效')
  return { customer, product, panels, kitQuantity, perSetPanelCount, totalPanelCount, dueDate,
    ...(designFingerprint ? { designFingerprint } : {}),
    notes: text(value.notes, '订单备注', 4000), shipping: { carrier: text(value.shipping?.carrier, '物流公司', 100), tracking: text(value.shipping?.tracking, '运单号', 100) } }
}
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
export function checksum(source) {
  let result = 0
  for (const char of source) result = (result * 31 + char.charCodeAt(0)) % 1296
  return result.toString(36).toUpperCase().padStart(2, '0')
}
export function productionCode(orderNumber, revision, order) {
  const base = `${orderNumber.replace('SB-', 'SB1-')}-${order.product.layout.code}-${order.product.mapping.code}-${order.product.colour.code}-N${String(order.totalPanelCount).padStart(3, '0')}-Q${String(order.kitQuantity).padStart(2, '0')}-R${String(revision).padStart(2, '0')}`
  return `${base}-${checksum(base)}`
}
export function parseProductionCode(input) {
  const source = text(input, '生产编码', 180, true).toUpperCase()
  const match = source.match(/^SB1-(\d{8})-(\d{4})-([A-Z][A-Z0-9]{0,5})-([A-Z][A-Z0-9]{0,5})-([A-Z][A-Z0-9]{0,5})-N(\d{3,6})-Q(\d{2,4})-R(\d{2,6})-([A-Z0-9]{2})$/)
  if (!match) throw new Error('生产编码格式不正确')
  const [, day, sequence, layout, mapping, colour, total, quantity, revision, check] = match
  if (!validDate(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`) || Number(sequence) < 1 || Number(quantity) < 1 || Number(revision) < 1) throw new Error('生产编码中的日期或数量无效')
  if (checksum(source.slice(0, -3)) !== check) throw new Error('生产编码校验未通过，请检查是否输错')
  return { orderNumber: `SB-${day}-${sequence}`, revision: Number(revision), layout, mapping, colour, totalPanelCount: Number(total), kitQuantity: Number(quantity), checksum: check }
}
export function markingKey(orderNumber) {
  const match = orderNumber.match(/^SB-(\d{8})-(\d{4})$/)
  if (!match) throw new Error('订单号无效')
  return `${match[1].slice(2)}${match[2]}`
}
export function manufacturingSnapshot(order) {
  return { product: order.product, panels: order.panels, kitQuantity: order.kitQuantity,
    ...(order.designFingerprint ? { designFingerprint: order.designFingerprint } : {}),
    perSetPanelCount: order.perSetPanelCount, totalPanelCount: order.totalPanelCount }
}
export function panelMarkLines(key, revision, code, index, total) {
  return [key, `R${String(revision).padStart(2, '0')}-${code}`, `${index}/${total}`]
}
export function panelInstance(snapshot, index) {
  number(index, '实物序号', 1, snapshot.totalPanelCount, true)
  let localIndex = (index - 1) % snapshot.perSetPanelCount
  for (const panel of snapshot.panels) {
    if (localIndex < panel.quantity) return { panel, setIndex: Math.floor((index - 1) / snapshot.perSetPanelCount) + 1, copy: localIndex + 1 }
    localIndex -= panel.quantity
  }
  throw new Error('实物序号与板件清单不一致')
}
export function buildMarkPlan(order, snapshot = order, revision = order.revision) {
  if (!snapshot.totalPanelCount) throw new Error('此修订尚无板件，不能导出制造凹刻清单')
  const panels = []
  let globalIndex = 0
  for (let setIndex = 1; setIndex <= snapshot.kitQuantity; setIndex++) for (const panel of snapshot.panels) for (let copy = 1; copy <= panel.quantity; copy++) {
    globalIndex++
    panels.push({ panelCode: panel.code, setIndex, copy, instanceIndex: globalIndex, sourcePanelId: panel.sourcePanelId,
      widthMm: panel.widthMm, heightMm: panel.heightMm,
      ...(panel.depthMm === undefined ? {} : { depthMm: panel.depthMm }),
      lines: [order.number] })
  }
  return { format: MARK_PLAN_FORMAT, schemaVersion: SCHEMA_VERSION, orderNumber: order.number, revision,
    productionCode: productionCode(order.number, revision, snapshot), markingKey: order.markingKey,
    placement: { surface: 'side', operation: 'engrave', content: 'order-number', textHeightMm: 3.5, depthMm: .24 },
    manufacturing: manufacturingSnapshot(snapshot), panels }
}

/** Read metadata only; keep images, geometry and customer data out of this adapter. */
export function summarizeSnapBoardProject(input, filename, { allowEmpty = false } = {}) {
  if (!input || input.format !== 'snapboard-project' || input.schemaVersion !== 1 || !input.workspace) throw new Error('请使用有效的 .snapboard 工程（schemaVersion 1）')
  const workspace = input.workspace
  const list = workspace.splitResult?.panels ?? []
  if (!Array.isArray(list) || !allowEmpty && !list.length) throw new Error('工程尚无分板结果，请先在设计器生成板件后保存')
  const texture = workspace.boardTexture ?? {}
  const colour = /cmyw/.test(texture.lutId) ? 'C02' : /(?:^|-)bw$/.test(texture.lutId) ? 'C03'
    : /5color/.test(texture.lutId) ? 'C04' : /6color/.test(texture.lutId) ? 'C05' : /8color/.test(texture.lutId) ? 'C06' : /rybw/.test(texture.lutId) ? 'C01' : ''
  const woodgrain = texture.enabled && texture.surfaceMode === 'woodgrain'
  const mappingCode = !texture.enabled ? 'M0' : woodgrain || texture.surfaceMode === 'veneer' ? 'MV' : texture.backEnabled ? 'M2' : 'M1'
  const { source: woodSource, ...woodConfig } = texture.woodGrain ?? {}
  if (woodSource) woodConfig.source = { name: woodSource.name, sha256: woodSource.sha256, author: woodSource.author, license: woodSource.license }
  const minX = Math.min(...list.map(p => Number(p.x))), minY = Math.min(...list.map(p => Number(p.y)))
  const maxX = Math.max(...list.map(p => Number(p.x) + Number(p.w))), maxY = Math.max(...list.map(p => Number(p.y) + Number(p.h)))
  const spatial = workspace.spatialLayout
  const shape = spatial?.enabled ? String(spatial.template ?? '').toLowerCase() : ''
  const layoutCode = !spatial?.enabled ? 'F' : shape === 'l' ? 'L' : shape === 'u' ? 'U' : shape === 'prism' && (spatial.polygonSides ?? 3) === 3 ? 'T' : ''
  return { product: { name: workspace.project?.metadata?.name || filename.replace(/\.snapboard$/i, ''), layoutCode, mappingCode,
    colourCode: ['M0', 'MV', 'MW'].includes(mappingCode) ? 'C00' : colour,
    thicknessMm: workspace.splitConfig?.thickness ?? 5, widthMm: list.length ? maxX - minX : 0, heightMm: list.length ? maxY - minY : 0,
    material: woodgrain ? `${texture.baseMaterialName || '普通基材'} + ${texture.surfaceMaterialName || '仿木贴面'} (${texture.woodGrain?.filamentType || 'PETG'})` : texture.baseMaterialName || 'PETG',
    profile: woodgrain ? 'woodgrain-veneer-v2' : texture.lutId || '', projectFile: filename,
    notes: woodgrain ? `木纹制造参数：${JSON.stringify({...woodConfig,surfaceThicknessMm:texture.textureThickness,baseInfillDensity:texture.baseInfillDensity})}` : '' },
    panels: list.map((panel, index) => ({ code: `P${String(index + 1).padStart(2, '0')}`, quantity: 1,
      widthMm: panel.w, heightMm: panel.h, sourcePanelId: panel.id ?? '', notes: '' })),
    warning: [!list.length ? '工程尚未生成板件，可先保存订单草稿；生成板件后再保存订单以更新清单。' : '',
      spatial?.enabled ? '已读取展开面的板件清单；立体制造分件请按实际导出结果核对，首版不调用设计器制造引擎。' : '',
      !layoutCode ? '此立体形态尚无默认编码，请登记对应的形态编码后选择，不能按平面或三棱柱自动登记。' : '',
      !colour && ['M1','M2'].includes(mappingCode) ? '自定义校色档案无法仅凭 ID 确认色彩模式，请手动选择后保存。' : ''].filter(Boolean).join(' ') }
}
