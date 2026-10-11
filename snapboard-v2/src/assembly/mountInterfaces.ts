import type {
  MountHoleKind,
  PartMountAnchor,
  PartMountDefinition,
} from '../partLibrary/types'

/**
 * 通用装配数据契约。
 *
 * 约定：
 * - 所有长度统一使用毫米，角度统一使用度；
 * - 坐标均位于所属宿主或连接器的局部坐标系；
 * - 数据只使用 JSON 可表达的值，便于项目保存、3MF 元数据和云端接口复用；
 * - `interfaceId` 标识宿主上的可安装界面，`connectorId` 标识零件上的安装连接器。
 */

export type MountInterfaceKind =
  | 'hole-pattern'
  | 'rail-clip'
  | 't-slot'
  | 'surface-pad'

export type MountVector2 = [number, number]
export type MountVector3 = [number, number, number]
export type MountQuaternion = [number, number, number, number]

/** 可序列化的刚体坐标系，四元数顺序为 [x, y, z, w]。 */
export interface MountFrame {
  positionMm: MountVector3
  rotation: MountQuaternion
}

/** 单位刚体变换。调用方复制后使用，避免直接修改共享常量。 */
export const IDENTITY_MOUNT_FRAME: MountFrame = {
  positionMm: [0, 0, 0],
  rotation: [0, 0, 0, 1],
}

/** 装配对象引用；支持“墙面 → 导轨 → 模块”等多级宿主关系。 */
export interface MountHostReference {
  hostInstanceId: string
  interfaceId: string
}

export interface MountHoleFeature {
  id: string
  kind: MountHoleKind
  positionMm: MountVector3
  /** 长圆孔的长轴方向；圆孔可省略。 */
  axis?: MountVector3
  widthMm?: number
  lengthMm?: number
  diameterMm?: number
}

/** EN 60715 常见 35 mm 帽型导轨，也允许保存实测自定义截面。 */
export interface DinRailProfile {
  standard: 'EN60715' | 'custom'
  profile: 'TH35-7.5' | 'TH35-15' | 'custom'
  widthMm: number
  depthMm: number
  /** 自定义或供应商系列名，例如某种 C45 兼容导轨。 */
  series?: string
  lipThicknessMm?: number
}

/**
 * 型材槽的几何签名。不能只依赖“槽 8”名称，否则不同厂商的滑块可能误配。
 */
export interface GrooveSignature {
  system: string
  series?: string
  openingWidthMm: number
  cavityWidthMm?: number
  cavityDepthMm: number
  neckWidthMm?: number
  undercutDepthMm?: number
  compatibleThreads?: string[]
}

export type TSlotInsertMode = 'end-feed' | 'drop-in' | 'swivel-in'
export type SurfaceAttachmentMethod = 'adhesive' | 'micro-pin' | 'screw' | 'dual-lock'

export interface AdhesiveAttachmentProcess {
  method: 'adhesive' | 'dual-lock'
  productFamily?: string
  compatibleSubstrates?: string[]
  minimumPressSeconds?: number
  cureHours?: number
  /** 仅作工程提示，不等同于软件承诺的安全载荷。 */
  ratedShearN?: number
  ratedPeelN?: number
}

export interface MicroPinAttachmentProcess {
  method: 'micro-pin'
  pinCount: number
  pinDiameterMm?: number
  penetrationDepthMm?: number
  /** 针相对墙面法线的方向，便于表达斜插无痕钉。 */
  insertionDirection: MountVector3
}

export interface ScrewAttachmentProcess {
  method: 'screw'
  thread?: string
  screwCount: number
  pilotHoleDiameterMm?: number
  embedDepthMm?: number
}

export type SurfaceAttachmentProcess =
  | AdhesiveAttachmentProcess
  | MicroPinAttachmentProcess
  | ScrewAttachmentProcess

