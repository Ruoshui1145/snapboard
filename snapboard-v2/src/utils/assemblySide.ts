export type AssemblySide = 'front' | 'back'
export type AssemblyViewPreset = 'free' | AssemblySide

/**
 * 固定视角服从用户选择；自由视角按相机处在板厚中面哪一侧判断当前装配面。
 * 分割板占据 z=0..thickness，因而中面是 thickness/2。
 */
export function assemblySideForView(
  preset: AssemblyViewPreset,
  cameraZ: number,
  thickness: number,
): AssemblySide {
  if (preset === 'front' || preset === 'back') return preset
  return cameraZ < thickness / 2 ? 'back' : 'front'
}
