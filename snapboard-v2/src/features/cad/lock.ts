import type { Contour, Project } from '../../types/geometry'
const contours = (project: Project) => project.parts.flatMap(p => p.features).flatMap(f => f.type === 'sketch' ? f.contours : [])
export function captureCadGeometry(project: Project): Map<string, Contour> {
  return new Map(contours(project).filter(c => c.geometryLocked).map(c => [c.id, structuredClone(c)]))
}
/** Commands may change manufacturing role or remove an entire imported contour, never its geometry. */
export function preserveCadGeometry(project: Project, originals: Map<string, Contour>) {
  for (const c of contours(project)) {
    const original = originals.get(c.id)
    if (!original) continue
    const { type, construction, name } = c
    for (const key of Object.keys(c)) delete (c as unknown as Record<string, unknown>)[key]
    Object.assign(c, structuredClone(original), { type, name, construction: original.source?.params?.cadValid === false ? true : construction })
  }
}