/** 宿主界面的公共字段。 */
export interface MountHostInterfaceBase<K extends MountInterfaceKind> {
  id: string
  kind: K
  label: string
  frame: MountFrame
  enabled?: boolean
}

export interface HolePatternHostInterface extends MountHostInterfaceBase<'hole-pattern'> {
  holes: MountHoleFeature[]
  patternId?: string
  boardThicknessMm?: number
  surfaceNormal?: MountVector3
}

export interface RailHostInterface extends MountHostInterfaceBase<'rail-clip'> {
  profile: DinRailProfile
  axis: MountVector3
  usableLengthMm: number
  /** 沿导轨轴的可用起点；终点为 origin + usableLength。 */
  originMm?: number
}

export interface TSlotHostInterface extends MountHostInterfaceBase<'t-slot'> {
  groove: GrooveSignature
  axis: MountVector3
  usableLengthMm: number
  originMm?: number
  supportedInsertModes: TSlotInsertMode[]
}

export interface SurfacePadHostInterface extends MountHostInterfaceBase<'surface-pad'> {
  normal: MountVector3
  /** 宿主局部平面中的允许安装边界。为空时由宿主网格决定。 */
  boundaryMm?: MountVector2[]
  supportedMethods: SurfaceAttachmentMethod[]
  substrate?: string
}

export type MountHostInterface =
  | HolePatternHostInterface
  | RailHostInterface
  | TSlotHostInterface
  | SurfacePadHostInterface

/** 可被实例化的宿主定义，例如一块板、一段导轨或一根铝型材。 */
export interface MountHostDefinition {
  id: string
  schemaVersion: 1
  label: string
  interfaces: MountHostInterface[]
}

/**
 * 场景中的宿主实例。一个已安装零件也可以继续提供 interfaces，形成装配树。
 */
export interface MountHostInstance {
  id: string
  definitionId: string
  transform: MountFrame
  parent?: MountHostReference
  /** 将该宿主安装到 parent 的 placement，便于删除或更新整棵子树。 */
  mountedByPlacementId?: string
}

export type MountAxisLock = 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz'

export interface AlignAssemblyStep {
  id: string
  type: 'align'
  label?: string
  sourceFeatureIds: string[]
  target: 'compatible-features' | 'interface-axis' | 'interface-plane'
  lockAxes?: MountAxisLock[]
}

export interface TranslateAssemblyStep {
  id: string
  type: 'translate'
  label?: string
  axis: MountVector3
  until:
    | { kind: 'distance'; distanceMm: number }
    | { kind: 'contact'; sourceFeatureId?: string; clearanceMm?: number }
  speedMmPerSecond?: number
}

export interface RotateAssemblyStep {
  id: string
  type: 'rotate'
  label?: string
  axis: MountVector3
  pivotFeatureId?: string
  until:
    | { kind: 'angle'; angleDeg: number }
    | { kind: 'latch-contact'; targetFeatureId?: string }
  snapAnglesDeg?: number[]
}

export interface SlideAssemblyStep {
  id: string
  type: 'slide'
  label?: string
  axis: MountVector3 | 'host-axis'
  until:
    | { kind: 'distance'; distanceMm: number }
    | { kind: 'end-stop'; clearanceMm?: number }
    | { kind: 'position'; positionMm: number }
}

export interface LatchAssemblyStep {
  id: string
  type: 'latch'
  label?: string
  latchFeatureId: string
  targetFeatureId?: string
  releaseTravelMm?: number
}

export interface ClampAssemblyStep {
  id: string
  type: 'clamp'
  label?: string
  fastenerId?: string
  thread?: string
  torqueNm?: number
}

export interface PressAssemblyStep {
  id: string
  type: 'press'
  label?: string
  footprintFeatureId: string
  durationSeconds?: number
  pressureKPa?: number
}

export interface InsertPinsAssemblyStep {
  id: string
  type: 'insert-pins'
  label?: string
  pinFeatureIds: string[]
  direction: MountVector3
  depthMm?: number
}

