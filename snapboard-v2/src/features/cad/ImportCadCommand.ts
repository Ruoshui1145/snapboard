import type { Command } from '../../commands/Command'
import type { Contour, SketchFeature } from '../../types/geometry'
import { useAppStore } from '../../store/useAppStore'

/** Atomic append, including creation/removal of a sketch. Never replaces existing work. */
export class ImportCadCommand implements Command {
  label = 'Import CAD DXF'
  private sketchId: string | null = null
  private partId: string | null = null
  private created = false
  private previousActive: string | null = null
  private readonly contours: Contour[]
  constructor(contours: Contour[]) { this.contours = structuredClone(contours) }
  execute() {
    const s = useAppStore.getState()
    if (!s.project.parts.length) throw new Error('The project has no part to import into')
    if (!this.sketchId) {
      this.previousActive = s.ui.activeSketchId
      const part = s.project.parts.find(p => p.features.some(f => f.id === s.ui.activeSketchId && f.type === 'sketch')) ?? s.project.parts[0]
      const sketch = part.features.find(f => f.id === s.ui.activeSketchId && f.type === 'sketch')
      this.partId = part.id; this.sketchId = sketch?.id ?? crypto.randomUUID(); this.created = !sketch
    }
    const part = s.project.parts.find(p => p.id === this.partId)
    if (!part) throw new Error('CAD target part is missing')
    let sketch = part.features.find(f => f.id === this.sketchId) as SketchFeature | undefined
    if (!sketch) { sketch = { id: this.sketchId, name: 'CAD', type: 'sketch', plane: 'xy', contours: [] }; part.features.push(sketch) }
    sketch.contours.push(...structuredClone(this.contours))
    s.setUI({ activeSketchId: this.sketchId })
  }
  undo() {
    const s = useAppStore.getState(), part = s.project.parts.find(p => p.id === this.partId)
    const sketch = part?.features.find(f => f.id === this.sketchId)
    if (sketch?.type === 'sketch') {
      const ids = new Set(this.contours.map(c => c.id))
      sketch.contours = sketch.contours.filter(c => !ids.has(c.id))
      if (this.created && !sketch.contours.length && part) part.features = part.features.filter(f => f.id !== this.sketchId)
    }
    s.setUI({ activeSketchId: this.previousActive, selectedContourId: null, selectedContourIds: [] })
  }
  redo() { this.execute() }
}
