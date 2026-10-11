/**
 * 首批装配宿主规格目录。
 *
 * 这是纯数据、可 JSON 序列化的目录；它不依赖 Three.js，也不依赖运行时的
 * mountInterfaces 实现。后续装配引擎可以把 compatibilityKey / connectorKind
 * 映射到正式连接器，并按 recipe 解释装配动作。
 *
 * 名义尺寸相同不代表可互换。“槽 8”不足以确定兼容性，
 * item Line 8 与 Bosch Rexroth Slot 8 必须保留各自的厂商体系键，除非存在明确
 * 适配器或经过截面、紧固件和载荷验证，不能自动互认。
 */

import type { MountInterfaceKind } from './mountInterfaces'

export type HostCatalogId =
  | 'snapboard-pegboard-v1'
  | 'en60715-th35-7.5'
  | 'en60715-th35-15'
  | 'item-line8'
  | 'bosch-rexroth-slot8'
  | 'wall-plane'

/** UI 与持久化层使用的公开预设 ID。 */
export type AssemblyHostPresetId = HostCatalogId

export type HostConnectorKind =
  | 'hole-pattern'
  | 'rail-profile'
  | 't-slot'
  | 'surface-plane'

export type HostOccupancyKind = 'discrete-targets' | 'axis-interval' | 'surface-footprint'

export type AssemblyActionType =
  | 'select-target'
  | 'align'
  | 'insert'
  | 'translate-until-contact'
  | 'rotate-until-snap'
  | 'slide-until-stop'
  | 'clamp'
  | 'press'
  | 'verify'

export interface HostCatalogSource {
  readonly label: string
  readonly url: string
  readonly supports: readonly string[]
}

export interface HostCatalogAssemblyStep {
  readonly id: string
  readonly action: AssemblyActionType
  readonly label: string
  readonly automaticByDefault: boolean
  readonly stopCondition: string
  readonly manualFallback: string
}

export interface HostCatalogEntry {
  readonly id: HostCatalogId
  readonly schemaVersion: 1
  readonly label: string
  /** 与通用装配契约一致的连接器类型；UI 直接据此选择标定流程。 */
  readonly kind: MountInterfaceKind
  readonly summary: string
  readonly status: 'available' | 'experimental' | 'planned'
  readonly family: 'pegboard' | 'din-rail' | 'aluminium-profile' | 'wall'
  readonly connectorKind: HostConnectorKind
  /** 精确兼容键；只能与完全相同的键直接自动匹配。 */
  readonly compatibilityKey: string
  /** 厂商或项目体系键。跨体系默认不互认。 */
  readonly systemKey: string
  readonly standard: string | null
  readonly nominalGeometryMm: Readonly<Record<string, number>>
  readonly supportedMatingKeys: readonly string[]
  readonly assemblyAxis: 'host-x' | 'host-y' | 'host-normal'
  readonly occupancy: {
    readonly kind: HostOccupancyKind
    readonly clearanceMm: number
    readonly collisionPolicy: 'reject-overlap' | 'warn-overlap'
  }
  readonly recipe: readonly HostCatalogAssemblyStep[]
  readonly validation: {
    readonly geometryChecks: readonly string[]
    readonly requiredMetadata: readonly string[]
    readonly loadRatingPolicy: 'geometry-only' | 'manufacturer-data-required'
  }
  readonly interchangeability: {
    readonly crossSystemAutomaticMatch: boolean
    readonly notes: readonly string[]
  }
  readonly sources: readonly HostCatalogSource[]
}

const pegboardRecipe: readonly HostCatalogAssemblyStep[] = [
  {
    id: 'select-holes',
    action: 'select-target',
    label: '选择圆孔或长圆孔目标',
    automaticByDefault: false,
    stopCondition: '用户完成全部孔位选择',
    manualFallback: '逐个撤销或清空孔位',
  },
  {
    id: 'align-hole-pattern',
    action: 'align',
    label: '按锚点刚体配准并保持长孔竖直语义',
    automaticByDefault: true,
    stopCondition: '锚点残差进入允许误差且手性有效',
    manualFallback: '上下翻转、旋转与平移微调',
  },
  {
    id: 'insert-to-board',
    action: 'translate-until-contact',
    label: '沿板面法向插入至接触面贴板',
    automaticByDefault: true,
    stopCondition: '零件接触面与板面代理碰撞',
    manualFallback: '手动覆盖接触面和插入距离',
  },
  {
    id: 'slide-to-slot-bottom',
    action: 'slide-until-stop',
    label: '沿长孔方向下滑至锁止',
    automaticByDefault: true,
    stopCondition: '安装柱底部与长孔底部代理接触；纯圆孔时距离为 0',
    manualFallback: '手动覆盖锁止距离',
  },
  {
    id: 'verify-pegboard-fit',
    action: 'verify',
    label: '检查占孔、实体碰撞和板内边界',
    automaticByDefault: true,
    stopCondition: '所有离散目标未被占用且没有不可接受穿插',
    manualFallback: '显示冲突目标并取消放置',
  },
]

