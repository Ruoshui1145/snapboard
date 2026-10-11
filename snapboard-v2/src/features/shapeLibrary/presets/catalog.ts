import type { GeneratedShape, Point2D, ShapePresetDefinition, ShapePresetId, ShapePresetParams } from './types'
import { fitOutlineToDimensions, resolvePresetParams } from './geometry'
import {
  createRectangleOutline, createEllipseOutline, createRoundedRectangleOutline,
  createArchOutline,
  createCapsuleOutline,
  createCloudOutline,
  createCrescentOutline,
  createHeartOutline,
  createHouseOutline,
  createStarOutline,
  createWaveOutline,
} from './generators'

type OutlineGenerator = (params: ShapePresetParams) => Point2D[]

const DEFAULT_LIMITS = Object.freeze({
  minWidth: 20,
  minHeight: 20,
  maxWidth: 2000,
  maxHeight: 2000,
})

const DEFAULT_CAPABILITIES = Object.freeze({ detail: true, smoothing: true, flipX: true, flipY: true })

function params(width: number, height: number, smoothing = 0.65): Readonly<ShapePresetParams> {
  return Object.freeze({
    width,
    height,
    lockAspect: false,
    flipX: false,
    flipY: false,
    detail: 0.55,
    smoothing,
  })
}

interface DefinitionSource extends Omit<ShapePresetDefinition, 'generate'> {
  outline: OutlineGenerator
}

function definePreset(source: DefinitionSource): ShapePresetDefinition {
  const { outline, ...metadata } = source
  const generate = (input: Partial<ShapePresetParams> = {}): GeneratedShape => {
    const resolved = resolvePresetParams(source.defaultParams, source.nativeAspectRatio, input)
    if(source.id==='square'||source.id==='circle'){resolved.height=resolved.width;resolved.lockAspect=true}
    const fitted = fitOutlineToDimensions(
      outline(resolved),
      resolved.width,
      resolved.height,
      resolved.flipX,
      resolved.flipY,
    )
    return {
      presetId: source.id,
      name: source.name,
      closed: true,
      points: fitted.points,
      arcs: [],
      bounds: fitted.bounds,
      params: resolved,
    }
  }
  return Object.freeze({ ...metadata, generate })
}

export const SHAPE_PRESETS: readonly ShapePresetDefinition[] = Object.freeze([
  ...([
    ['rectangle','矩形','通用矩形板，宽高可分别调整。',320,220,createRectangleOutline],
    ['square','正方形','等边板型，修改任意边长保持正方形。',240,240,createRectangleOutline],
    ['rounded-rectangle','圆角矩形','可设置实际圆角半径的通用板型。',320,220,createRoundedRectangleOutline],
    ['circle','圆形','按直径设置的圆形板。',240,240,createEllipseOutline],
    ['ellipse','椭圆','长短轴可分别调整的椭圆板。',320,220,createEllipseOutline],
  ] as const).map(([id,name,description,width,height,outline])=>definePreset({
    id,name,description,category:'basic',nativeAspectRatio:width/height,
    defaultParams:{...params(width,height,0),...(id==='rounded-rectangle'?{cornerRadius:12}:{})},
    limits:DEFAULT_LIMITS,capabilities:{...DEFAULT_CAPABILITIES,detail:false,smoothing:false},outline,
  })),
  definePreset({
    id: 'cloud',
    name: '云朵',
    description: '原创通用云形，采用宽圆角和多层柔和起伏。',
    category: 'organic',
    nativeAspectRatio: 1.55,
    defaultParams: params(420, 270, 0.78),
    limits: DEFAULT_LIMITS,
    capabilities: DEFAULT_CAPABILITIES,
    outline: createCloudOutline,
  }),
  definePreset({
    id: 'arch',
    name: '拱门',
    description: '半圆顶与直立侧边组成的经典拱形板。',
    category: 'architectural',
    nativeAspectRatio: 0.72,
    defaultParams: params(280, 390, 0.75),
    limits: DEFAULT_LIMITS,
    capabilities: DEFAULT_CAPABILITIES,
    outline: createArchOutline,
  }),
  definePreset({
    id: 'heart',
    name: '爱心',
    description: '连续曲线构成的对称爱心装饰板。',
    category: 'decorative',
    nativeAspectRatio: 1,
    defaultParams: params(320, 320),
    limits: DEFAULT_LIMITS,
    capabilities: { ...DEFAULT_CAPABILITIES, smoothing: false },
    outline: createHeartOutline,
  }),
  definePreset({
    id: 'star',
    name: '星形',
    description: '内角不过深的五角星，兼顾造型与结构强度。',
    category: 'decorative',
    nativeAspectRatio: 1,
    defaultParams: params(320, 320, 0.7),
    limits: DEFAULT_LIMITS,
    capabilities: { ...DEFAULT_CAPABILITIES, detail: false },
    outline: createStarOutline,
  }),
  definePreset({
    id: 'crescent',
    name: '月牙',
    description: '末端留有厚度的圆润月牙，避免零宽尖端。',
    category: 'decorative',
    nativeAspectRatio: 0.72,
    defaultParams: params(260, 360, 0.72),
    limits: DEFAULT_LIMITS,
    capabilities: DEFAULT_CAPABILITIES,
    outline: createCrescentOutline,
  }),
  definePreset({
    id: 'wave',
    name: '波浪',
    description: '保持稳定板厚的双边波浪轮廓。',
    category: 'organic',
    nativeAspectRatio: 1.8,
    defaultParams: params(450, 250, 0.6),
    limits: DEFAULT_LIMITS,
    capabilities: DEFAULT_CAPABILITIES,
    outline: createWaveOutline,
  }),
  definePreset({
    id: 'house',
    name: '小屋',
    description: '宽屋身与缓屋顶组成的简洁房屋轮廓。',
    category: 'architectural',
    nativeAspectRatio: 1,
    defaultParams: params(340, 340),
    limits: DEFAULT_LIMITS,
    capabilities: { ...DEFAULT_CAPABILITIES, detail: false, smoothing: false },
    outline: createHouseOutline,
  }),
  definePreset({
    id: 'capsule',
    name: '圆角胶囊',
    description: '两端半圆、中央等宽的横向或纵向胶囊板。',
    category: 'basic',
    nativeAspectRatio: 2,
    defaultParams: params(420, 210, 0.85),
    limits: DEFAULT_LIMITS,
    capabilities: { ...DEFAULT_CAPABILITIES, smoothing: false },
    outline: createCapsuleOutline,
  }),
])

/** Readable catalog alias for feature-layer adapters. */
export const shapePresetCatalog = SHAPE_PRESETS

const PRESET_BY_ID = new Map<ShapePresetId, ShapePresetDefinition>(
  SHAPE_PRESETS.map(definition => [definition.id, definition]),
)

export function getShapePreset(id: ShapePresetId): ShapePresetDefinition {
  const definition = PRESET_BY_ID.get(id)
  if (!definition) throw new RangeError(`Unknown shape preset: ${id}`)
  return definition
}

export function generatePreset(
  id: ShapePresetId,
  input: Partial<ShapePresetParams> = {},
): GeneratedShape {
  return getShapePreset(id).generate(input)
}

/** Backward-compatible descriptive alias for callers that prefer an explicit noun. */
export const generatePresetShape = generatePreset
