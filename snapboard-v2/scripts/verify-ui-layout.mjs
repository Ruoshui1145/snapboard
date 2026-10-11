import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = file => readFile(file, 'utf8')
const [css, indexCss, panel, rightSidebar, calibrator, previewDialog, designer, viewport, onboarding, tip, sketchTool] = await Promise.all([
  read('src/App.css'),
  read('src/index.css'),
  read('src/components/sidebar/PartLibraryPanel.tsx'),
  read('src/components/sidebar/RightSidebar.tsx'),
  read('src/components/partLibrary/PartMountCalibrator.tsx'),
  read('src/components/partLibrary/PartPreviewDialog.tsx'),
  read('src/components/designer/DesignerApp.tsx'),
  read('src/components/viewport/SketchViewport2D.tsx'),
  read('src/components/designer/OnboardingChecklist.tsx'),
  read('src/components/designer/ContextualTip.tsx'),
  read('src/hooks/useSketchTool.ts'),
])

assert.match(indexCss, /--glass-raise:\s*rgba\(13, 18, 30, 0\.96\)/)
assert.match(indexCss, /--glass-panel:/)
assert.match(indexCss, /--glass-float:/)
assert.match(css, /\.split-sticky-head[\s\S]*max-height: 30vh/)
assert.match(css, /\.designer-right-column:not\(\.is-collapsed\)[\s\S]*position: absolute/)
assert.match(css, /@media \(pointer: coarse\)/)
assert.match(panel, /lib-search-row/)
assert.match(panel, /lib-scope-switch/)
assert.match(panel, /lib-filter-panel/)
assert.match(panel, /lib-manage-panel/)
assert.match(panel, /lib-selection-bar/)
assert.match(panel, /compatibilityForPart/)
assert.match(panel, /搜索名称、用途或规格/)
assert.doesNotMatch(panel, /lib-category-menu/)
assert.doesNotMatch(panel, /part-import-dropzone/)
assert.doesNotMatch(panel, /lib-pack-summary/)
assert.doesNotMatch(panel, /配件资源包\/对应大类文件夹/)
assert.match(panel, /lib-library-manage-button/)
assert.match(panel, /aria-label=\{`\$\{part\.name\} 的更多操作`\}/)
assert.match(panel, /lib-part-actionmenu-head/)
assert.match(panel, /编辑资料与图片/)
assert.match(panel, /lib-part-labels/)
assert.match(panel, /lib-part-dimensions-label/)
assert.doesNotMatch(panel, /aria-label="管理配件库"[^>]*>⋯<\/button>/)
assert.match(css, /\.lib-library-shell \.lib-part\.has-actions-open[^}]*z-index:\s*80/)
assert.match(css, /\.lib-part-actionmenu[^}]*z-index:\s*90/)
assert.doesNotMatch(rightSidebar, /acc-chev-box/)
assert.match(calibrator, /if \(autoSimulation\) window\.setTimeout\(\(\) => \{ void runFullSimulation\(\) \}/)
assert.match(calibrator, /每次点击“下滑”都先回到贴面位置/)
assert.match(calibrator, /resetSimulation\(\); setSelectionCommitted\(false\); setContactMode\(false\); setHoleKind\('slot'\)/)
assert.match(calibrator, /const autoOrientation = contactSource === 'manual'[\s\S]*autoOrientSelection\(activeAnchors\)/)
assert.doesNotMatch(calibrator, /autoOrientFirstAnchor\(next\)/)
assert.match(calibrator, /当前只记录孔位，不改变零件姿态/)
assert.match(previewDialog, /playAssemblyPreview/)
assert.match(previewDialog, /fitPartAnchors/)
assert.match(previewDialog, /referenceBoard\.position\.set\(center\.x - 200, center\.y - 200, box\.min\.z - 4\.8\)/)
assert.match(previewDialog, /model\.rotation\.set\(0, 0, pose\.rotationZ\)/)
assert.match(previewDialog, /对准孔位/)
assert.match(previewDialog, /插入贴面/)
assert.match(previewDialog, /零偏移锁止/)
assert.match(previewDialog, /onCalibrate/)
assert.match(css, /\.lib-part-labels[^}]*flex-wrap:\s*wrap/)
assert.match(css, /\.lib-part-labels > em, \.lib-part-labels > small[^}]*font-variant-numeric:\s*tabular-nums/)
assert.match(designer, /workbench-nav/)
assert.match(designer, /BoardDesignPanel/)
assert.match(designer, /workspaceSelection/)
assert.match(designer, /ContextualTip/)
assert.match(designer, /SettingsDialog/)
assert.match(designer, /setSettingsOpen\(true\)/)
assert.match(designer, /snapboard:open-settings/)
assert.doesNotMatch(viewport, /fillText\('从顶部工具栏选择工具开始绘制/)
assert.match(viewport, /canvas-operation-tip/)
assert.match(css, /\.canvas-operation-tip[^}]*pointer-events:\s*none/)
assert.match(onboarding, /snapboard-onboarding-dismissed/)
assert.match(tip, /empty-canvas/)
assert.match(sketchTool, /function committedGuidedPoint\(anchor: Point2D, pos: Point2D\): SnapResult/)
assert.match(sketchTool, /const sn = committedGuidedPoint\(st\.start!, pos\)/,
  'two-point and center rectangles must commit the same guided coordinate shown by the preview')
assert.match(sketchTool, /committedGuidedPoint\(st\.rectPts\[st\.rectPts\.length - 1\], pos\)/,
  'three-point rectangles must also preserve preview alignment when committed')

const [toolbar, boardDesign, workbenchCss, sketchCommands, mountScene, viewport3d, projectFile, store, occlusionPanel, layoutPanel, redrawTransaction] = await Promise.all([
  read('src/components/toolbar/Toolbar.tsx'),
  read('src/components/shapeLibrary/BoardDesignPanel.tsx'),
  read('src/workbench.css'),
  read('src/commands/SketchCommands.ts'),
  read('src/components/partLibrary/MountScenePanel.tsx'),
  read('src/components/viewport/Viewport3D.tsx'),
  read('src/utils/projectFile.ts'),
  read('src/store/useAppStore.ts'),
  read('src/components/occlusion/OcclusionPreviewPanel.tsx'),
  read('src/components/occlusion/LayoutAdvisorPanel.tsx'),
  read('src/utils/redrawTransaction.ts'),
])
assert.match(boardDesign, /mode==='draw'&&<div className="board-drawing-tools"/)
assert.match(toolbar, /drawingOpen && drawingHost && createPortal\(<div className="workbench-drawing">/)
assert.match(toolbar, /\{renderSub\(t\)\}/)
assert.doesNotMatch(toolbar, /board-active-tool-options/)
assert.doesNotMatch(designer, /has-drawing-toolbar/)
assert.match(workbenchCss, /\.workbench-drawing \.tb-groups \{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
assert.match(toolbar, /SELECT_FAMILY\.slice\(0, 2\)\.map\(renderFamilyTool\)[\s\S]*fam-clear-btn[\s\S]*SELECT_FAMILY\.slice\(2\)\.map\(renderFamilyTool\)/)
assert.match(toolbar, /export function eraserFlyoutPosition/)
assert.match(toolbar, /eraserFlyout && activeTool === 'eraser' && createPortal/)
assert.match(toolbar, /onWheel=\{event => event\.stopPropagation\(\)\}/)
assert.match(toolbar, /document\.addEventListener\('scroll', updatePosition, true\)/)
assert.match(css, /\.fam-flyout\s*\{[\s\S]*position:\s*fixed;[\s\S]*overscroll-behavior:\s*contain;/)
assert.match(toolbar, /new ClearSketchContoursCommand\(sketch\?\.id \?\? null\)/)
assert.match(toolbar, /sketches\.find\(feature => feature\.id === state\.ui\.activeSketchId\) \?\? sketches\[0\]/)
assert.match(toolbar, /可使用“撤销”或 Ctrl\+Z (?:一次)?完整恢复/)
assert.match(sketchCommands, /export class ClearSketchContoursCommand implements Command/)
assert.match(sketchCommands, /captureRedrawSnapshot\(state, sketch\?\.contours\.map\(cloneContour\) \?\? \[\]\)/)
assert.match(sketchCommands, /createClearedRedrawPatch\(state, createDefaultBoardTexture\(\)\)/)
assert.match(sketchCommands, /createRestoredRedrawPatch\(state, this\.before\)/)
assert.match(redrawTransaction, /placedParts: \[\]/)
assert.match(redrawTransaction, /splitResult: null/)
assert.match(redrawTransaction, /occlusionOverlayEnabled: false/)
assert.match(redrawTransaction, /hostInstances: \[\],[\s\S]*placements: \[\]/)
assert.match(redrawTransaction, /placedParts: snapshot\.placedParts/)
assert.match(redrawTransaction, /splitResult: snapshot\.splitResult/)
assert.match(rightSidebar, /<MountScenePanel \/>/)
assert.match(mountScene, /useAssemblyLibrary/)
assert.match(mountScene, /assemblyLibrary\.hosts\.map/)
assert.match(mountScene, /setAssemblyScene\(\{ hostPresetId: nextId \}\)/)
assert.match(viewport3d, /createAssemblyHostPreview\(assemblyHostPreset\)/)
assert.match(viewport3d, /需要兼容连接器/)
assert.match(projectFile, /assemblyScene: workspace\.assemblyScene === undefined/)
assert.match(store, /assemblyScene: createDefaultAssemblyScene\('snapboard-pegboard-v1'\)/)
assert.ok((store.match(/occlusionOverlayEnabled: false/g) ?? []).length >= 3,
  'initial state, new project and loaded workspace must not retain an old analysis overlay')
assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
assert.match(rightSidebar, /<OcclusionPreviewPanel/)
assert.match(rightSidebar, /inspect/)
assert.match(occlusionPanel, /布局目标模式/)
assert.match(occlusionPanel, /视口热力层/)
assert.match(occlusionPanel, /textureVisibleRatio/)
assert.match(viewport3d, /disposeOcclusionOverlay\(overlay\)/)
assert.match(rightSidebar, /<LayoutAdvisorPanel/)
assert.match(layoutPanel, /只给建议，不会移动配件或开孔/)
assert.match(layoutPanel, /onFocusSuggestion/)
assert.match(viewport3d, /disposeLayoutSuggestionOverlay\(overlay\)/)
console.log('ui layout regression: task-first part inserter, responsive overlay, onboarding, DOM tips and occlusion workspace OK')