const dinRailRecipe: readonly HostCatalogAssemblyStep[] = [
  {
    id: 'select-rail-segment',
    action: 'select-target',
    label: '选择导轨和轴向安装区段',
    automaticByDefault: false,
    stopCondition: '目标区段长度覆盖零件占用长度',
    manualFallback: '沿导轨轴拖动定位',
  },
  {
    id: 'align-upper-lip',
    action: 'align',
    label: '卡扣上唇对准导轨上沿',
    automaticByDefault: true,
    stopCondition: '卡扣轴与导轨轴平行且上沿进入捕获范围',
    manualFallback: '翻转卡扣朝向或旋转微调',
  },
  {
    id: 'seat-upper-lip',
    action: 'insert',
    label: '挂入导轨上沿',
    automaticByDefault: true,
    stopCondition: '上卡口接触代理闭合',
    manualFallback: '沿宿主法向微调插入深度',
  },
  {
    id: 'snap-lower-lip',
    action: 'rotate-until-snap',
    label: '绕导轨轴旋转或按压至下卡扣锁止',
    automaticByDefault: true,
    stopCondition: '下卡扣越过下沿并回弹至锁止角',
    manualFallback: '手动控制旋转角并确认锁止',
  },
  {
    id: 'verify-rail-interval',
    action: 'verify',
    label: '检查连续区段占用和端部余量',
    automaticByDefault: true,
    stopCondition: '轴向占用区间无冲突并处于导轨有效长度内',
    manualFallback: '沿导轨轴移动到空闲区段',
  },
]

const tSlotRecipe: readonly HostCatalogAssemblyStep[] = [
  {
    id: 'select-compatible-slot',
    action: 'select-target',
    label: '选择同一厂商体系内的兼容槽',
    automaticByDefault: false,
    stopCondition: '体系键、槽截面签名和紧固件规格全部匹配',
    manualFallback: '选择明确的转接件，不允许仅凭“槽 8”强制匹配',
  },
  {
    id: 'insert-slot-fastener',
    action: 'insert',
    label: '从端部滑入或按已验证方式旋入槽螺母',
    automaticByDefault: true,
    stopCondition: '紧固件完全进入槽腔且方向有效',
    manualFallback: '选择端部插入、旋入或落入模式',
  },
  {
    id: 'slide-along-slot',
    action: 'slide-until-stop',
    label: '沿槽轴移动到目标位置',
    automaticByDefault: true,
    stopCondition: '支架基准点到达目标轴向坐标',
    manualFallback: '沿槽轴拖动并吸附到刻度',
  },
  {
    id: 'seat-bracket-face',
    action: 'translate-until-contact',
    label: '支架安装面贴合型材表面',
    automaticByDefault: true,
    stopCondition: '支架接触面与型材外表面代理接触',
    manualFallback: '手动选择接触面并调整法向偏置',
  },
  {
    id: 'clamp-slot-fastener',
    action: 'clamp',
    label: '以匹配螺钉夹紧',
    automaticByDefault: false,
    stopCondition: '用户确认紧固件与装配状态；软件仅记录，不模拟扭矩保证',
    manualFallback: '保留未锁紧状态以继续沿槽移动',
  },
]

