// ============ SnapBoard v2 几何类型定义 ============
import type { TextureComposition } from '../utils/textureComposition'
import type { TexturePatternConfig } from '../utils/texturePatterns'

/** 2D 点 (像素坐标) */
export interface Point2D {
  x: number
  y: number
}

/** 圆弧扫掠方向: 'ccw' = 角度递增, 'cw' = 角度递减 (y 向下空间, 与 canvas 一致) */
export type Sweep = 'ccw' | 'cw'

/**
 * 圆弧实体: 轮廓的一条边 (点索引 p1 → p2) 为圆弧, 而非直线段。
 * 用于直线+圆弧混合轮廓 (如圆角矩形开孔); 独立圆弧 = 2 点开放轮廓 + 1 个弧实体。
 */
export interface ArcEntity {
  id: string
  /** 边起点在 contour.points 中的索引 */
  p1: number
  /** 边终点索引 (恒为 (p1+1) % points.length) */
  p2: number
  center: Point2D
  /** 半径 (像素) */
  radius: number
  sweep: Sweep
  /**
   * true = 半径由尺寸约束驱动 (圆心固定, 端点随半径变化)。
   * false / 缺省 = 半径由两端点与圆心反算 (端点固定, 圆心随端点漂移)。
   * 可选字段: 旧工程没有该字段, 一律按 false 处理 (向后兼容)。
   */
  radiusDriving?: boolean
}

/**
 * 槽口参数化尺寸 (毫米语义与像素语义共用结构, 数值单位由使用处决定)。
 * 与 SKÅDIS 胶囊孔同构: width = W_slot (5mm), length = H_slot (15mm)。
 */
export interface SlotParams {
  /** 槽口总长 (含两端半圆) */
  length: number
  /** 槽口宽度 (短轴 = 2 × 端部半圆半径) */
  width: number
}

/** 板型库/用户导入轮廓的可追溯来源；只保存可序列化元数据，不保存原始文件正文。 */
export interface ContourSourceMetadata {
  kind: 'preset' | 'svg' | 'image' | 'dxf'
  id?: string
  fileName?: string
  /** 生成/导入时的用户参数，便于后续重新打开板型库编辑。 */
  params?: Record<string, string | number | boolean>
}

/** 2D 轮廓 */
export interface Contour {
  /** CAD geometry is immutable; only manufacturing role and whole-contour removal are allowed. */
  geometryLocked?: boolean
  id: string
  type: 'outer' | 'inner'
  name: string
  source?: ContourSourceMetadata
  /** 顶点序列 (像素坐标, 世界坐标) */
  points: Point2D[]
  /** 创建时吸附到固定草图原点的顶点；尺寸求解必须保持该点不动 */
  originAnchorIdx?: number
  /** 是否闭合; 缺失视为闭合 */
  closed: boolean
  /** 快捷实体标记: 圆 / 槽口 (胶囊) */
  shape?: 'circle' | 'slot' | 'polygon'
  /** 槽口 (胶囊): 两点定中心线, slotWidth 定宽度 */
  slotWidth?: number
  /**
   * 槽口参数化 (可选; 缺省时回退到 slotWidth 旧逻辑, 保证旧工程行为不变)。
   * length = 槽口总长 (中心线长 + 宽度), width = 短轴宽 = 2 × 端部半圆半径。
   * 与 slotWidth 并存时以 slotParams.width 为准, 写入时同步回写 slotWidth。
   */
  slotParams?: SlotParams
  /** 圆心 (circle 用; polygon 用=中心) */
  center?: Point2D
  /** 半径 (像素; circle 用; polygon 用=参考圆半径 内切=顶点半径/外切=边心距) */
  radius?: number
  /** 多边形绘制模式 (radius 为参考圆半径时判定顶点半径用) */
  polygonCircumscribed?: boolean
  /** 多边形旋转角度 (度, 首个顶点方向, 0=朝右; 鼠标拖拽实时确定, 属性面板可改) */
  rotation?: number
  /** 圆弧边实体 (直线段不存储, 缺省即直线) */
  arcs?: ArcEntity[]
  /** 构造几何线 (中心线/辅助线): 渲染为灰色虚线, 不参与板子轮廓 */
  construction?: boolean
  /** 无限长度 (直线/构造线): 渲染为穿过两点的无限延长线 (属性面板开关) */
  infinite?: boolean
  /** 尺寸标注 = 约束 */
  constraints: Constraint[]
}