export type AssemblyStep =
  | AlignAssemblyStep
  | TranslateAssemblyStep
  | RotateAssemblyStep
  | SlideAssemblyStep
  | LatchAssemblyStep
  | ClampAssemblyStep
  | PressAssemblyStep
  | InsertPinsAssemblyStep

export interface MountConnectorBase<K extends MountInterfaceKind> {
  id: string
  kind: K
  label: string
  localFrame: MountFrame
  assemblySteps: AssemblyStep[]
}

export interface HolePatternConnectorAnchor {
  id: string
  label?: string
  accepts: MountHoleKind[]
  positionMm: MountVector3
  normal?: MountVector3
  /** 安装面内的长轴方向，第三维补零后保存。 */
  axis?: MountVector3
  profile?: {
    widthMm: number
    lengthMm: number
    axis?: MountVector3
  }
  required: boolean
}

export interface HolePatternMountConnector extends MountConnectorBase<'hole-pattern'> {
  anchors: HolePatternConnectorAnchor[]
  contactPlaneOffsetMm?: number
  legacy?: {
    source: 'PartMountDefinition'
    mode: PartMountDefinition['mode']
    calibrationRequired?: boolean
    expected?: MountHoleKind[]
  }
}

export interface RailClipMountConnector extends MountConnectorBase<'rail-clip'> {
  compatibleProfiles: DinRailProfile[]
  clipAxis: MountVector3
  upperHookFeatureId: string
  lowerLatchFeatureId: string
  /** 未锁止时是否允许沿导轨移动。 */
  slideBeforeLock?: boolean
  occupiedLengthMm: number
}

export interface TSlotMountConnector extends MountConnectorBase<'t-slot'> {
  compatibleGrooves: GrooveSignature[]
  supportedInsertModes: TSlotInsertMode[]
  selectedInsertMode?: TSlotInsertMode
  nutFeatureId?: string
  clampPlaneFeatureId: string
  fastener?: {
    id?: string
    thread: string
    lengthMm?: number
  }
  occupiedLengthMm: number
}

export interface SurfacePadMountConnector extends MountConnectorBase<'surface-pad'> {
  contactPlaneFeatureId: string
  /** 连接器局部接触平面中的闭合多边形。 */
  footprintMm: MountVector2[]
  process: SurfaceAttachmentProcess
  pinFeatureIds?: string[]
}

export type MountConnector =
  | HolePatternMountConnector
  | RailClipMountConnector
  | TSlotMountConnector
  | SurfacePadMountConnector

/** 面向项目存储和外部 API 的稳定名称。 */
export type MountConnectorDefinition = MountConnector

/** 离散孔位占用：用于洞洞板孔、螺钉孔等有限目标。 */
export interface DiscreteHoleOccupancy {
  kind: 'discrete-holes'
  targetIds: string[]
}

/** 连续轴区间占用：用于导轨和型材槽，单位为宿主轴上的毫米坐标。 */
export interface AxisIntervalOccupancy {
  kind: 'axis-interval'
  startMm: number
  endMm: number
  laneId?: string
}

/** 二维区域占用：用于胶粘底座、无痕钉底座及墙面禁放区检测。 */
export interface FootprintOccupancy {
  kind: 'footprint'
  polygonMm: MountVector2[]
  clearanceMm?: number
}

export type MountOccupancy =
  | DiscreteHoleOccupancy
  | AxisIntervalOccupancy
  | FootprintOccupancy

export type MountPlacementState = 'preview' | 'aligned' | 'inserted' | 'locked'

/**
 * 一次装配的持久化结果。宿主引用由 hostInstanceId + interfaceId 唯一确定，
 * 因此既能装到根墙面，也能装到导轨或其他配件所提供的二级宿主上。
 */
export interface MountPlacement {
  id: string
  partInstanceId: string
  connectorId: string
  hostInstanceId: string
  interfaceId: string
  transform: MountFrame
  state: MountPlacementState
  occupancy: MountOccupancy[]
  completedStepIds?: string[]
}

