import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, appType: 'custom', server: { middlewareMode: true } })
const closeTo = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} != ${expected}`)
try {
  const { createManufacturing3MF } = await server.ssrLoadModule('/src/utils/export3mf.ts')
  const { PEGBOARD_DEFAULT_CONFIG, splitOrthogonalPolygon } = await server.ssrLoadModule('/src/utils/pegboardSplit.ts')
  // Expected plate cells are explicit, so a fixed-two-column regression cannot pass.
  const cellsByCount = new Map([
    [1, [[0, 0]]],
    [2, [[0, 0], [1, 0]]],
    [3, [[0, 0], [1, 0], [0, 1]]],
    [4, [[0, 0], [1, 0], [0, 1], [1, 1]]],
    [5, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]],
    [6, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]],
    [9, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]],
  ])
  let checkedInstances = 0
  for (const [bedW, bedH] of [[256, 256], [260, 190]]) {
    const cfg = { ...PEGBOARD_DEFAULT_CONFIG, bedW, bedH }
    const side = Math.min(bedW, bedH) * 0.76
    const split = splitOrthogonalPolygon({ points: [{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side }], holes: [] }, cfg)
    assert.equal(split.panels.length, 1)
    let baseline
    for (const [count, cells] of cellsByCount) {
      const result = await createManufacturing3MF({
        panels: Array.from({ length: count }, (_, index) => ({ ...split.panels[0], id: `plate-${index}` })),
        cfg, placedParts: [], projectName: `multiplate-${bedW}x${bedH}-${count}`,
      })
      assert.equal(result.plateCount, count)
      const zip = unzipSync(result.data)
      const model = strFromU8(zip['3D/3dmodel.model'])
      const geometry = strFromU8(zip['3D/Objects/object_1.model'])
      const settings = strFromU8(zip['Metadata/model_settings.config'])
      const project = JSON.parse(strFromU8(zip['Metadata/project_settings.config']))
      assert.deepEqual(project.printable_area, ['0x0', `${bedW}x0`, `${bedW}x${bedH}`, `0x${bedH}`])
      const transforms = [...model.matchAll(/<item[^>]+transform="([^"]+)"/g)].map(match => match[1].split(/\s+/).map(Number))
      assert.equal(transforms.length, count)
      baseline ??= transforms[0]
      const plates = [...settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)]
      assert.equal(plates.length, count)
      const vertices = [...geometry.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(match => match.slice(1).map(Number))
      assert.ok(vertices.length > 0)
      for (let index = 0; index < count; index++) {
        const transform = transforms[index]
        const [column, row] = cells[index]
        const originX = column * bedW * 1.2
        const originY = -row * bedH * 1.2
        assert.deepEqual(transform.slice(0, 9), baseline.slice(0, 9), 'packing rotation changed across equal plates')
        closeTo(transform[9] - baseline[9], originX, `plate ${index + 1} X offset`)
        closeTo(transform[10] - baseline[10], originY, `plate ${index + 1} Y offset`)
        assert.match(plates[index][1], new RegExp(`key="plater_id" value="${index + 1}"`))
        assert.equal((plates[index][1].match(/<model_instance>/g) ?? []).length, 1)
        // Check exported mesh geometry, not merely translations: every point must
        // land inside its assigned bed after the actual 3MF build transform.
        for (const [x, y, z] of vertices) {
          const localX = transform[0] * x + transform[3] * y + transform[6] * z + transform[9] - originX
          const localY = transform[1] * x + transform[4] * y + transform[7] * z + transform[10] - originY
          assert.ok(localX >= -1e-5 && localX <= bedW + 1e-5, `plate ${index + 1} mesh outside bed X`)
          assert.ok(localY >= -1e-5 && localY <= bedH + 1e-5, `plate ${index + 1} mesh outside bed Y`)
        }
        checkedInstances++
      }
      console.log(`PASS ${bedW}x${bedH}, ${count} plates: transforms, bed bounds, plate metadata`)
    }
  }
  console.log(`Multi-plate 3MF regression passed: 14 archives, ${checkedInstances} instances`)
} finally {
  await server.close()
}