// ============ 约束系统 ============

export type ConstraintType =
  | 'length'          // 单边长度
  | 'distance'        // 两点距离
  | 'angle'           // 两线夹角
  | 'diameter'        // 圆直径
  | 'radius'          // 圆/弧半径
  | 'arcLength'       // 圆弧长度
  | 'horizontal'      // 水平
  | 'vertical'        // 垂直
  | 'parallel'        // 平行
  | 'perpendicular'   // 垂直关系
  | 'equal'           // 相等
  // ↓ 以下为草图内核扩展新增 (阶段 0 数据模型)。均为可选能力,
  //   旧工程不含这些类型; 求解层暂未接入时按"无数值的几何关系"处理。
  | 'slotWidth'       // 槽口宽度 (短轴 = 2 × 端部半径)
  | 'arcAngle'        // 弧心角 (弧两端点相对圆心的夹角)
  | 'concentric'      // 同心 (两弧/圆共享圆心)
  | 'coradial'        // 共径 (两弧/圆半径相等)
  | 'tangent'         // 相切 (线-弧 / 弧-弧 / 圆-弧)
  | 'symmetric'       // 对称 (关于中心线镜像)
  | 'midpoint'        // 中点 (点保持在边的中点)
  | 'fix'             // 固定 (锁定尺寸与位置)

/** 尺寸标注 = 约束 (核心设计: 标注即约束) */
export interface Constraint {
  id: string
  type: ConstraintType
  /** 几何引用 */
  edgeIndex?: number    // 边索引
  edgeIndex2?: number   // 第二条边 (距离/角度)
  vertexIdx1?: number   // 顶点1
  vertexIdx2?: number   // 顶点2
  /** 跨轮廓标注时第二条轮廓 id (缺省=同轮廓) */
  contourId2?: string
  /** 数值 (mm) */
  value: number
  /** 角度值 (度) */
  angleValue?: number
  /** 标签位置 (世界坐标) */
  labelPos: Point2D
  /** true=驱动尺寸 / false=参考尺寸 */
  driving: boolean
  /** 标签格式 (由求解器决定, 如 "宽 100.0 mm") */
  label: string
}

// ============ 3D 特征 ============

export type FeatureType = 'sketch' | 'extrude' | 'hole' | 'holePattern'

export interface FeatureBase {
  id: string
  name: string
  type: FeatureType
}

/** 2D 草图特征 (包含轮廓) */
export interface SketchFeature extends FeatureBase {
  type: 'sketch'
  contours: Contour[]
  /** 草图所在平面: 'xy' | 'xz' | 'yz' */
  plane: 'xy' | 'xz' | 'yz'
}

/** 拉伸特征: 2D 草图 → 3D 体 */
export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude'
  sketchId: string
  depth: number          // mm
  direction: 1 | -1      // 拉伸方向
  /** 布尔: true=合并到体 / false=挖空 */
  merge: boolean
}

/** 孔特征 */
export interface HoleFeature extends FeatureBase {
  type: 'hole'
  faceId: string         // 目标面
  shape: 'circle' | 'slot' | 'rect'
  position: Point2D      // 面上位置 (mm)
  size: {
    diameter?: number    // 圆孔直径 (mm)
    length?: number      // 腰孔/方孔长 (mm)
    width?: number       // 腰孔/方孔宽 (mm)
  }
  through: boolean       // 通孔
  depth?: number         // 盲孔深度 (mm)
}

/** 孔阵列 (保留类型定义; 产品已决定不使用自动孔阵列, 见 TECH_SPEC) */
export interface HolePatternFeature extends FeatureBase {
  type: 'holePattern'
  faceId: string
  grid: {
    rows: number
    cols: number
    rowSpacing: number   // mm
    colSpacing: number   // mm
  }
  holeDef: {
    shape: 'circle' | 'slot' | 'rect'
    diameter?: number
    length?: number
    width?: number
  }
  /** 孔位偏移模式 */
  offset: 'grid' | 'stagger'
  through: boolean
}