/** 面向场景存储的稳定名称，和单次装配计算结果使用同一结构。 */
export type SceneMountPlacement = MountPlacement

/**
 * 项目文件中的完整装配场景。定义和实例分离，可在离线打开项目时保留自定义宿主，
 * 也允许只保存 hostPresetId，由运行时加载内置的墙面、TH35 或型材预设。
 */
export interface AssemblySceneState {
  schemaVersion: 1
  hostPresetId?: string
  hostDefinitions: MountHostDefinition[]
  hostInstances: MountHostInstance[]
  connectorDefinitions: MountConnectorDefinition[]
  placements: SceneMountPlacement[]
}

/** 创建无共享可变数组的空装配场景。 */
export const createDefaultAssemblyScene = (
  hostPresetId?: string,
): AssemblySceneState => ({
  schemaVersion: 1,
  ...(hostPresetId ? { hostPresetId } : {}),
  hostDefinitions: [],
  hostInstances: [],
  connectorDefinitions: [],
  placements: [],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isMountFrame = (value: unknown): value is MountFrame => {
  if (!isRecord(value)) return false
  const position = value.positionMm
  const rotation = value.rotation
  return Array.isArray(position)
    && position.length === 3
    && position.every(item => typeof item === 'number' && Number.isFinite(item))
    && Array.isArray(rotation)
    && rotation.length === 4
    && rotation.every(item => typeof item === 'number' && Number.isFinite(item))
}

const isHostDefinition = (value: unknown): value is MountHostDefinition =>
  isRecord(value)
  && typeof value.id === 'string'
  && value.schemaVersion === 1
  && typeof value.label === 'string'
  && Array.isArray(value.interfaces)

const isHostInstance = (value: unknown): value is MountHostInstance =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.definitionId === 'string'
  && isMountFrame(value.transform)

const isConnectorDefinition = (value: unknown): value is MountConnectorDefinition =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.label === 'string'
  && (
    value.kind === 'hole-pattern'
    || value.kind === 'rail-clip'
    || value.kind === 't-slot'
    || value.kind === 'surface-pad'
  )
  && isMountFrame(value.localFrame)
  && Array.isArray(value.assemblySteps)

const isScenePlacement = (value: unknown): value is SceneMountPlacement =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.partInstanceId === 'string'
  && typeof value.connectorId === 'string'
  && typeof value.hostInstanceId === 'string'
  && typeof value.interfaceId === 'string'
  && isMountFrame(value.transform)
  && (
    value.state === 'preview'
    || value.state === 'aligned'
    || value.state === 'inserted'
    || value.state === 'locked'
  )
  && Array.isArray(value.occupancy)

/**
 * 解析项目中的未知装配场景。旧项目、损坏字段或未来版本字段不会阻断打开：
 * 非法集合回退为空数组，合法的当前版本记录按顶层复制后返回，不修改输入对象。
 */
export const normalizeAssemblyScene = (value: unknown): AssemblySceneState => {
  if (!isRecord(value)) return createDefaultAssemblyScene()

  const hostPresetId = typeof value.hostPresetId === 'string'
    ? value.hostPresetId
    : undefined
  const hostDefinitions = Array.isArray(value.hostDefinitions)
    ? value.hostDefinitions.filter(isHostDefinition).map(definition => ({ ...definition }))
    : []
  const hostInstances = Array.isArray(value.hostInstances)
    ? value.hostInstances.filter(isHostInstance).map(instance => ({ ...instance }))
    : []
  const connectorDefinitions = Array.isArray(value.connectorDefinitions)
    ? value.connectorDefinitions.filter(isConnectorDefinition).map(connector => ({ ...connector }))
    : []
  const placements = Array.isArray(value.placements)
    ? value.placements.filter(isScenePlacement).map(placement => ({ ...placement }))
    : []

  return {
    schemaVersion: 1,
    ...(hostPresetId ? { hostPresetId } : {}),
    hostDefinitions,
    hostInstances,
    connectorDefinitions,
    placements,
  }
}

export interface LegacyMountAdapterOptions {
  connectorId?: string
  label?: string
  localFrame?: MountFrame
}

const normalizeLegacyAccepts = (
  accepts: PartMountAnchor['accepts'],
): MountHoleKind[] => {
  let slot = false
  let round = false

  for (const kind of accepts) {
    if (kind === 'slot' || kind === 'either') slot = true
    if (kind === 'round' || kind === 'either') round = true
  }

  const normalized: MountHoleKind[] = []
  if (slot) normalized.push('slot')
  if (round) normalized.push('round')
  return normalized
}

const adaptLegacyAnchor = (anchor: PartMountAnchor): HolePatternConnectorAnchor => ({
  id: anchor.id,
  label: anchor.label,
  accepts: normalizeLegacyAccepts(anchor.accepts),
  positionMm: [...anchor.position],
  normal: anchor.normal ? [...anchor.normal] : undefined,
  axis: anchor.axis ? [anchor.axis[0], anchor.axis[1], 0] : undefined,
  profile: anchor.profile
    ? {
        widthMm: anchor.profile.width,
        lengthMm: anchor.profile.length,
        axis: anchor.profile.axis
          ? [anchor.profile.axis[0], anchor.profile.axis[1], 0]
          : undefined,
      }
    : undefined,
  required: anchor.required ?? true,
})

/**
 * 将当前配件库的 PartMountDefinition 无损提升为通用洞位连接器。
 * 旧数据的正数 slideY 表示在局部 -Y 方向下滑；负数则反向。
 */
export const adaptPartMountDefinition = (
  mount: PartMountDefinition,
  options: LegacyMountAdapterOptions = {},
): HolePatternMountConnector => {
  const anchors = mount.anchors.map(adaptLegacyAnchor)
  const assemblySteps: AssemblyStep[] = []

  if (anchors.length > 0) {
    assemblySteps.push({
      id: 'align-holes',
      type: 'align',
      label: '对齐安装孔位',
      sourceFeatureIds: anchors.map(anchor => anchor.id),
      target: 'compatible-features',
      lockAxes: ['x', 'y', 'rx', 'ry', 'rz'],
    })
  }

  if (mount.contactZ !== undefined || anchors.length > 0) {
    assemblySteps.push({
      id: 'insert-until-contact',
      type: 'translate',
      label: '插入并贴合接触面',
      axis: [0, 0, -1],
      until: {
        kind: 'contact',
        clearanceMm: 0,
      },
    })
  }

  if (mount.slideY !== undefined && mount.slideY !== 0) {
    assemblySteps.push({
      id: 'slide-to-lock',
      type: 'slide',
      label: '沿长孔下滑至锁止位置',
      axis: [0, mount.slideY > 0 ? -1 : 1, 0],
      until: {
        kind: 'distance',
        distanceMm: Math.abs(mount.slideY),
      },
    })
  }

  return {
    id: options.connectorId ?? 'legacy-hole-pattern',
    kind: 'hole-pattern',
    label: options.label ?? '洞洞板安装连接器',
    localFrame: options.localFrame
      ? {
          positionMm: [...options.localFrame.positionMm],
          rotation: [...options.localFrame.rotation],
        }
      : {
          positionMm: [...IDENTITY_MOUNT_FRAME.positionMm],
          rotation: [...IDENTITY_MOUNT_FRAME.rotation],
        },
    assemblySteps,
    anchors,
    contactPlaneOffsetMm: mount.contactZ,
    legacy: {
      source: 'PartMountDefinition',
      mode: mount.mode,
      calibrationRequired: mount.calibrationRequired,
      expected: mount.expected ? [...mount.expected] : undefined,
    },
  }
}
