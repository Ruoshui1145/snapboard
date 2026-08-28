export type PartCategoryId = 'hook' | 'bracket' | 'shelf' | 'bin' | 'organizer' | 'fastener' | 'base' | 'cable' | 'custom'
export function categoryFromDirName(name: string): PartCategoryId
export const CATEGORY_DIRECTORY_NAMES: readonly string[]
