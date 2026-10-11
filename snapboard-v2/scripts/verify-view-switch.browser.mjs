import { useAppStore } from '../src/store/useAppStore'
import { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } from '../src/utils/pegboardSplit'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async check => {
  for (let n = 0; n < 100; n++) { if (check()) return; await pause(50) }
  throw new Error('3D view did not become ready')
}

export async function run() {
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220 }
  const result = splitOrthogonalPolygon({ points: [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 0, y: 200 },
  ], holes: [] }, cfg)
  if (result.panels.length !== 2) throw new Error('fixture needs two panels')
  if (!result.panels[0].edge_holes.length) throw new Error('fixture needs an edge hole')
  useAppStore.getState().newProject('view switch regression')
  const original = useAppStore.getState()
  useAppStore.setState({ splitConfig: cfg,
    splitResult: { sources: [{ contourId: 'test', name: 'test', panels: result.panels,
      warnings: result.warnings, coverageRatio: result.coverageRatio }],
      panels: result.panels, warnings: result.warnings, config: cfg, ts: Date.now() },
    ui: { ...original.ui, viewMode: '2d' } })
  await pause(100)
  const canvas2D = document.querySelector('.designer-2d-layer canvas')
  if (!canvas2D || !canvas2D.width) throw new Error('2D canvas is unavailable')

  const marks = () => performance.getEntriesByName('snapboard:board-geometry-rebuild').length
  useAppStore.getState().setUI({ viewMode: '3d' })
  await waitFor(() => document.querySelector('.viewport3d canvas'))
  const canvas = document.querySelector('.viewport3d canvas')
  if (!document.querySelector('.designer-3d-loading')) throw new Error('first transition needs visible loading state')
  await waitFor(() => !document.querySelector('.designer-3d-loading'))
  const firstBuilds = marks()
  if (!firstBuilds) throw new Error('first 3D view did not build panels')

  useAppStore.getState().setUI({ viewMode: '2d' })
  await pause(100)
  if (document.querySelector('.designer-2d-layer canvas') !== canvas2D) throw new Error('return to 2D recreated its canvas')
  if (document.querySelector('.viewport3d canvas') !== canvas) throw new Error('hidden 3D canvas was unmounted')
  if (getComputedStyle(canvas.closest('.designer-3d-layer')).visibility !== 'hidden') throw new Error('3D canvas remains visible in 2D')

  useAppStore.getState().setUI({ viewMode: '3d' })
  await waitFor(() => document.querySelector('.designer-3d-loading'))
  if (getComputedStyle(canvas2D.closest('.designer-2d-layer')).visibility !== 'hidden') throw new Error('2D canvas remains visible in 3D')
  await waitFor(() => !document.querySelector('.designer-3d-loading'))
  if (document.querySelector('.viewport3d canvas') !== canvas) throw new Error('second switch created a new WebGL canvas')
  if (marks() !== firstBuilds) throw new Error('unchanged panels rebuilt on second switch')

  const ctx2D = canvas2D.getContext('2d')
  let redraws = 0
  const originalFillRect = ctx2D.fillRect
  ctx2D.fillRect = function (...args) { redraws++; return originalFillRect.apply(this, args) }
  const changed = useAppStore.getState().splitResult
  useAppStore.setState({ splitResult: { ...changed, panels: changed.panels.map((panel, index) =>
    index ? panel : { ...panel, edge_holes: panel.edge_holes.map((hole, i) => i ? hole : { ...hole, knocked: !hole.knocked }) }), ts: Date.now() } })
  await pause(100)
  if (redraws) throw new Error('hidden 2D canvas redrew while editing 3D')
  useAppStore.getState().setUI({ viewMode: '2d' })
  await waitFor(() => redraws > 0)
  ctx2D.fillRect = originalFillRect
  if (document.querySelector('.designer-2d-layer canvas') !== canvas2D) throw new Error('changed 2D canvas was recreated')
  const beforeHiddenChange = marks()
  const current = useAppStore.getState().splitResult
  useAppStore.setState({ splitResult: { ...current, panels: current.panels.map((panel, index) =>
    index ? panel : { ...panel, edge_holes: panel.edge_holes.map((hole, i) => i ? hole : { ...hole, knocked: !hole.knocked }) }), ts: Date.now() } })
  await pause(100)
  if (marks() !== beforeHiddenChange) throw new Error('hidden 3D rebuilt before returning to it')
  useAppStore.getState().setUI({ viewMode: '3d' })
  await waitFor(() => marks() > beforeHiddenChange)
  await waitFor(() => !document.querySelector('.designer-3d-loading'))
  return { panels: result.panels.length, firstBuilds, repeatedBuilds: 0,
    changedBuilds: marks() - firstBuilds, reusedCanvas: document.querySelector('.viewport3d canvas') === canvas,
    reused2DCanvas: document.querySelector('.designer-2d-layer canvas') === canvas2D }
}
