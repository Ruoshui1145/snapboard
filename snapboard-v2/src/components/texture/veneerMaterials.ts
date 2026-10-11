import type { BoardTextureConfig } from '../../types/geometry'

export const VENEER_MATERIALS = [
  { name: '浅绿色 PETG 大理石', color: '#A8CDBA' },
  { name: '暖白色 PETG 大理石', color: '#E7E1D2' },
  { name: '闪耀黑 PETG', color: '#22252A' },
  { name: '石墨灰 PETG 金属', color: '#68717A' },
  { name: '深海蓝 PETG 闪粉', color: '#294D68' },
]
export const VENEER_FAMILIES = [
  { id: 'decorative', label: '装饰耗材（直接用）', hint: '大理石 · 闪耀黑 · 金属 · 闪粉' },
  { id: 'transparent', label: '透明 PETG', hint: '调整磨砂与清亮效果' },
  { id: 'wood', label: '仿木耗材', hint: '木纹走线 · 普通基材 + 薄仿木层' },
] as const
export type VeneerFamily = typeof VENEER_FAMILIES[number]['id']

export function veneerFamily(texture: Pick<BoardTextureConfig, 'surfaceMode' | 'surfaceMaterialKind'>): VeneerFamily {
  return texture.surfaceMode === 'woodgrain' ? 'wood' : texture.surfaceMaterialKind === 'transparent-petg' ? 'transparent' : 'decorative'
}

export function veneerFamilyPatch(texture: BoardTextureConfig, family: VeneerFamily): Partial<BoardTextureConfig> {
  const mode = { enabled: true, surfaceMode: family === 'wood' ? 'woodgrain' : 'veneer',
    surfaceMaterialKind: family === 'transparent' ? 'transparent-petg' : 'decorative-petg' } as const
  if (veneerFamily(texture) === family) return mode
  const material = family === 'wood' ? { name: `仿木 ${texture.woodGrain.filamentType}`, color: '#A57B4B' }
    : family === 'transparent' ? { name: '透明 PETG', color: '#E2E8E1' } : VENEER_MATERIALS[0]
  return { ...mode, surfacePrintGoal: 'standard', surfaceMaterialName: material.name, surfaceColor: material.color }
}