export type Feature = SketchFeature | ExtrudeFeature | HoleFeature | HolePatternFeature

// ============ 零件 ============

export interface Part {
  id: string
  name: string
  features: Feature[]
  /** 材质 (mm 为单位) */
  material: {
    name: string
    thickness: number
  }
}

// ============ 洞洞板 (SKÅDIS 兼容; 孔阵列已不作为核心流程, 保留供分割/装配过渡) ============

export interface HolePatternParams {
  cornerRadius: number   // R_corner 外角圆角 mm (8)
  slotWidth: number      // W_slot 椭圆孔短轴 mm (5)
  slotLength: number     // H_slot 椭圆孔长轴 mm (15)
  spacingX: number       // Mx 晶体横向周期 mm (40)
  spacingY: number       // My 晶体纵向周期 mm (40)
  marginX: number        // 水平边距 mm (10)
  marginY: number        // 垂直边距 mm (10)
  /** A 列胶囊中心 X 零位 mm (相对板左下角, 工程图 10) */
  slotGridX0?: number
  /** A 列胶囊中心 Y 零位 mm (工程图 30) */
  slotGridY0?: number
  /** B 列相对 A 列 X 错位 mm (四板拼接 DXF = 20) */
  slotStaggerX?: number
  /** B 列相对 A 列 Y 错位 mm (工程图 20) */
  slotStaggerY?: number
  jointHole: {
    enabled: boolean
    diameter: number     // D_joint 固定圆孔直径 mm (默认 5)
    offsetX: number      // 角部偏移 X mm (10)
    offsetY: number      // 角部偏移 Y mm (10)
  }
}

export interface CutLine {
  id: string
  type: 'vertical' | 'horizontal'
  position: number       // mm
  manual?: boolean
}

/** 洞洞板 (2D 轮廓 + 分割 + 3D 位置) */
export interface Board {
  id: string
  name: string
  /** 轮廓顶点 (mm, 板子局部坐标, 左下角为原点) */
  contour: Point2D[]
  holePattern: HolePatternParams
  thickness: number      // T 板厚 mm (4)
  split: {
    maxPieceSize: number // 默认 220 (热床尺寸)
    enabled: boolean
    cuts: CutLine[]
  }
  /** 3D 世界位置 (mm) */
  position: { x: number; y: number; z: number }
}

// ============ 项目 ============

export interface Project {
  metadata: {
    name: string
    author: string
    version: string
    createdAt: string
  }
  config: {
    /** 像素→毫米 换算 */
    pixelToMM: number
    /** 默认材质 */
    material: string
  }
  parts: Part[]
}

// ============ UI 状态 ============

export type ToolId =
  | 'select'
  | 'line'         // 直线 (实线/中心线合一, lineSubMode 切换; 中心线=无限长构造线)
  | 'rect'
  | 'circle'
  | 'arc'          // 弧 (二级菜单: arcSubMode = arc3pt 三点弧 / arcCenter 圆心弧)
  | 'polygon'      // 多边形 (边数可选 + 内切圆/外切圆两种模式, polygonCircumscribed)
  | 'slot'         // 槽口 (两点定长度 → 实时拖动定宽度 → R 标注)
  | 'offset'       // 等距实体
  | 'eraser'       // 擦除 (点擦除: 悬停高亮点击擦; 快速擦除: 划线扫过全擦)
  | 'smartdim'     // 智能尺寸 (边长度/两点距离/平行边间距/圆心+圆周=半径/两线角度)

/** 草图求解状态 (SolidWorks 风格颜色编码) */
export type SketchState = 'under' | 'fully' | 'over'

