import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root: projectRoot, appType: 'custom', server: { middlewareMode: true } })
try {
  const { buildTextureEdgeSealMask, isTextureEdgeSealCell } = await server.ssrLoadModule('/src/utils/textureEdgeSeal.ts')
  assert.equal(isTextureEdgeSealCell(0.45, 0.1, true, 0.5), true)
  assert.equal(isTextureEdgeSealCell(0.8, 0.1, true, 0.5), false)
  assert.equal(isTextureEdgeSealCell(0.45, 0.1, false, 0.5), false)

  const width = 11, height = 11
  const mask = new Uint8Array(width * height)
  const outside = []
  for (let y = -1; y <= height; y++) for (let x = -1; x <= width; x++) {
    const inOuter = x >= 0 && x < width && y >= 0 && y < height
    const inHole = x >= 4 && x <= 6 && y >= 4 && y <= 6
    if (inOuter && !inHole) mask[y * width + x] = 1
    else outside.push([x, y])
  }
  const distance = new Uint16Array(mask.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x
    if (!mask[index]) continue
    let nearest = Infinity
    for (const [ox, oy] of outside) nearest = Math.min(nearest, Math.hypot(x - ox, y - oy))
    distance[index] = Math.round(nearest * 3)
  }
  const seal = buildTextureEdgeSealMask(mask, distance, 1, true, 0.7)
  assert.equal(seal[0 * width + 5], 1, '外轮廓相邻单元必须使用基材封边')
  assert.equal(seal[5 * width + 3], 1, '孔壁左侧相邻单元必须使用基材封边')
  assert.equal(seal[3 * width + 5], 1, '孔壁上侧相邻单元必须使用基材封边')
  assert.equal(seal[2 * width + 2], 0, '远离外边与孔边的彩色区域不得被封边吞掉')
  assert.ok(seal.reduce((sum, value) => sum + value, 0) > 0)
  assert.equal(buildTextureEdgeSealMask(mask, distance, 1, false, 0.7).some(Boolean), false)

  const exportSource = await readFile(path.join(projectRoot, 'src/utils/export3mf.ts'), 'utf8')
  assert.match(exportSource, /rowEdgeSeal/)
  assert.match(exportSource, /基材单线封边墙/)
  assert.match(exportSource, /extruder:\s*1,[\s\S]*?color:\s*context\.config\.baseColor/)
  assert.match(exportSource, /context\.opticalStart \+ layer \* context\.lut\.layerHeight/)
  console.log('Texture edge-seal regression passed: outer contour, inner hole, disable path, base extruder and optical-layer height OK')
} finally {
  await server.close()
}
