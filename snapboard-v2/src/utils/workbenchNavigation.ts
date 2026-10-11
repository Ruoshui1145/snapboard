export type WorkbenchWorkspace = 'board' | 'appearance' | 'parts' | 'structure' | 'inspect'
export function isWorkspaceAvailable(workspace: WorkbenchWorkspace, spatialEnabled: boolean): boolean {
  return !spatialEnabled || workspace === 'board' || workspace === 'inspect'
}
export function currentWorkspace(ui: { occlusionAnalysisOpen: boolean; textureStudioOpen: boolean; partsOpen: boolean; structureOpen?: boolean; splitOptionsOpen: boolean }, spatialEnabled = false): WorkbenchWorkspace {
  const workspace = ui.occlusionAnalysisOpen ? 'inspect' : ui.structureOpen ? 'structure' : ui.textureStudioOpen ? 'appearance' : ui.splitOptionsOpen ? 'board' : ui.partsOpen ? 'parts' : 'board'
  return isWorkspaceAvailable(workspace, spatialEnabled) ? workspace : 'board'
}
/** Navigation only: never call the split engine or clear any project data. */
export function workspaceSelection(workspace: WorkbenchWorkspace, spatialEnabled = false) {
  if (!isWorkspaceAvailable(workspace, spatialEnabled)) workspace = 'board'
  return { splitOptionsOpen: workspace === 'board', textureStudioOpen: workspace === 'appearance', partsOpen: workspace === 'parts', structureOpen: workspace === 'structure', occlusionAnalysisOpen: workspace === 'inspect', activeTool: 'select' as const }
}