export interface UIState {
  /** Unsaved structure candidate; never serialized as the applied manufacturing model. */
  structurePreviewPanels?: SplitPanel[] | null
  activeTool: ToolId
  /** 最近一次使用的绘图工具 (线/矩形/圆…); 中键轮盘【返回上一步】用 */
  lastDrawTool: ToolId
  /** 2D 草图模式 / 3D 模式 */
  viewMode: '2d' | '3d'
  /** 当前激活的草图 id */
  activeSketchId: string | null
  /** 选中的特征 id */
  selectedFeatureId: string | null
  /** 选中的轮廓 id */
  selectedContourId: string | null
  /** 框选/组变换中的轮廓集合；selectedContourId 是其中的主轮廓。 */
  selectedContourIds: string[]
  /** 选中的约束 id */
  selectedConstraintId: string | null
  /** 3D 装配视口中选中的配件实例 id */
  selectedPartId: string | null
  /** 纹理工作室当前选中的图片图层；仅属会话 UI，不写入工程文件。 */
  selectedTextureLayerId: string | null
  selectedBackTextureLayerId: string | null
  textureEditSide: 'front' | 'back'
  /** 轮廓求解状态 (contourId → under/fully/over) */
  solveStates: Record<string, SketchState>
  /** 新建轮廓类型: outer 板轮廓 / inner 开孔 (挖空, 如插座空位) */
  newContourType: 'outer' | 'inner'
  /** 直线子模式: line=实线折线 / centerline=中心线 (两点生成无限长构造线) */
  lineSubMode: 'line' | 'centerline'
  /** 矩形子模式: corner=两点对角 / center=中心矩形 / 3point=三点矩形 */
  rectSubMode: 'corner' | 'center' | '3point'
  /** 圆子模式: center=圆心圆 / 3point=圆周三点圆 */
  circleSubMode: 'center' | '3point'
  /** 弧工具子模式: 三点弧 / 圆心弧 */
  arcSubMode: 'arc3pt' | 'arcCenter'
  /** 多边形边数 (3-12) */
  polygonSides: number
  /** 多边形绘制模式: false=内切圆(顶点在圆上) / true=外切圆(边与圆相切) */
  polygonCircumscribed: boolean
  /** 擦除模式: point=点擦除 / sweep=快速擦除(划线扫过) */
  eraserMode: 'point' | 'sweep'
  /** 分割参数【选项】弹层是否展开 (右侧栏分割引擎面板) */
  splitOptionsOpen: boolean
  /** 右侧栏配件库面板是否展开 (打开时与分割引擎互斥，也可手动全部收起) */
  partsOpen: boolean
  /** 配件布局之后的受力镂空轻量化试验工作区。 */
  structureOpen: boolean
  /** 3D 视口上的纹理工作室是否展开。 */
  textureStudioOpen: boolean
  /** 遮挡分析工作区是否展开。 */
  occlusionAnalysisOpen: boolean
}

export type BoardTextureSource = 'preset' | 'image' | 'composition' | 'pattern'
export type BoardTextureFit = 'cover' | 'contain' | 'stretch' | 'tile'
export type BoardTextureColorMode = 'original' | 'mono' | 'posterize'
export type BoardTextureModelingMode = 'high-fidelity' | 'pixel' | 'vector'
export type BoardSurfaceMode = 'snapcolor' | 'veneer' | 'woodgrain'
export type BoardSurfaceFinish = 'textured-pei' | 'smooth-top'
export type BoardVeneerPrintGoal = 'standard' | 'frosted' | 'clear-experimental'
export type BoardTextureLutId =
  | 'snapcolor-petg-rybw'
  | 'snapcolor-petg-cmyw'
  | 'snapcolor-petg-bw'
  | 'snapcolor-petg-5color'
  | 'snapcolor-petg-6color'
  | 'snapcolor-petg-8color'
  | 'snapcolor-petg-coobeen-rybw'
  | 'snapcolor-petg-kynix-rybw'
  | 'snapcolor-petg-sunlu-rybw'
  | 'snapcolor-petg-tianrui-rybw'
  | 'snapcolor-petg-biying-rybw'
  | 'snapcolor-petg-generic-rybw'
  | `snapcolor-farm:${string}`

