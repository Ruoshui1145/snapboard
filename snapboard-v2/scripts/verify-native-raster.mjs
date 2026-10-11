import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// 原生配方网格渲染（buildRecipeRaster）的图层格式门禁：
// SVG 矢量、PNG/JPG/WebP 位图、像素画模式都必须能出网格；不支持的格式要报清楚错误。
// 这里直接喂合成图片，不起 dev server；LUT 读取走 installNativeRuntime 的本地资产 shim。
const require = createRequire(import.meta.url)
const sharp = require('../../desktop/node_modules/sharp')
const { buildRecipeRaster, installNativeRuntime } = await import('./native-recipe-raster.mjs')
const { loadSnapColorLut, matchSnapColor } = await import('../src/utils/snapColorLut.ts')
const restoreFetch = installNativeRuntime(process.cwd())

const dataUrl = async (pipeline, mime = 'image/png') =>
  `data:${mime};base64,${(await pipeline.toBuffer()).toString('base64')}`

// 左右半红半蓝的位图。
const halfHalfPng = await dataUrl(sharp({
  create: {
    width: 64, height: 32, channels: 3, background: '#1c4ed8',
  },
}).composite([{ input: await sharp({ create: { width: 32, height: 32, channels: 3, background: '#d8281c' } }).png().toBuffer(), left: 0, top: 0 }]).png())

// 水平红→蓝渐变位图（像素模式咬合测试用），用 raw 像素直接造。
const gradientPng = await (async () => {
  const pixels = Buffer.alloc(64 * 8 * 3)
  for (let x = 0; x < 64; x++) {
    for (let y = 0; y < 8; y++) {
      const offset = (y * 64 + x) * 3
      pixels[offset] = Math.round(255 * (1 - x / 63))
      pixels[offset + 1] = 32
      pixels[offset + 2] = Math.round(255 * (x / 63))
    }
  }
  return `data:image/png;base64,${(await sharp(pixels, { raw: { width: 64, height: 8, channels: 3 } }).png().toBuffer()).toString('base64')}`
})()

const quadrantPng = await (async () => {
  const colors = [[220, 32, 24], [36, 176, 68], [32, 68, 216], [248, 204, 32]]
  const pixels = Buffer.alloc(64 * 32 * 3)
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const color = colors[(y >= 16 ? 2 : 0) + (x >= 32 ? 1 : 0)]
    pixels.set(color, (y * 64 + x) * 3)
  }
  return `data:image/png;base64,${(await sharp(pixels, { raw: { width: 64, height: 32, channels: 3 } }).png().toBuffer()).toString('base64')}`
})()

const svgDataUrl = (body) => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30" width="60" height="30">${body}</svg>`).toString('base64')}`

const baseTexture = {
  enabled: true, source: 'composition',
  brightness: 1, contrast: 1, saturation: 1, opacity: 1,
  baseColor: '#e7eaed', lutId: 'snapcolor-petg-rybw', hueWeight: 0.35,
  modelingMode: 'vector', quantizeColors: 48, pixelSize: 1.2,
  composition: { layers: [], assets: [] },
}
const freeLayer = (id, assetId, name, wMm = 60, hMm = 30) => ({
  id, kind: 'image', name, visible: true, opacity: 1,
  assetId,
  placement: {
    mode: 'free', crop: { x: 0, y: 0, width: 1, height: 1 },
    transform: { xMm: 30, yMm: 15, widthMm: wMm, heightMm: hMm, rotationDeg: 0, flipX: false, flipY: false },
  },
})
const frame = { x: 0, y: 0, w: 60, h: 30 }
const pitch = 0.5

