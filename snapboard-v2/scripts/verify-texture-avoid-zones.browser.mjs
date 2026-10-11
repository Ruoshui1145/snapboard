// Run in a real browser/Electron renderer served by Vite; Canvas pixel coverage cannot be checked in Node SSR.
import {
  createBoardTextureCanvas, createBoardTextureManufacturingData,
  createDefaultBoardTexture, createLayoutTextureCanvas,
} from '/src/utils/boardTexture.ts'
import { buildTextureVectorRegions } from '/src/utils/textureVectorRegions.ts'

export async function run() {
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#d8281c"/></svg>'
  const zone = { id: 'lower-cutout', enabled: true, x: .25, y: .1, width: .35, height: .22 }
  const base = {
    ...createDefaultBoardTexture(), enabled: true, source: 'image',
    imageDataUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`, imageAspect: 1,
    fit: 'stretch', baseColor: '#112233', modelingMode: 'vector',
    manufacturingContours: true, avoidZones: [],
  }
  const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data]
  const expected = [17, 34, 51, 255]
  const check = async (name, draw) => {
    const plain = await draw(base)
    const masked = await draw({ ...base, avoidZones: [zone] })
    assert(plain && masked && plain.width === masked.width && plain.height === masked.height,
      `${name}: Canvas resolution changed`)
    const { width, height } = masked
    const x0 = Math.floor(zone.x * width), x1 = Math.ceil((zone.x + zone.width) * width)
    const y0 = Math.floor((1 - zone.y - zone.height) * height), y1 = Math.ceil((1 - zone.y) * height)
    const points = [
      [x0, y0], [x1 - 1, y0], [x0, y1 - 1], [x1 - 1, y1 - 1],
      [Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2)],
    ]
    for (const [x, y] of points) {
      assert(JSON.stringify(pixel(masked, x, y)) === JSON.stringify(expected),
        `${name}: zone boundary/interior ${x},${y}: ${pixel(masked, x, y)}`)
      assert(JSON.stringify(pixel(plain, x, y)) !== JSON.stringify(expected),
        `${name}: source at ${x},${y} did not differ from base color`)
    }
    for (const [x, y] of [[x0 - 3, y0 + 5], [x1 + 3, y1 - 5], [x0 + 5, y0 - 3], [x1 - 5, y1 + 3], [10, 10]]) {
      assert(JSON.stringify(pixel(masked, x, y)) === JSON.stringify(pixel(plain, x, y)),
        `${name}: outside zone changed at ${x},${y}`)
    }
    assert(y0 > height / 2, `${name}: normalized Y must map from world bottom to Canvas lower rows`)
    return { name, width, height }
  }

  const bounds = { minX: 0, minY: 0, width: 100, height: 100 }
  const panels = [{ id: 'p', x: 0, y: 0, w: 100, h: 100,
    contour: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    slots: [], edge_holes: [] }]
  const vector = await buildTextureVectorRegions({ ...base, avoidZones: [zone] }, bounds, panels)
  assert(vector.eligible, `SVG must use direct vector route: ${vector.reason}`)
  const inRing = (ring, x, y) => { let yes = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes
  } return yes }
  const vectorColorAt = (x, y) => vector.regions.find(region => region.polygons.some(poly =>
    inRing(poly[0], x, y) && !poly.slice(1).some(hole => inRing(hole, x, y))))?.color
  assert(vectorColorAt(40, 20) === '#112233' && vectorColorAt(40, 70) === '#d8281c',
    'manufacturing vector partition must cover lower avoid zone without changing the image above it')
  const passed = []
  passed.push(await check('direct SVG vector preview', config => createBoardTextureCanvas(config, 1, panels)))
  passed.push(await check('SVG manufacturing canvas', async config =>
    (await createBoardTextureManufacturingData(config, panels, 1))?.canvas))
  passed.push(await check('veneer surface', config => createBoardTextureCanvas({
    ...config, surfaceMode: 'veneer', surfaceColor: '#c85944',
  }, 1, panels)))
  passed.push(await check('layout-only preview', config => createLayoutTextureCanvas(config, 1, panels)))
  return { passed }
}
