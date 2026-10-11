import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const server = await createServer({ configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false } })
try {
  const { AssemblyMarkingPanel } = await server.ssrLoadModule('/src/components/assemblyMarking/AssemblyMarkingPanel.tsx')
  const { useAppStore } = await server.ssrLoadModule('/src/store/useAppStore.ts')
  const { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  const { createDefaultAssemblyMarking } = await server.ssrLoadModule('/src/utils/assemblyMarking.ts')
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, manufacturingChamfer: .25 }
  const split = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }] }, cfg)
  const through = { ...split.panels[0], latticeCutouts: [[{ x: 60, y: 60 }, { x: 140, y: 60 }, { x: 140, y: 140 }, { x: 60, y: 140 }]] }
  // React SSR reads Zustand's initial snapshot; fixtures mutate only this isolated test process.
  const initial = useAppStore.getInitialState()
  const render = (panel, marking = createDefaultAssemblyMarking()) => {
    Object.assign(initial, { splitConfig: cfg, splitResult: { ...split, panels: [panel] }, assemblyMarking: marking })
    return renderToStaticMarkup(React.createElement(AssemblyMarkingPanel, { expanded: true }))
  }
  for (const marking of [createDefaultAssemblyMarking(), { ...createDefaultAssemblyMarking(), numberPlacement: 'back' }]) {
    const html = render(through, marking)
    assert.match(html, /背面装配标识/)
    assert.doesNotMatch(html, /<option value="side"/)
    assert.match(html, /<input type="checkbox" disabled=""\/><b>背面凹刻/)
    assert.doesNotMatch(html, /查看背面标识与留白区/)
    assert.match(html, /aria-label="侧边刻深"/)
    assert.match(html, /aria-label="侧边字高"/)
  }
  const floor = { ...through, latticeFace: { layers: [{ role: 'backing', zMin: 0, zMax: .8, polygons: [[[{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }]]] }] } }
  for (const panel of [split.panels[0], floor]) {
    const html = render(panel)
    assert.match(html, /<input type="checkbox" checked=""\/><b>背面凹刻/)
    assert.match(html, /查看背面标识与留白区/)
    assert.doesNotMatch(html, /无可用背面，跳过装配背刻/)
  }
  console.log('Marking settings: through-cut skips rear IDs; side parameters stay independent; solid/support back controls and independent side parameters passed')
} finally {
  await server.close()
}
