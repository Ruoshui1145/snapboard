// ============ 零件库类型定义 ============

/**
 * 配件大类 (参考 IKEA SKÅDIS 配件系列与常见洞洞板配件清单划分):
 * 挂钩 / 支架托架 / 搁板层板 / 收纳容器 / 整理件 / 紧固锁扣 / 底座安装 / 线缆整理 / 自定义
 */
export type PartCategory =
  | 'hook' | 'bracket' | 'shelf' | 'bin' | 'organizer'
  | 'fastener' | 'base' | 'cable' | 'custom'

/** 大类字典 (下拉、分类标签、文件夹拖入自动归类共用) */
export const PART_CATEGORY_OPTIONS: Array<{ id: PartCategory; label: string; hint: string }> = [
  { id: 'hook', label: '挂钩', hint: 'S 型/J 型/双钩、长柄钩、工具钩' },
  { id: 'bracket', label: '支架/托架', hint: 'L 形支架、角铁、横杆架、搁板托' },
  { id: 'shelf', label: '搁板/层板', hint: '置物板、展示层、隔板' },
  { id: 'bin', label: '收纳容器', hint: '收纳盒、笔筒、工具杯、托盘、储物篮' },
  { id: 'organizer', label: '整理件', hint: '钥匙扣、卡夹、瓶罐架、纸巾架、工具整理' },
  { id: 'fastener', label: '紧固/锁扣', hint: '弹性锁扣、卡扣、橡胶圈、螺丝固定件' },
  { id: 'base', label: '底座/安装', hint: '墙面底座、长孔挂扣、圆孔紧固、板间连接件' },
  { id: 'cable', label: '线缆整理', hint: '理线夹、线盘、线缆槽、插头挂架' },
  { id: 'custom', label: '自定义', hint: '其他未归类配件' },
]

/** 大类 → 配件资源包顶层文件夹（“自定义”走“我的配件”包；文件夹可先手动创建或拖入自动建） */
export const PART_CATEGORY_FOLDER: Record<PartCategory, string> = {
  hook: '01-挂钩类',
  bracket: '02-支架托架类',
  shelf: '03-搁板层板类',
  bin: '04-收纳容器类',
  organizer: '05-整理件类',
  fastener: '06-紧固锁扣类',
  base: '07-底座安装类',
  cable: '08-线缆整理类',
  custom: '',
}

export type PartModelFormat = 'glb' | 'gltf' | '3mf' | 'stl' | 'step' | 'stp'
export type PartUnit = 'millimeter' | 'centimeter' | 'meter' | 'inch'
export type MountHoleKind = 'slot' | 'round'

export interface PartParamDef {
  id: string
  label: string
  type: 'number' | 'select'
  min?: number
  max?: number
  step?: number
  default: number | string
  options?: string[]
}

export interface PartMountAnchor {
  id: string
  label?: string
  accepts: Array<MountHoleKind | 'either'>
  /** 零件局部坐标，单位与 model.unit 一致 */
  position: [number, number, number]
  /** 标定端面的插入方向（SnapBoard 模型局部坐标） */
  normal?: [number, number, number]
  /** 长圆孔锚点的长轴方向（零件局部安装面内单位向量 X/Y，仅 slot 锚点有）。
   *  吸附时与板面长圆孔长轴做定向校验，防止 90° 旋转把椭圆/圆孔对角线调换。 */
  axis?: [number, number]
  required?: boolean
}

export interface PartMountDefinition {
  mode: 'single' | 'multi' | 'edge' | 'free'
  anchors: PartMountAnchor[]
  /** 接触面: 标定时点选的、与板面贴合的端面 (零件局部 z 坐标 mm)。
   *  装配时接触面与板面贴合, 锚点只负责 XY 孔位对齐; 未设置时退回锚点平面贴合。 */
  contactZ?: number
  /** 已上传模型但尚未在装配校准器中确认局部锚点 */
  calibrationRequired?: boolean
  /** 上传槽位预期使用的孔型，校准前用于 UI 提示 */
  expected?: MountHoleKind[]
}