try {
  // 1. 位图 PNG 图层：曾经直接抛"原生制造目前只支持 SVG 图层"。
  {
    const texture = {
      ...baseTexture,
      composition: {
        layers: [freeLayer('l1', 'a1', '位图')],
        assets: [{ id: 'a1', mime: 'image/png', width: 64, height: 32, dataUrl: halfHalfPng }],
      },
    }
    const raster = await buildRecipeRaster(texture, frame, pitch, 0)
    const midY = Math.floor(raster.height / 2)
    const leftRecipe = raster.recipeIds[midY * raster.width + 5]
    const rightRecipe = raster.recipeIds[midY * raster.width + raster.width - 5]
    assert.notEqual(leftRecipe, rightRecipe, '位图左右两半必须量化成不同配方')
    assert.ok(raster.sourceColors >= 3, `位图聚类色卡必须进入调色板：${raster.sourceColors}`)
  }

  // 2. 混合 SVG + 位图：同一配方网格里两种图层共存。
  {
    const texture = {
      ...baseTexture,
      composition: {
        layers: [
          freeLayer('l1', 'a1', '位图底'),
          freeLayer('l2', 'a2', '矢量块', 20, 20),
        ],
        assets: [
          { id: 'a1', mime: 'image/png', width: 64, height: 32, dataUrl: halfHalfPng },
          { id: 'a2', mime: 'image/svg+xml', width: 60, height: 30, dataUrl: svgDataUrl('<rect x="20" y="5" width="20" height="20" fill="#1a7a3a"/>') },
        ],
      },
    }
    // 矢量块放在右侧中央，会盖住位图的一块。
    texture.composition.layers[1].placement.transform.xMm = 45
    const raster = await buildRecipeRaster(texture, frame, pitch, 0)
    const midY = Math.floor(raster.height / 2)
    const leftRecipe = raster.recipeIds[midY * raster.width + 5]
    const centerRecipe = raster.recipeIds[midY * raster.width + Math.floor(raster.width * 0.75)]
    assert.notEqual(leftRecipe, centerRecipe, 'SVG 叠加块必须盖出第三种配方')
  }

  // 3. 像素画模式：同一像素块内的格点必须是同一个配方，相邻块之间允许变化。
  {
    const texture = {
      ...baseTexture,
      modelingMode: 'pixel', pixelSize: 6, quantizeColors: 12,
      composition: {
        layers: [freeLayer('l1', 'a1', '渐变')],
        assets: [{ id: 'a1', mime: 'image/png', width: 64, height: 8, dataUrl: gradientPng }],
      },
    }
    const raster = await buildRecipeRaster(texture, frame, pitch, 0)
    const blockCells = Math.round(6 / pitch) // 12 格一块
    const midY = Math.floor(raster.height / 2)
    const row = (x) => raster.recipeIds[midY * raster.width + x]
    for (let block = 0; block + blockCells < raster.width; block += blockCells) {
      const recipe = row(block + 1)
      for (let x = block + 2; x < block + blockCells - 1; x++) {
        assert.equal(row(x), recipe, `像素块 ${block / blockCells} 内的配方必须一致（x=${x}）`)
      }
    }
    assert.notEqual(row(2), row(raster.width - 3), '渐变在首尾两块必须量化出不同配方')
  }

  // 4. 不支持的格式：报错必须点名图层与支持的格式，由前端回退浏览器导出。
  {
    const texture = {
      ...baseTexture,
      composition: {
        layers: [freeLayer('l1', 'a1', '动图')],
        assets: [{ id: 'a1', mime: 'image/gif', width: 64, height: 32, dataUrl: halfHalfPng }],
      },
    }
    await assert.rejects(() => buildRecipeRaster(texture, frame, pitch, 0), /动图.*SVG \/ PNG \/ JPG \/ WebP/)
  }

  // 5. SVG 回归：原有路径不受影响。
  {
    const texture = {
      ...baseTexture,
      composition: {
        layers: [freeLayer('l1', 'a1', '矢量')],
        assets: [{ id: 'a1', mime: 'image/svg+xml', width: 60, height: 30, dataUrl: svgDataUrl('<circle cx="30" cy="15" r="10" fill="#ce8350"/>') }],
      },
    }
    const raster = await buildRecipeRaster(texture, frame, pitch, 0)
    assert.ok(raster.recipeIds.length === raster.width * raster.height)
    assert.ok(new Set(raster.recipeIds).size >= 2, 'SVG 圆形必须量化出至少两种配方')
  }

  // 6. 避让区在 SVG、位图和像素网格都覆盖精确基材配方；全局范围偏移和上下翻转一致。
  {
    const shiftedFrame = { x: -20, y: 35, w: 60, h: 30 }
    const zone = { id: 'bottom-cutout', enabled: true, x: .25, y: .1, width: .35, height: .22 }
    const lut = await loadSnapColorLut(baseTexture.lutId)
    const baseRecipe = matchSnapColor([0xe7, 0xea, 0xed], lut, baseTexture.hueWeight)
    const svgLayer = freeLayer('svg', 'svg', '矢量底')
    const pngLayer = freeLayer('png', 'png', '位图叠加', 30, 30)
    svgLayer.placement.transform.xMm = 10; svgLayer.placement.transform.yMm = 50
    pngLayer.placement.transform.xMm = 10; pngLayer.placement.transform.yMm = 50
    const cases = [
      { name: 'SVG', mode: 'vector', layers: [svgLayer], assets: [
        { id: 'svg', mime: 'image/svg+xml', width: 60, height: 30, dataUrl: svgDataUrl('<rect width="60" height="30" fill="#d8281c"/>') },
      ] },
      { name: 'SVG+位图', mode: 'vector', layers: [svgLayer, pngLayer], assets: [
        { id: 'svg', mime: 'image/svg+xml', width: 60, height: 30, dataUrl: svgDataUrl('<rect width="60" height="30" fill="#d8281c"/>') },
        { id: 'png', mime: 'image/png', width: 64, height: 32, dataUrl: halfHalfPng },
      ] },
      { name: '位图像素模式', mode: 'pixel', layers: [pngLayer], assets: [
        { id: 'png', mime: 'image/png', width: 64, height: 32, dataUrl: halfHalfPng },
      ] },
    ]
    for (const item of cases) {
      const common = { ...baseTexture, modelingMode: item.mode, pixelSize: 6,
        composition: { layers: item.layers, assets: item.assets } }
      const plain = await buildRecipeRaster({ ...common, avoidZones: [] }, shiftedFrame, pitch, 1)
      const masked = await buildRecipeRaster({ ...common, avoidZones: [zone] }, shiftedFrame, pitch, 1)
      const { width, height } = masked
      const x0 = Math.floor(zone.x * width), x1 = Math.ceil((zone.x + zone.width) * width)
      const y0 = Math.floor((1 - zone.y - zone.height) * height), y1 = Math.ceil((1 - zone.y) * height)
      assert.notEqual(plain.recipeIds[Math.floor((y0 + y1) / 2) * width + Math.floor((x0 + x1) / 2)], baseRecipe,
        `${item.name} 测试图在避让区原本必须不是基材配方`)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = y * width + x
        if (x >= x0 && x < x1 && y >= y0 && y < y1) {
          assert.equal(masked.recipeIds[index], baseRecipe, `${item.name} 避让区边界和内部应为基材配方 (${x},${y})`)
        } else {
          assert.equal(masked.recipeIds[index], plain.recipeIds[index], `${item.name} 避让区外不得改配方 (${x},${y})`)
        }
      }
      assert.ok(y0 > height / 2, `${item.name} 原点应在左下，避让区应落在网格下半部`)
    }
  }

  // 7. 图片在浏览器 Canvas 中是先裁切/翻转，再以中心旋转；原生制造必须遵守同一方向。
  {
    const squareFrame = { x: 0, y: 0, w: 60, h: 60 }
    const layer = freeLayer('quadrants', 'quadrants', '四象限', 40, 20)
    layer.placement.transform.yMm = 30
    const asset = { id: 'quadrants', mime: 'image/png', width: 64, height: 32, dataUrl: quadrantPng }
    const render = async patch => buildRecipeRaster({ ...baseTexture,
      composition: { layers: [{ ...layer, ...patch,
        placement: { ...layer.placement, ...patch?.placement,
          transform: { ...layer.placement.transform, ...patch?.placement?.transform },
          crop: { ...layer.placement.crop, ...patch?.placement?.crop } } }], assets: [asset] },
    }, squareFrame, pitch, 0)
    const cell = (raster, x, y) => raster.recipeIds[y * raster.width + x]
    const original = await render({})
    const colors = [cell(original, 45, 45), cell(original, 75, 45),
      cell(original, 45, 75), cell(original, 75, 75)]
    assert.ok(new Set(colors).size >= 3, '四象限夹具必须能区分颜色')

    const turned = await render({ placement: { transform: { rotationDeg: 90 } } })
    assert.equal(cell(turned, 50, 40), colors[1], '90° 后左上应取原右上')
    assert.equal(cell(turned, 70, 40), colors[3], '90° 后右上应取原右下')
    assert.equal(cell(turned, 50, 80), colors[0], '90° 后左下应取原左上')
    assert.equal(cell(turned, 70, 80), colors[2], '90° 后右下应取原左下')

    const diagonal = await render({ placement: { transform: { rotationDeg: 45 } } })
    const baseRecipe = matchSnapColor([0xe7, 0xea, 0xed], await loadSnapColorLut(baseTexture.lutId), baseTexture.hueWeight)
    assert.equal(cell(original, 84, 36), baseRecipe, '未旋转的窄矩形在对角外应露出底色')
    assert.notEqual(cell(diagonal, 84, 36), baseRecipe, '45° 旋转应覆盖原矩形外的对角区域')

    const cropped = await render({ placement: { crop: { x: 0, y: 0, width: .5, height: 1 } } })
    assert.equal(cell(cropped, 75, 45), colors[0], '左半裁切放大后右上仍是原左上')
    assert.equal(cell(cropped, 75, 75), colors[2], '左半裁切放大后右下仍是原左下')

    const flipped = await render({ placement: { transform: { flipX: true } } })
    assert.equal(cell(flipped, 45, 45), colors[1], '水平翻转应交换左右颜色')
    const flippedY = await render({ placement: { transform: { flipY: true } } })
    assert.equal(cell(flippedY, 45, 45), colors[2], '垂直翻转应交换上下颜色')

    const contain = await render({ placement: { fit: 'contain', transform: { widthMm: 20, heightMm: 20 } } })
    const cover = await render({ placement: { fit: 'cover', transform: { widthMm: 20, heightMm: 20 } } })
    assert.equal(cell(contain, 60, 43), baseRecipe, 'contain 应保留透明留白')
    assert.notEqual(cell(cover, 60, 43), baseRecipe, 'cover 应裁掉溢出并铺满目标框')

    const translucent = await render({ opacity: .1 })
    assert.equal(cell(translucent, 45, 45), baseRecipe, '低透明度图层须与基材混合后再匹配配方')

    const nearEdge = await render({ placement: { transform: { xMm: 5, yMm: 5, rotationDeg: 33 } } })
    assert.equal(nearEdge.recipeIds.length, nearEdge.width * nearEdge.height, '旋转图层越过板界时仍须安全裁剪')
  }

  console.log('verify:native-raster OK')
} finally {
  restoreFetch()
}
