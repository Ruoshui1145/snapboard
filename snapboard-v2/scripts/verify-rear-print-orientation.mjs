import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { unzipSync, strFromU8 } from 'fflate'
import { normalizeOrder, buildMarkPlan, DEFAULT_CODES } from '../../apps/order-workbench/shared/domain.mjs'

const output = '../output/order-feedback-orientation-20261004'
await mkdir(output, { recursive: true })
const originalFile = '已保存项目/制造导出/003-排盘-2盘-2026-10-04T11-55-21.3mf'
const originalBytes = await readFile(originalFile), originalHash = createHash('sha256').update(originalBytes).digest('hex')
const workspace = JSON.parse(await readFile('已保存项目/003.snapboard', 'utf8')).workspace
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } })
try {
  const [exporter, solids, marking] = await Promise.all(['export3mf', 'spatialSolid', 'assemblyMarking'].map(name => server.ssrLoadModule('/src/utils/' + name + '.ts')))
  const wasm = await solids.spatialManifold()
  const decode = bytes => {
    const zip = unzipSync(bytes), xml = strFromU8(zip['3D/Objects/object_1.model'])
    return { zip, meshes: [...xml.matchAll(/<mesh>([\s\S]*?)<\/mesh>/g)].map(match => {
      const vertices = [...match[1].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].flatMap(v => v.slice(1).map(Number))
      const triangles = [...match[1].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].flatMap(t => t.slice(1).map(Number))
      const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(vertices), triVerts: Uint32Array.from(triangles), tolerance: 1e-5 })
      mesh.merge(); const solid = new wasm.Manifold(mesh)
      assert.equal(solid.status(), 'NoError', 'actual manufacturing mesh stays closed')
      return solid
    }) }
  }
  const input = { cfg: workspace.splitConfig, panels: workspace.splitResult.panels, placedParts: [], boardTexture: workspace.boardTexture,
    assemblyMarking: workspace.assemblyMarking, projectName: '003-朝向开发验证' }
  const plain = decode((await exporter.createManufacturing3MF({ ...input, assemblyMarking: { ...input.assemblyMarking, enabled: false } })).data)
  const old = decode(originalBytes)
  assert.equal(old.zip['Metadata/snapboard-order-engraving.json'], undefined, 'reported file is a normal export without an order number')
  const markedResult = await exporter.createManufacturing3MF(input), marked = decode(markedResult.data)
  assert.equal(marked.meshes.length, plain.meshes.length)
  const measurements = []
  for (let i = 0; i < marked.meshes.length; i++) {
    const panel = input.panels[i], t = input.cfg.thickness
    const cut = plain.meshes[i].subtract(marked.meshes[i]), added = marked.meshes[i].subtract(plain.meshes[i])
    const tolerance = plain.meshes[i].volume() * 1e-6
    assert.ok(cut.volume() > 1, `panel and seam marks physically cut the model: volume=${cut.volume()}, warnings=${JSON.stringify(markedResult.warnings)}`)
    assert.ok(added.volume() < tolerance, `no raised marks or new material: panel=${i}, added=${added.volume()}, tolerance=${tolerance}, bounds=${JSON.stringify(added.boundingBox())}`)
    const lower=wasm.Manifold.cube([panel.w,panel.h,t-input.assemblyMarking.depth-.0001]), below=cut.intersect(lower)
    assert.ok(below.volume()<tolerance, `all rear marking cavities open at the upper printed face: below=${below.volume()}, bounds=${JSON.stringify(cut.boundingBox())}`)
    const oldNeutral = plain.meshes[i].rotate([0, 180, 0]).translate([panel.w, 0, t])
    const oldCut = oldNeutral.subtract(old.meshes[i])
    const oldUpper=wasm.Manifold.cube([panel.w,panel.h,t]).translate([0,0,input.assemblyMarking.depth+.0001]), oldAbove=oldCut.intersect(oldUpper)
    assert.ok(oldAbove.volume()<tolerance,'reproduce the reported bed-facing cavity')
    measurements.push({ panel: 'P' + String(i + 1).padStart(2, '0'), oldCutZ: oldCut.boundingBox(), newCutZ: cut.boundingBox(), removedMm3: cut.volume(), newRemovalBelowRearBandMm3:below.volume(), oldRemovalAboveBedBandMm3:oldAbove.volume() })
    below.delete(); lower.delete(); oldAbove.delete(); oldUpper.delete(); oldCut.delete(); oldNeutral.delete(); cut.delete(); added.delete()
  }
  await writeFile(output + '/003-rear-up-verification.3mf', markedResult.data)
  const normalized = normalizeOrder({ customer: { name: '开发虚构订单' }, product: { name: '003-开发验证', layoutCode: 'F', mappingCode: 'M0', colourCode: 'C00',
    widthMm: 320, heightMm: 220, thicknessMm: input.cfg.thickness }, panels: input.panels.map((p, i) => ({ code: 'P' + String(i + 1).padStart(2, '0'),
      quantity: 1, sourcePanelId: p.id, widthMm: p.w, heightMm: p.h })), kitQuantity: 1, designFingerprint: 'e'.repeat(64) }, DEFAULT_CODES)
  const plan = { ...buildMarkPlan({ ...normalized, number: 'SB-20990101-9999', markingKey: '9901019999', revision: 1 }), ...{
    designFingerprint: normalized.designFingerprint, kitQuantity: 1, totalPanelCount: 2, perSetPanelCount: 2 } }
  const ordered = await exporter.createManufacturing3MF({ ...input, orderEngraving: plan })
  await writeFile(output + '/003-fictitious-order-verification.zip', ordered.data)
  const orderFiles = Object.entries(unzipSync(ordered.data)).filter(([name]) => name.endsWith('.3mf'))
  assert.equal(orderFiles.length, 2)
  for (const [i, [, bytes]] of orderFiles.entries()) {
    const actual = decode(bytes), trace = JSON.parse(strFromU8(actual.zip['Metadata/snapboard-order-engraving.json']))
    assert.equal(trace.surface, 'side'); assert.deepEqual(trace.panels[0].lines, [plan.orderNumber])
    const sideCut = marked.meshes[i].subtract(actual.meshes[0])
    assert.ok(sideCut.volume() > 1, 'full order number cuts the already oriented plate edge')
    const interior = wasm.Manifold.cube([input.panels[i].w, input.panels[i].h - .2401, input.cfg.thickness])
    const intrusion = sideCut.intersect(interior)
    assert.ok(intrusion.volume() < marked.meshes[i].volume() * 1e-6, 'order text remains on the side after the physical rotation')
    sideCut.delete(); interior.delete(); intrusion.delete(); actual.meshes.forEach(s => s.delete())
    await writeFile(output + `/003-side-order-panel-${i + 1}.3mf`, bytes)
  }
  assert.deepEqual(workspace.assemblyMarking, input.assemblyMarking, 'global engraving preferences are not changed')
  assert.equal(createHash('sha256').update(await readFile(originalFile)).digest('hex'), originalHash, 'user original is untouched')
  await writeFile(output + '/geometry-evidence.json', JSON.stringify({ originalSha256: originalHash, originalHasOrder: false, originalProjectLinked: Boolean(workspace.orderLink),
    originalUntouched: true, inputProject: '003', fictitiousOrder: plan.orderNumber, measurements }, null, 2))
  for (const group of [plain, marked, old]) group.meshes.forEach(s => s.delete())
  console.log('PASS actual 003: old rear cuts reproduce Z=0; new cuts open upward; both full side order numbers survive rotation, closed meshes, no added material, original untouched')
} finally { await server.close() }
