import { useAppStore } from '../store/useAppStore'
import { currentWorkspace } from '../utils/workbenchNavigation'
import { parseSketchClipboard, pastedSketchContours, serializeSketchClipboard } from '../utils/sketchClipboard'
import { CompositeCommand } from './Command'
import { CreateContourCommand, RemoveContourCommand } from './SketchCommands'

let copied = '', lastPaste = '', pasteCount = 0, fallbackOnly = false
const enabled = () => { const s = useAppStore.getState(); return currentWorkspace(s.ui) === 'board' && s.ui.viewMode === '2d' && !s.holeEditMode }
const selection = () => {
  const s = useAppStore.getState(), ids = new Set(s.ui.selectedContourIds.length ? s.ui.selectedContourIds : s.ui.selectedContourId ? [s.ui.selectedContourId] : [])
  return s.project.parts.flatMap(p => p.features).flatMap(f => f.type === 'sketch' ? f.contours.filter(c => ids.has(c.id)) : [])
}
export function copySketchSelection(): number {
  if (!enabled()) return 0
  const contours = selection()
  if (!contours.length) return 0
  copied = serializeSketchClipboard(contours, useAppStore.getState().project.config.pixelToMM)
  lastPaste = ''; pasteCount = 0
  return contours.length
}
export function pasteSketchText(text: string): number {
  if (!enabled()) return 0
  const data = parseSketchClipboard(text)
  if (!data) return 0
  const count = lastPaste === text ? pasteCount + 1 : 1
  const s = useAppStore.getState()
  const contours = pastedSketchContours(data, s.project.config.pixelToMM, { x: count * 10, y: count * 10 })
  const before = { selectedContourIds: [...s.ui.selectedContourIds], selectedContourId: s.ui.selectedContourId, selectedConstraintId: s.ui.selectedConstraintId }
  const after = { selectedContourIds: contours.map(c => c.id), selectedContourId: contours[0].id, selectedConstraintId: null }
  const select = (selection: typeof before) => useAppStore.getState().setUI({activeTool:'select',...selection})
  s.execute(new CompositeCommand('粘贴轮廓', [...contours.map(c => new CreateContourCommand(c)),
    {label:'选择粘贴结果',affectsSketch:false,execute:()=>select(after),undo:()=>select(before),redo:()=>select(after)}]))
  lastPaste = text; pasteCount = count
  return contours.length
}
export async function copySketchToClipboard(): Promise<number> {
  const count = copySketchSelection()
  if (count) { try { await navigator.clipboard.writeText(copied); fallbackOnly = false } catch { fallbackOnly = true } }
  return count
}
export async function pasteSketchFromClipboard(): Promise<number> {
  let text = copied
  if (!fallbackOnly) { try { const system = await navigator.clipboard.readText(); if (system) text = system } catch { /* Native paste events need no extra clipboard permission. */ } }
  return text ? pasteSketchText(text) : 0
}
export function duplicateSketchSelection(): number {
  if (!enabled()) return 0
  const contours = selection()
  return contours.length ? pasteSketchText(serializeSketchClipboard(contours, useAppStore.getState().project.config.pixelToMM)) : 0
}

/** Native copy/paste events avoid permission dialogs and coexist with image/text inputs. */
export function bindSketchClipboard(): () => void {
  const editingText = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable="true"]'))
  const copy = (e: ClipboardEvent, cut = false) => {
    if (editingText(e.target) || window.getSelection()?.toString() || !e.clipboardData) return
    if (!copySketchSelection()) return
    e.clipboardData.setData('text/plain', copied)
    fallbackOnly = false
    e.preventDefault()
    if (cut) {
      const s = useAppStore.getState()
      s.execute(new CompositeCommand('剪切轮廓', selection().map(c => new RemoveContourCommand(c.id))))
      s.setUI({ selectedContourId: null, selectedContourIds: [], selectedConstraintId: null })
    }
  }
  const cut = (e: ClipboardEvent) => copy(e, true)
  const paste = (e: ClipboardEvent) => {
    if (editingText(e.target) || !enabled()) return
    const text = e.clipboardData?.getData('text/plain') || ''
    if (!text.startsWith('SNAPBOARD_SKETCH_V1\n')) return
    e.preventDefault()
    try { pasteSketchText(text) } catch (error) { window.alert(error instanceof Error ? error.message : String(error)) }
  }
  window.addEventListener('copy', copy); window.addEventListener('cut', cut); window.addEventListener('paste', paste)
  return () => { window.removeEventListener('copy', copy); window.removeEventListener('cut', cut); window.removeEventListener('paste', paste) }
}
