import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(), appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
})

try {
  const [presets, splitEngine, exporter] = await Promise.all([
    server.ssrLoadModule('/src/features/shapeLibrary/presets/index.ts'),
    server.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    server.ssrLoadModule('/src/utils/export3mf.ts'),
  ])
  const heart = presets.generatePreset('heart', {
    width: 420,
    height: 420,
    lockAspect: false,
    detail: 0.6,
    smoothing: 0.45,
  })
  const cfg = { ...splitEngine.PEGBOARD_DEFAULT_CONFIG, bedW: 256, bedH: 256 }
  const split = splitEngine.splitOrthogonalPolygon({ points: heart.points, holes: [] }, cfg)
  assert.ok(split.panels.length >= 2, 'heart must exercise multi-panel curved manufacturing geometry')
  const result = await exporter.createManufacturing3MF({
    panels: split.panels,
    cfg,
    placedParts: [],
    projectName: 'heart adaptive chamfer regression',
  })
  assert.equal(result.panelCount, split.panels.length)
  assert.ok(result.data.length > 1000)
  assert.ok(result.warnings.some(warning => /制造倒角已从 0\.35mm 自动降至 0\.09mm/.test(warning)),
    'the sharp heart panel must reduce chamfer instead of exporting an open mesh or aborting')
  console.log(`heart 3MF regression: ${result.panelCount} closed panels; adaptive chamfer warning emitted`)
} finally {
  await server.close()
}
