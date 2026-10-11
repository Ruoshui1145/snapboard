import { unzipSync, strFromU8 } from 'fflate'
import { createManufacturing3MF } from '../src/utils/export3mf'
import { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } from '../src/utils/pegboardSplit'
import { createDefaultBoardTexture } from '../src/utils/boardTexture'

export async function run() {
  const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW: 100, bedH: 100, manufacturingChamfer: 0.35 }
  const panels = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 60 }, { x: 0, y: 60 }], holes: [] }, cfg).panels
  if (panels.length !== 2) throw new Error(`expected 2 panels, got ${panels.length}`)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="60" height="60" fill="#dd2828"/><rect x="60" width="60" height="60" fill="#2048dd"/></svg>'
  const asset = { id: 'split-art', mime: 'image/svg+xml', width: 120, height: 60,
    dataUrl: `data:image/svg+xml;base64,${btoa(svg)}` }
  const layer = { id: 'split-layer', kind: 'image', visible: true, opacity: 1, assetId: asset.id,
    placement: { mode: 'free', crop: { x: 0, y: 0, width: 1, height: 1 },
      transform: { xMm: 60, yMm: 30, widthMm: 120, heightMm: 60, rotationDeg: 0, flipX: false, flipY: false } } }
  const boardTexture = { ...createDefaultBoardTexture(), enabled: true, source: 'composition',
    composition: { layers: [layer], assets: [asset] }, surfaceMode: 'snapcolor',
    modelingMode: 'vector', manufacturingContours: true, manufacturingOutput: 'perPanel' }
  const result = await createManufacturing3MF({ panels, cfg, placedParts: [], boardTexture, projectName: '浏览器逐板纹理验证' })
  const binary = result.streamedFile ? new Uint8Array(await result.streamedFile.arrayBuffer()) : result.data
  const archive = unzipSync(binary)
  const names = Object.keys(archive).sort()
  if (names.length !== 2 || names.some(name => !/-P\d+\.3mf$/.test(name))) throw new Error(`invalid bundle: ${names}`)
  const reports = names.map(name => {
    const inner = unzipSync(archive[name])
    const report = JSON.parse(strFromU8(inner['Metadata/snapboard-export-report.json']))
    if (report.plates.flatMap(plate => plate.instances).filter(item => item.kind === 'panel').length !== 1) throw new Error(`${name}: extra board`)
    if (report.textureContours.layers.length !== 5) throw new Error(`${name}: missing optical layers`)
    if (!inner['3D/Objects/object_1.model']) throw new Error(`${name}: missing geometry`)
    return { name, routes: [...new Set(report.textureContours.layers.map(layer => layer.route))],
      pitchMm: report.textureSampling?.[0]?.gridPitchMm, canvas: report.textureSampling?.[0]?.canvas,
      warnings: report.warnings }
  })
  if (reports[0].pitchMm !== reports[1].pitchMm || JSON.stringify(reports[0].canvas) !== JSON.stringify(reports[1].canvas)) {
    throw new Error('per-panel exports must share one global manufacturing grid')
  }
  await result.cleanup?.()
  return { panels: result.panelCount, fileName: result.fileName, bytes: binary.byteLength, reports,
    artifacts: [{ name: 'one-sided-bevel-per-panel.3mf', data: archive[names[0]] }] }
}