/**
 * 板面纹理避让矩形。坐标相对整板包围盒归一化到 0~1，原点在左下角。
 * 避让区只把纹理画布回填为基材色，不改变板件、孔位或制造网格拓扑。
 */
export interface BoardTextureAvoidZone {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  enabled: boolean
}

/**
 * 洞洞板全局纹理。所有分割板共享同一设计坐标系，避免每块板从图片左上角重新开始。
 * imageDataUrl 会写入 .snapboard 工程，使自定义图片在重新打开后仍可编辑。
 */
export interface BoardTextureConfig {
  enabled: boolean
  source: BoardTextureSource
  presetId: string
  imageDataUrl?: string
  imageName?: string
  imageAspect?: number
  /** Independent image viewed from the back; the front keeps the existing composition. */
  backEnabled?: boolean
  backImageDataUrl?: string
  backImageName?: string
  backImageAspect?: number
  backFit?: BoardTextureFit
  backScale?: number
  backOffsetX?: number
  backOffsetY?: number
  backRotation?: number
  /** Back uses the same editor and thin-layer renderer as the front. Legacy backImage* remains readable. */
  backTexture?: BoardTextureConfig
  /** 多图片资源与图层；数组顺序即从底到顶的绘制顺序。 */
  composition: TextureComposition
  /** 程序化数学密铺配置。 */
  pattern: TexturePatternConfig
  /** 局部纹理留白/视觉核心保护区。 */
  avoidZones: BoardTextureAvoidZone[]
  fit: BoardTextureFit
  /** 图案相对基础适配尺寸的百分比。 */
  scale: number
  /** 纹理在整幅板面上的水平/垂直偏移百分比。 */
  offsetX: number
  offsetY: number
  /** 板面内逆时针旋转角度。 */
  rotation: number
  opacity: number
  brightness: number
  contrast: number
  saturation: number
  colorMode: BoardTextureColorMode
  /** 黑白/海报色阶数量；只负责设计端预处理，不等于耗材数量。 */
  colorCount: number
  /** SnapColor 建模模式；当前产品入口只开放高保真图片，pixel/vector 保留作旧工程兼容。 */
  modelingMode: BoardTextureModelingMode
  /** Continuous manufacturing contours; false retains the V1.1 grid path for comparison. */
  manufacturingContours?: boolean
  /** Standard preserves existing export; fine uses physical sampling and bounded shared-boundary fitting. */
  manufacturingEdgeQuality?: 'standard' | 'fine'
  /** 校准色卡/LUT；决定基础耗材、实测颜色与 5 层叠色配方。 */
  lutId: BoardTextureLutId
  /** 高保真颜色量化细节。它只减少噪点，不限制最终可呈现的 LUT 颜色数。 */
  quantizeColors: number
  /** 色相保护权重，0 为纯色差，1 为最强色相保护。 */
  hueWeight: number
  /** 是否清理孤立的单格配方。 */
  cleanup: boolean
  /** 顶部彩色嵌件总厚度；其中最后 5×0.08mm 为光学叠色，其余为白色承托层。 */
  textureThickness: number
  /** SnapColor 彩色层是否在外轮廓与全部孔壁增加基材色单线封边。 */
  edgeSealEnabled: boolean
  /** 基材封边的名义宽度 (mm)；默认 0.5mm，约等于 0.4mm 喷嘴的一道外墙。 */
  edgeSealWidth: number
  /** 像素艺术模式的色块尺寸；高保真/SVG 模式不使用此值。 */
  pixelSize: number
  /**
   * 制造采样精度倍率（1 = 自动预算）。叠色图案的杂色斑来自抗锯齿边缘在粗格点上的量化，
   * 需要更干净的色界时调高；格数与耗时同比上升。
   */
  samplingDetail?: number
  /**
   * 制造导出的输出方式：单个 3MF（默认）或每块板一个 3MF 再打包成 zip。
   * 高精度下单文件会大到不好用；逐板导出仍共用同一份世界格点与间距。
   */
  manufacturingOutput?: 'single' | 'perPanel'
  /** 彩色版画使用 SnapColor 多色光学层；质感贴面只使用一卷表层 PETG。 */
  surfaceMode: BoardSurfaceMode
  woodGrain: import('../utils/woodGrain').WoodGrainConfig
  /** 基材与表层在切片器中的耗材显示名称。 */
  baseMaterialName: string
  surfaceMaterialName: string
  /** 单卷贴面耗材类别；与品牌、颜色分开，避免从名称猜工艺。 */
  surfaceMaterialKind: 'decorative-petg' | 'transparent-petg'
  /** 打印目标只作用于单卷贴面，不改变 SnapColor 光学层。 */
  surfacePrintGoal: BoardVeneerPrintGoal
  surfaceProfileVersion: 1
  /** 实际料卷资料优先于目标预设；未填写时仍须在切片器核对耗材配置。 */
  surfaceFilamentVendor: string
  surfacePrintOverrides: { nozzleTempC?: number; flowRatio?: number; maxFlowMm3s?: number; fanPercent?: number }
  /** 基材与单材质贴面的耗材颜色。 */
  baseColor: string
  surfaceColor: string
  /** 细磨砂通过装饰面朝下贴合纹理 PEI 热床实现，避免 fuzzy skin 破坏孔壁。 */
  surfaceFinish: BoardSurfaceFinish
  /** 结构基材稀疏填充率；SnapColor/贴面层仍按自身对象参数打印。 */
  baseInfillDensity: number
}