const wallRecipe: readonly HostCatalogAssemblyStep[] = [
  {
    id: 'select-wall-region',
    action: 'select-target',
    label: '选择墙面有效区域和安装方向',
    automaticByDefault: false,
    stopCondition: '底座 footprint 完整落在可安装区域',
    manualFallback: '移动底座或调整旋转角',
  },
  {
    id: 'align-backing-plane',
    action: 'align',
    label: '底座背面与墙面平行',
    automaticByDefault: true,
    stopCondition: '平面法向反向共线且面间偏差进入误差范围',
    manualFallback: '翻面、旋转和法向偏置微调',
  },
  {
    id: 'seat-backing-plane',
    action: 'translate-until-contact',
    label: '沿墙面法向移动至贴面',
    automaticByDefault: true,
    stopCondition: '背面与墙面碰撞代理首次接触',
    manualFallback: '手动覆盖贴面距离',
  },
  {
    id: 'fix-wall-base',
    action: 'press',
    label: '按胶粘、微钉或螺钉工艺固定底座',
    automaticByDefault: false,
    stopCondition: '用户确认完成实际工艺步骤',
    manualFallback: '保存为仅规划、未固定状态',
  },
  {
    id: 'verify-wall-footprint',
    action: 'verify',
    label: '检查二维占用、边界、禁放区和风险提示',
    automaticByDefault: true,
    stopCondition: 'footprint 无重叠且未进入墙边、管线等禁放区',
    manualFallback: '移动底座或标记为人工复核',
  },
]

