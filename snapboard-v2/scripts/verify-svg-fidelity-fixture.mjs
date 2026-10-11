import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { installNativeSvgDom } from './native-svg-dom.mjs'
import assert from 'node:assert/strict'

installNativeSvgDom()
const styleProbe = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:#fcfcfc;stroke-width:0.42"/></svg>', 'image/svg+xml').getElementsByTagName('path')[0]
assert.equal(styleProbe.style.fill, '#fcfcfc')
assert.equal(styleProbe.style.stroke, '')
const vite = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const [{ recognizeSvgLattice, generateSvgLattice, DEFAULT_SVG_LATTICE_OPTIONS },
    { splitOrthogonalPolygon, PEGBOARD_DEFAULT_CONFIG }, { createManufacturing3MF }] = await Promise.all([
    vite.ssrLoadModule('/src/utils/svgLattice.ts'), vite.ssrLoadModule('/src/utils/pegboardSplit.ts'),
    vite.ssrLoadModule('/src/utils/export3mf.ts'),
  ])
  const source = await readFile(process.argv[2] ?? 'output/playwright/wall-artwork.svg', 'utf8')
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 220, bedH: 220, thickness: 5 }
  const split = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }], holes: [] }, cfg)
  const art = recognizeSvgLattice(source, { x: 0, y: 0, w: 400, h: 400 })
  const whole = process.argv[3] === 'whole'
  const options = { ...DEFAULT_SVG_LATTICE_OPTIONS, coverage: whole ? 'whole' : 'artwork' }
  const stem = whole ? 'wall-fidelity-whole' : 'wall-fidelity-silhouette'
  console.log(`SVG recognized: ${art.fills.length} fills, ${art.strokes.length} strokes`)
  const started = performance.now()
  const panels = split.panels.map(panel => {
    const plan = generateSvgLattice(panel, cfg, art, 3.5, 'svg', options)
    console.log(`${panel.id}: ${plan.face?.layers.reduce((n, layer) => n + layer.polygons.reduce((n, p) => n + p.reduce((n, r) => n + r.length, 0), 0), 0)} layer points`)
    return { ...panel, latticeCutouts: plan.holes, latticeFace: plan.face }
  })
  console.log(`Four panels generated in ${Math.round(performance.now() - started)}ms`)
  const result = await createManufacturing3MF({ panels, cfg, placedParts: [], partDefinitions: [],
    onProgress: message => console.log(message) })
  await mkdir('output/playwright', { recursive: true })
  await writeFile(`output/playwright/${stem}.3mf`, result.data)
  if (!whole) await writeFile('output/playwright/wall-fidelity-test.3mf', result.data)
  const path = ring => `M${ring.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join('L')}Z`
  const shapes = panels.flatMap(panel => panel.latticeFace.layers.filter(layer => ['face', 'detail'].includes(layer.role))
    .flatMap(layer => layer.polygons.map(p => `<path d="${p.map(path).join(' ')}" fill="${layer.role === 'detail' ? panel.latticeFace.contrastColor : '#77c9b6'}" fill-rule="evenodd"/>`)))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="-10 -10 420 420"><rect x="-10" y="-10" width="420" height="420" fill="#15202a"/><g transform="translate(0 400) scale(1 -1)">${shapes.join('')}</g></svg>`
  await writeFile(`output/playwright/${stem}.svg`, svg)
  if (!whole) await writeFile('output/playwright/wall-fidelity-plan.svg', svg)
  console.log(`Real SVG manufacturing passed: ${result.panelCount} panels, ${result.plateCount} plates, ${result.data.length} bytes`)
} finally { await vite.close() }