// ============ 自动分割引擎类型 (与 utils/pegboardSplit 共用) ============

/** 热床内不可放置模型的矩形区域；坐标以热床左下角为原点。 */
export interface PrintBedKeepout {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  enabled: boolean
}

/** 分割参数 (软件界面【选项】菜单可修改; 默认 = 宜家洞洞板标准) */
export interface SplitConfig {
  /** 选中的打印机/热床预设；同时决定 3MF 内的 Bambu machine profile。 */
  printerPreset: string
  /** 热床物理宽度 mm；实际排盘还会扣除安全边距与禁放区。 */
  bedW: number
  /** 热床物理深度 mm；实际排盘还会扣除安全边距与禁放区。 */
  bedH: number
  /** 有效打印区相对热床四边的安全内缩 mm。 */
  bedMarginLeft: number
  bedMarginRight: number
  bedMarginBottom: number
  bedMarginTop: number
  /** 擦嘴、切刀、换料机构或缺角等不可打印矩形区域。 */
  bedKeepouts: PrintBedKeepout[]
  /** X 模数 mm - 板宽必须是其整数倍 (默认 40) */
  mx: number
  /** Y 模数 mm - 板高必须是其整数倍 (默认 20) */
  my: number
  /** 边缘预留 mm (长圆孔阵列离边的最小距离, 默认 20) */
  edgeMargin: number
  /** 最小板宽 mm - 小于它放弃切割并合并 (默认 80) */
  minW: number
  /** 最小板高 mm - 小于它放弃切割并合并 (默认 60) */
  minH: number
  /** 板件允许的最小局部结构宽度 mm；规则分区优先避免产生更窄的长条/细颈 (默认 60) */
  minFeatureWidth: number
  /** 小/中型内孔与分板接缝的优先安全距离 mm；无法满足时自动降级为跨板孔 (默认 10) */
  holeSeamClearance: number
  /** 功能长圆孔/固定圆孔与外轮廓、缺口和内孔之间保留的实体边带 mm (默认 2) */
  holeBoundaryClearance: number
  /** 边缘拼接孔水平偏移 mm (默认 10, 与 SKÅDIS 一致) */
  jointOffsetX: number
  /** 边缘拼接孔垂直偏移 mm (默认 10) */
  jointOffsetY: number
  /** 旧版薄盖厚度兼容字段；现已停用，候选孔只有“完整板面 / 贯通孔”两种状态。 */
  lidThickness: number
  /** 是否把推荐固定孔自动设为贯通孔；其余位置仅显示虚线候选提示。 */
  recommendKnockouts: boolean
  /** 外角圆角半径 mm (倒角预览, 默认 8) */
  cornerRadius: number
  /** 竖向长圆孔(胶囊)长轴 mm (垂直方向, 工程图 15.0) */
  slotLength: number
  /** 竖向长圆孔(胶囊)短轴 mm (水平方向 = 2×端部半圆半径, 工程图 5.0) */
  slotWidth: number
  /** ⚠ 已废弃 (旧"半圆槽两两成对"参数), 不再参与孔位生成 */
  slotPairGapY: number
  /** A 列槽对中心 X 零位 mm (相对板左下角, 工程图 10) */
  slotGridX0: number
  /** A 列槽对中心 Y 零位 mm (工程图 30) */
  slotGridY0: number
  /** B 列槽对相对 A 列 X 错位 mm (四板拼接 DXF = 20) */
  slotStaggerX: number
  /** B 列槽对相对 A 列 Y 错位 mm (工程图 20) */
  slotStaggerY: number
  /** 固定圆孔直径 mm (用户确认制造规格默认 φ5) */
  jointDiameter: number
  /** 四角圆孔直径 mm (兼容字段, 已不再使用; 工程图网格角无圆孔) */
  cornerHoleDiameter: number
  /** 板材厚度 mm (用户自定义, 默认 5；PETG 宿舍洞洞板基准) */
  thickness: number
  /** 制造模型的孔口与外缘倒角 mm。 */
  manufacturingChamfer: number
  /** 拼装间隙 mm (公差预留, 默认 0.2) */
  gapTolerance: number
}

