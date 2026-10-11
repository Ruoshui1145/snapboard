import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { createSnapColorPackage, readSnapColorPackage, readSnapColorNpz } = await server.ssrLoadModule('/src/utils/snapColorPackage.ts')
  const { normalizeSnapColorLutId } = await server.ssrLoadModule('/src/utils/snapColorLut.ts')
  const rgbNpy = new Uint8Array(await readFile('public/snapcolor/luts/snapcolor-petg-rybw.npy'))
  const materials = ['白色', '红色', '黄色', '蓝色'].map((name, index) => ({ name, color: ['#FFFFFF', '#DC143C', '#FFE600', '#0064F0'][index] }))
  const manifest = { id: 'farm-a', revision: 'r003', name: 'Farm A PETG', mode: 'rybw', layerHeight: 0.08,
    layerCount: 5, stackOrder: 'top-to-bottom', materials, status: 'extracted' }
  const zipped = await createSnapColorPackage({ manifest, rgbNpy })
  assert.deepEqual(await createSnapColorPackage({ manifest, rgbNpy }), zipped)
  const parsed = await readSnapColorPackage(zipped)
  assert.deepEqual(readSnapColorNpz(zipped).rgbNpy, rgbNpy)
  assert.equal(parsed.measured.length, 1024 * 3)
  assert.deepEqual([...parsed.stacks.slice(5, 10)], [0, 0, 0, 0, 1])
  assert.match(parsed.profile.id, /^snapcolor-farm:farm-a@r003:[a-f0-9]{64}$/)
  assert.equal(normalizeSnapColorLutId(parsed.profile.id), parsed.profile.id)
  assert.equal(normalizeSnapColorLutId('aliz-petg-rybw'), 'snapcolor-petg-rybw')

  const files = unzipSync(zipped)
  files['rgb.npy'][files['rgb.npy'].length - 1] ^= 1
  await assert.rejects(readSnapColorPackage(zipSync(files)), /哈希不匹配/)

  const npy = (values, shape) => {
    const prefix = `{'descr': '<i4', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`
    const header = strToU8(prefix + ' '.repeat((16 - (10 + prefix.length + 1) % 16) % 16) + '\n')
    const bytes = new Uint8Array(10 + header.length + values.length * 4)
    bytes.set([0x93, 78, 85, 77, 80, 89, 1, 0, header.length & 255, header.length >> 8])
    bytes.set(header, 10)
    const view = new DataView(bytes.buffer)
    values.forEach((value, index) => view.setInt32(10 + header.length + index * 4, value, true))
    return bytes
  }
  const bwHeaderText = "{'descr': '|u1', 'fortran_order': False, 'shape': (32, 3), }"
  const bwHeader = strToU8(bwHeaderText + ' '.repeat((16 - (10 + bwHeaderText.length + 1) % 16) % 16) + '\n')
  const twoRgb = new Uint8Array(10 + bwHeader.length + 32 * 3)
  twoRgb.set([0x93, 78, 85, 77, 80, 89, 1, 0, bwHeader.length & 255, bwHeader.length >> 8])
  twoRgb.set(bwHeader, 10)
  twoRgb.set(parsed.measured.slice(0, 32 * 3), 10 + bwHeader.length)
  const twoManifest = { ...manifest, mode: 'bw', materials: materials.slice(0, 2), layerCount: 5, stackOrder: 'bottom-to-top' }
  const rawBw = new Uint8Array(await readFile('public/snapcolor/luts/snapcolor-petg-bw.npy'))
  const trimmedBw = await readSnapColorPackage(await createSnapColorPackage({
    manifest: { ...twoManifest, stackOrder: 'top-to-bottom' }, rgbNpy: rawBw,
  }))
  assert.equal(trimmedBw.measured.length, 32 * 3)
  assert.match(trimmedBw.profile.source.originalRgbSha256, /^[a-f0-9]{64}$/)
  const validInt32 = npy(Array(31 * 5).fill(0), [31, 5])
  await assert.rejects(createSnapColorPackage({ manifest: twoManifest, rgbNpy: twoRgb, stacksNpy: validInt32 }), /数量或层数不匹配/)
  const allRows = Array(32 * 5).fill(0)
  allRows.splice(0, 5, -1, 1, 0, 1, 0)
  const int32Zip = await createSnapColorPackage({ manifest: twoManifest, rgbNpy: twoRgb, stacksNpy: npy(allRows, [32, 5]) })
  const int32Parsed = await readSnapColorPackage(int32Zip)
  assert.deepEqual([...int32Parsed.stacks.slice(0, 5)], [0, 1, 0, 1, 255])
  allRows[0] = 2
  await assert.rejects(createSnapColorPackage({ manifest: twoManifest, rgbNpy: twoRgb, stacksNpy: npy(allRows, [32, 5]) }), /材料索引越界/)
  const manifestFile = JSON.parse(strFromU8(unzipSync(zipped)['manifest.json']))
  assert.equal(manifestFile.hashes.rgb.length, 64)
  console.log('SnapColor package roundtrip, hash, int32 bounds, layer order and legacy IDs passed')
} finally { await server.close() }
