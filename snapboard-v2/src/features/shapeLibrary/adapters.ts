import type { ShapeDraft } from './model'
import {
  generatePreset,
  shapePresetCatalog,
  type ShapePresetDefinition,
  type ShapePresetId,
  type ShapePresetParams,
} from './presets'

export interface ShapeLibraryPresetItem {
  id: ShapePresetId
  kind: ShapePresetId
  name: string
  description: string
  category: ShapePresetDefinition['category']
  defaultParams: ShapePresetParams
  capabilities: ShapePresetDefinition['capabilities']
  limits: ShapePresetDefinition['limits']
}

export const shapeLibraryPresetItems: ShapeLibraryPresetItem[] = shapePresetCatalog.map(preset => ({
  id: preset.id,
  kind: preset.id,
  name: preset.name,
  description: preset.description,
  category: preset.category,
  defaultParams: { ...preset.defaultParams },
  capabilities: { ...preset.capabilities },
  limits: { ...preset.limits },
}))

export function presetToShapeDraft(
  id: ShapePresetId,
  params: Partial<ShapePresetParams>,
): ShapeDraft {
  const generated = generatePreset(id, params)
  return {
    name: generated.name,
    contours: [{ role: 'outer', points: generated.points, arcs: generated.arcs }],
    source: {
      kind: 'preset',
      id: generated.presetId,
      params: { ...generated.params },
    },
    warnings: [],
    errors: [],
    stats: {
      width: generated.bounds.width,
      height: generated.bounds.height,
      vertexCount: generated.points.length,
    },
  }
}