/** 孔位 (全局坐标 mm) */
export interface HolePos {
  x: number
  y: number
  /** 候选孔状态: true=实际贯通孔；false/缺省=完整板面，仅在2D/3D显示虚线位置提示。 */
  knocked?: boolean
  /** 用户是否在 2D/3D 中手动覆盖过自动推荐状态; 重新分割时按坐标保留 */
  manual?: boolean
  /** 单孔编辑前的类型/状态；孔心不变，用于恢复及重新分板。 */
  editOrigin?: { group: 'slots' | 'round_holes' | 'edge_holes'; index?: number; knocked?: boolean; manual?: boolean }
}

/** 单块分割后的板材 (全局坐标 mm) */
export interface SplitPanel {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** 建议在矩形热床上的逆时针排版角度（度）；0=按设计方向直接打印。 */
  printRotation?: number
  /**
   * 最终板材外轮廓 (全局 mm, 逆时针)。跨板内孔会通过布尔差集成为这里的凹边/缺口。
   * 缺省 = 以 (x,y,w,h) 为矩形的角点 (旧数据兼容)。
   */
  contour?: Point2D[]
  /** 轮廓顶点中需要圆角的顶点索引 (装配外轮廓凸角; 接缝/内部角直角) */
  roundIdx?: number[]
  /** 竖向长圆孔(胶囊) 5×15；坐标为全局 mm，来自原始轮廓唯一 A/B 母阵的板内裁取。 */
  slots: HolePos[]
  /** 已开启的独立圆孔；单孔编辑把原长孔改为圆孔时也存于此数组。 */
  round_holes: HolePos[]
  /** 候选圆孔默认 φ5；板边孔是结构缺口，板内孔由 knocked 决定是否真正贯通。 */
  edge_holes: HolePos[]
  /** 用户关闭的原孔位，仅供选取/提示，不参与制造开孔。 */
  closed_holes?: HolePos[]
  /** 板内通孔轮廓 (全局 mm 坐标); 例如墙面插座、开关盒等避让孔 */
  cutouts?: Point2D[][]
  /** 独立于草图和分板规划的制造镂空；仅 3D 预览与制造导出读取。 */
  latticeCutouts?: Point2D[][]
  latticeOptions?: { fillWindows: boolean; cellPitchMm: number; cellRibMm: number; openCoreCaps: boolean }
  /** 贴墙线稿保真：独立制造层，托底和凹刻不依赖背光。 */
  latticeFace?: LatticeFaceData
  /**
   * 四角是否保留圆角 (顺序 [底左, 底右, 顶右, 顶左]):
   * 仅装配外轮廓的凸角为 true, 接缝/内部 T 型角为 false (直角),
   * 保证相邻板材紧密平齐、拼装面连续 (无凹口/凸角)。
   * 缺省 = 全 true (旧行为, 全圆角)。
   */
  outerCorners?: [boolean, boolean, boolean, boolean]
}