export interface PartModelAssets {
  /** 网页运行时模型，相对 public/partLibrary */
  preview?: string
  /** 切片/制造模型 */
  print?: string
  /** STEP/SLDPRT 等可编辑源文件，只归档不在运行时加载 */
  source?: string
  format?: PartModelFormat
  unit?: PartUnit
  upAxis?: 'x' | 'y' | 'z'
  scale?: number
  /** 用户在配件标定器中确认的默认朝向，XYZ 欧拉角，单位为度 */
  orientation?: [number, number, number]
  /** 制造排盘朝向，XYZ 欧拉角，单位为度；缺省时导出器自动让最薄轴朝上。 */
  printOrientation?: [number, number, number]
  /** 导入时读取的模型包围盒尺寸，统一换算为毫米 (X/Y/Z)。 */
  dimensionsMm?: [number, number, number]
  /** 多对象 3MF/GLTF 只渲染指定顶层对象的子路径；为空表示渲染完整模型。 */
  renderNode?: string
  /** 配件实装示例图，相对 public/partLibrary。 */
  usageImage?: string
  /** 资产大预览中保存的缩略图相机方向（从模型中心指向相机的单位向量）。 */
  previewDirection?: [number, number, number]
  /** v0.1 旧索引兼容字段 */
  glb?: string
  stl?: string
}

/** 零件定义 (固定网格或参数化生成器 + 装配锚点) */
export interface PartDefinition {
  /** 运行时全局 ID：packageId:localId */
  id: string
  localId?: string
  pack?: string
  packageId?: string
  packageVersion?: string
  author?: string
  category: PartCategory
  /** 大类下的用户自定义细分文件夹，例如“直钩”“双钩”“工具钩”。 */
  subcategory?: string
  /** 分类内持久化序号；外部导入自动追加，网页拖动排序后写回 part.json。 */
  sortOrder?: number
  name: string
  description?: string
  kind?: 'fixed' | 'parametric'
  params: PartParamDef[]
  model: PartModelAssets
  /** 安装方式 */
  mount: PartMountDefinition | 'hole' | 'edge' | 'free'
  /** 默认朝向 (在板上的旋转) */
  defaultRotation: number
  /** 缩略图 */
  thumbnail?: string
}

/** 已放置的配件实例 */
export interface PlacedPart {
  id: string
  defId: string
  /** 旧版整板目标；新版分割板装配允许为空 */
  boardId?: string
  /** 吸附到的孔位 (板子局部行列) */
  holePos?: { row: number; col: number }
  rotation: number
  params: Record<string, number | string>
  /** 新版装配结果：模型局部锚点经过刚体变换后与目标孔重合 */
  placement?: {
    surface: 'split-panel' | 'board'
    /** 装配在板件正面(+Z)或背面(-Z) */
    side?: 'front' | 'back'
    panelId?: string
    position: [number, number, number]
    rotationZ: number
    targetIds: string[]
  }
}

/** 零件库索引 (public/partLibrary/index.json) */
export interface PartLibraryIndex {
  version: string
  generatedAt?: string
  categories: { id: PartCategory; name: string }[]
  parts: PartDefinition[]
  packages?: PartPackageDefinition[]
  designs?: SharedDesignDefinition[]
  warnings?: string[]
}

export interface PartPackageDefinition {
  schemaVersion: number
  id: string
  name: string
  version: string
  author: string
  license: string
  description?: string
}

export interface SharedDesignDefinition {
  id: string
  packageId: string
  name: string
  description?: string
  author?: string
  thumbnail?: string
  manifest: string
}

export const partPreviewPath = (part: PartDefinition): string | null =>
  part.model.preview ?? part.model.glb ?? part.model.stl ?? null

export const mountAnchorCount = (part: PartDefinition): number =>
  typeof part.mount === 'object' ? part.mount.anchors.length : part.mount === 'free' ? 0 : 1

/** 旧标定若包含长圆孔锚点但没有 axis，优先由同步器按同件一致方向补齐；无法推断时必须打开标定器补算。 */
export const mountNeedsCalibration = (part: PartDefinition): boolean => {
  if (typeof part.mount !== 'object') return part.mount !== 'free' && mountAnchorCount(part) === 0
  if (part.mount.calibrationRequired || part.mount.anchors.length === 0) return true
  return part.mount.anchors.some(anchor => anchor.accepts.includes('slot') && !anchor.axis)
}

export const mountStatusLabel = (part: PartDefinition): string => {
  if (mountNeedsCalibration(part)) {
    const expected = typeof part.mount === 'object'
      ? part.mount.expected?.map(kind => kind === 'slot' ? '长孔' : '圆孔').join('+')
      : undefined
    if (typeof part.mount === 'object') {
      const slotAnchors = part.mount.anchors.filter(anchor => anchor.accepts.includes('slot'))
      const missing = slotAnchors.filter(anchor => !anchor.axis).length
      if (missing && missing < slotAnchors.length) return `长孔方向 ${slotAnchors.length - missing}/${slotAnchors.length}`
      if (missing) return '待补长孔方向'
    }
    return expected ? `待标定 ${expected}` : '待标定锚点'
  }
  const count = mountAnchorCount(part)
  return count ? `${count} 锚点` : '自由放置'
}