export const HOST_CATALOG = [
  {
    id: 'snapboard-pegboard-v1',
    schemaVersion: 1,
    label: 'SnapBoard 洞洞板（现有 5×15 长圆孔体系）',
    kind: 'hole-pattern',
    summary: '现有圆孔/长圆孔锚点、贴面插入与下滑锁止装配。',
    status: 'available',
    family: 'pegboard',
    connectorKind: 'hole-pattern',
    compatibilityKey: 'snapboard:hole-pattern:slot-5x15-grid40:v1',
    systemKey: 'snapboard-pegboard',
    standard: null,
    nominalGeometryMm: {
      slotWidth: 5,
      slotLength: 15,
      primaryGridPitch: 40,
      phaseOffset: 20,
      optionalRoundHoleDiameter: 5,
    },
    supportedMatingKeys: [
      'snapboard:anchor:slot-5x15:v1',
      'snapboard:anchor:round-d5:v1',
    ],
    assemblyAxis: 'host-y',
    occupancy: {
      kind: 'discrete-targets',
      clearanceMm: 0.2,
      collisionPolicy: 'reject-overlap',
    },
    recipe: pegboardRecipe,
    validation: {
      geometryChecks: [
        '锚点数量与类型匹配',
        '长孔局部长轴方向有效',
        '插入后接触面与板面贴合',
        '下滑路径无实体碰撞',
      ],
      requiredMetadata: ['anchors', 'contactPlane', 'handedness', 'lockDistance'],
      loadRatingPolicy: 'geometry-only',
    },
    interchangeability: {
      crossSystemAutomaticMatch: false,
      notes: ['项目内部参数体系，不对外宣称兼容任意洞洞板品牌。'],
    },
    sources: [],
  },
  {
    id: 'en60715-th35-7.5',
    schemaVersion: 1,
    label: 'EN 60715 TH35-7.5 帽型导轨',
    kind: 'rail-clip',
    summary: '35×7.5 mm 帽型导轨，上唇挂入、下卡扣旋转锁止并占用连续区段。',
    status: 'planned',
    family: 'din-rail',
    connectorKind: 'rail-profile',
    compatibilityKey: 'en60715:th35-7.5:profile:v1',
    systemKey: 'en60715-th35',
    standard: 'EN 60715',
    nominalGeometryMm: { railWidth: 35, railDepth: 7.5 },
    supportedMatingKeys: ['en60715:clip:th35-7.5:v1'],
    assemblyAxis: 'host-x',
    occupancy: {
      kind: 'axis-interval',
      clearanceMm: 0.5,
      collisionPolicy: 'reject-overlap',
    },
    recipe: dinRailRecipe,
    validation: {
      geometryChecks: ['导轨截面版本匹配', '卡扣上/下沿顺序有效', '轴向占用区间无冲突'],
      requiredMetadata: ['upperLip', 'lowerLatch', 'railAxis', 'occupiedLength'],
      loadRatingPolicy: 'manufacturer-data-required',
    },
    interchangeability: {
      crossSystemAutomaticMatch: false,
      notes: ['TH35-7.5 与 TH35-15 深度不同，卡扣需分别声明兼容。'],
    },
    sources: [
      {
        label: 'Phoenix Contact NS 35/7.5 product data',
        url: 'https://www.phoenixcontact.com/en-us/products/din-rail-ns-35-75-unperf-250mm-1207647',
        supports: ['EN 60715 标准归属', '35 mm 宽度', '7.5 mm 深度'],
      },
    ],
  },
  {
    id: 'en60715-th35-15',
    schemaVersion: 1,
    label: 'TH35-15 深型帽式导轨',
    kind: 'rail-clip',
    summary: '35×15 mm 深型导轨，独立于 TH35-7.5 校验卡扣与背部净空。',
    status: 'planned',
    family: 'din-rail',
    connectorKind: 'rail-profile',
    compatibilityKey: 'en60715:th35-15:profile:v1',
    systemKey: 'en60715-th35',
    standard: 'IEC / EN family; verify exact rail certification per product',
    nominalGeometryMm: { railWidth: 35, railDepth: 15 },
    supportedMatingKeys: ['en60715:clip:th35-15:v1'],
    assemblyAxis: 'host-x',
    occupancy: {
      kind: 'axis-interval',
      clearanceMm: 0.5,
      collisionPolicy: 'reject-overlap',
    },
    recipe: dinRailRecipe,
    validation: {
      geometryChecks: ['导轨截面版本匹配', '15 mm 深度净空有效', '轴向占用区间无冲突'],
      requiredMetadata: ['upperLip', 'lowerLatch', 'railAxis', 'occupiedLength'],
      loadRatingPolicy: 'manufacturer-data-required',
    },
    interchangeability: {
      crossSystemAutomaticMatch: false,
      notes: [
        '不要因同为 35 mm 宽就继承 TH35-7.5 的兼容声明。',
        '产品资料可能标注“similar to EN 60715”，正式制造前应核对具体料号。',
      ],
    },
    sources: [
      {
        label: 'Phoenix Contact NS 35/15 product data',
        url: 'https://www.phoenixcontact.com/en-gb/products/din-rail-ns-3515-unperf-500mm-1207654',
        supports: ['35 mm 宽度', '15 mm 深度', '具体产品的标准说明'],
      },
    ],
  },
  {
    id: 'item-line8',
    schemaVersion: 1,
    label: 'item Line 8 铝型材槽',
    kind: 't-slot',
    summary: 'item Line 8 厂商体系内的槽螺母插入、轴向定位和夹紧装配。',
    status: 'planned',
    family: 'aluminium-profile',
    connectorKind: 't-slot',
    compatibilityKey: 'item:line8:slot-profile:v1',
    systemKey: 'item-line8',
    standard: 'item Line 8 manufacturer system',
    nominalGeometryMm: { nominalSlotOpening: 8 },
    supportedMatingKeys: ['item:line8:t-nut:verified', 'item:line8:fastener:verified'],
    assemblyAxis: 'host-x',
    occupancy: {
      kind: 'axis-interval',
      clearanceMm: 0.5,
      collisionPolicy: 'reject-overlap',
    },
    recipe: tSlotRecipe,
    validation: {
      geometryChecks: [
        'item Line 8 体系键完全匹配',
        '槽螺母插入模式与具体料号相符',
        '支架面与型材外表面贴合',
      ],
      requiredMetadata: ['vendorPartNumber', 'slotAxis', 'fastenerPartNumber', 'insertMode'],
      loadRatingPolicy: 'manufacturer-data-required',
    },
    interchangeability: {
      crossSystemAutomaticMatch: false,
      notes: [
        '“槽 8”不是跨厂商兼容协议。',
        '不得自动匹配 Bosch Slot 8；必须使用明确转接件或完整截面/紧固件验证结果。',
      ],
    },
    sources: [
      {
        label: 'item Line 8 profile documentation',
        url: 'https://cdn.item24.com/product-assets/DOK_PROD_7000029_%23SEN_%23AIN_%23V1.pdf',
        supports: ['item Line 8 厂商体系和截面尺寸来源'],
      },
    ],
  },
  {
    id: 'bosch-rexroth-slot8',
    schemaVersion: 1,
    label: 'Bosch Rexroth Slot 8 铝型材槽',
    kind: 't-slot',
    summary: 'Bosch Rexroth Slot 8 厂商体系内的槽螺母、支架和夹紧装配。',
    status: 'planned',
    family: 'aluminium-profile',
    connectorKind: 't-slot',
    compatibilityKey: 'bosch-rexroth:slot8:profile:v1',
    systemKey: 'bosch-rexroth-slot8',
    standard: 'Bosch Rexroth Aluminum Framing manufacturer system',
    nominalGeometryMm: { nominalSlotOpening: 8 },
    supportedMatingKeys: [
      'bosch-rexroth:slot8:t-nut:verified',
      'bosch-rexroth:slot8:fastener:verified',
    ],
    assemblyAxis: 'host-x',
    occupancy: {
      kind: 'axis-interval',
      clearanceMm: 0.5,
      collisionPolicy: 'reject-overlap',
    },
    recipe: tSlotRecipe,
    validation: {
      geometryChecks: [
        'Bosch Rexroth Slot 8 体系键完全匹配',
        '槽螺母插入模式与具体料号相符',
        '支架面与型材外表面贴合',
      ],
      requiredMetadata: ['vendorPartNumber', 'slotAxis', 'fastenerPartNumber', 'insertMode'],
      loadRatingPolicy: 'manufacturer-data-required',
    },
    interchangeability: {
      crossSystemAutomaticMatch: false,
      notes: [
        '“槽 8”不是跨厂商兼容协议。',
        '不得自动匹配 item Line 8；必须使用明确转接件或完整截面/紧固件验证结果。',
      ],
    },
    sources: [
      {
        label: 'Bosch Rexroth Aluminum Structural Framing System catalog',
        url: 'https://apps.boschrexroth.com/DCUS/2023/08.25.AT_Uploads/R999001283_2020-09_media-1.pdf',
        supports: ['Bosch Rexroth Slot 8 体系、连接件与载荷数据来源'],
      },
    ],
  },
  {
    id: 'wall-plane',
    schemaVersion: 1,
    label: '通用墙面（底座宿主）',
    kind: 'surface-pad',
    summary: '胶粘、无痕微钉或螺钉底座共享的墙面贴合与 footprint 占用宿主。',
    status: 'experimental',
    family: 'wall',
    connectorKind: 'surface-plane',
    compatibilityKey: 'snapboard:wall-plane:surface:v1',
    systemKey: 'wall-plane',
    standard: null,
    nominalGeometryMm: {},
    supportedMatingKeys: [
      'surface-pad:adhesive:verified',
      'surface-pad:micro-pin:verified',
      'surface-pad:screw:verified',
    ],
    assemblyAxis: 'host-normal',
    occupancy: {
      kind: 'surface-footprint',
      clearanceMm: 2,
      collisionPolicy: 'reject-overlap',
    },
    recipe: wallRecipe,
    validation: {
      geometryChecks: ['底座背面平面有效', 'footprint 完整落在允许区域', '未进入用户标注禁放区'],
      requiredMetadata: [
        'attachmentMethod',
        'footprint',
        'wallMaterial',
        'surfacePreparation',
      ],
      loadRatingPolicy: 'manufacturer-data-required',
    },
    interchangeability: {
      crossSystemAutomaticMatch: false,
      notes: [
        '胶粘、微钉和螺钉在几何上共享平面约束，但制造工艺、墙材适配与安全等级不同。',
        '几何匹配结果不是承重承诺。',
      ],
    },
    sources: [
      {
        label: '3M VHB design resources',
        url: 'https://www.3m.com/3M/en_US/vhb-tapes-us/resources/',
        supports: ['胶粘设计需考虑载荷模式、表面处理和工艺条件'],
      },
    ],
  },
] as const satisfies readonly HostCatalogEntry[]

export const HOST_CATALOG_BY_ID: Readonly<Record<HostCatalogId, HostCatalogEntry>> =
  Object.fromEntries(HOST_CATALOG.map((entry) => [entry.id, entry])) as unknown as Readonly<
    Record<HostCatalogId, HostCatalogEntry>
  >

/**
 * 面向 UI 的稳定导出名。保持数组为只读纯数据，调用方不得就地修改。
 */
export const ASSEMBLY_HOST_PRESETS: readonly HostCatalogEntry[] = HOST_CATALOG

export const getAssemblyHostPreset = (
  id: AssemblyHostPresetId | string,
): HostCatalogEntry | undefined => HOST_CATALOG_BY_ID[id as HostCatalogId]