/** 分割结果 */
export interface SplitResult {
  panels: SplitPanel[]
  warnings: string[]
  config: SplitConfig
  /** 板材总面积 mm² */
  coveredArea: number
  /** 输入图形面积 mm² */
  inputArea: number
  /** 覆盖率 */
  coverageRatio: number
}

/** 分割引擎输入 */
export interface SplitInput {
  /** 外轮廓 (全局 mm 坐标, 正交多边形, 闭合) */
  points: Point2D[]
  /** 内孔轮廓 (挖空区域, 可选) */
  holes?: Point2D[][]
  /** 已按板件生成的结构镂空：参与制造开孔，不驱动板缝重新规划。 */
  passiveHoles?: Point2D[][]
  /**
   * auto：分板器可为新生成的板材外凸角应用配置圆角；
   * preserve-source：SVG/图片/预制板型已经定义了外观，只保留源轮廓，不再二次加圆角。
   */
  cornerPolicy?: 'auto' | 'preserve-source'
}

// 运行时默认参数常量来自引擎模块 (仅常量, 无类型循环)
export { PEGBOARD_DEFAULT_CONFIG } from '../utils/pegboardSplit'

/** 单个轮廓的分割结果 (store 用) */
export interface SplitSourceResult {
  contourId: string
  name: string
  panels: SplitPanel[]
  warnings: string[]
  coverageRatio: number
  /** 参与合并生成该来源的源轮廓 id (单条时 = [contourId]; 供撤销/重做联动) */
  sourceIds?: string[]
}

/** 一次【自动分割】的完整结果 (store 用) */
export interface SplitResultState {
  /** 每个被分割轮廓的结果 */
  sources: SplitSourceResult[]
  /** 全部板材 (扁平) */
  panels: SplitPanel[]
  warnings: string[]
  config: SplitConfig
  ts: number
  /** 已应用的 3MF 连筋样式；旧草图镂空工程可留空，更新时迁移。 */
  openLatticeStyle?: 'organic' | 'hex' | 'diamond' | 'honeycomb' | 'ribs' | 'svg' | 'flower'
  /** 自定义窗花原始 SVG；用于重新打开工程后继续更新镂空。 */
  openLatticeSvg?: string
  /** 自定义 SVG 在整组板件上的位置、尺寸与朝向。 */
  openLatticePlacement?: SvgLatticePlacement
  openLatticeSvgOptions?: SvgLatticeOptions
  /** 参考镂空的整面保留厚度；0 / 缺省表示完全贯通。 */
  openLatticeSurfaceMm?: number
}

export interface SvgLatticeOptions {
  mode: 'cutout' | 'fidelity'
  lineWidthMm: number
  backingMm: number
  /** 缺省保留旧版局部托底；whole 为全板连续薄面。 */
  coverage?: 'artwork' | 'whole'
  padShape?: 'rectangle' | 'silhouette' | 'contour'
  outlineGapMm?: number
  contrastColor?: string
  baseStyle?: 'organic' | 'hex' | 'diamond' | 'honeycomb' | 'ribs'
  sourceLayerId?: string
  sourceSignature?: string
}

export interface LatticeFaceData {
  /** 保留原线稿，孔位或板厚改变时重新裁切制造层。 */
  source?: { artwork: Point2D[][][]; options: SvgLatticeOptions; signature: string;
    templateStyle?: 'organic' | 'hex' | 'diamond' | 'honeycomb' | 'ribs'; silhouette?: Point2D[][][] }
  layers: Array<{
    role: 'structure' | 'backing' | 'face' | 'detail'
    /** 多边形 → 外环与内环 → 顶点；全局 mm。 */
    polygons: Point2D[][][]
    zMin: number
    zMax: number
  }>
  contrastColor?: string
}

export interface SvgLatticePlacement {
  offsetX: number
  offsetY: number
  scale: number
  rotationDeg: number
  flipX: boolean
  flipY: boolean
}
