// Run in a Vite browser: import('/scripts/verify-streamed-3mf.browser.mjs').then(m => m.runStreamed3MFRegression())
import { unzipSync, strFromU8 } from 'fflate'
import { createManufacturing3MF, createManufacturing3MFStreamed } from '/src/utils/export3mf.ts'
import { createDefaultBoardTexture } from '/src/utils/boardTexture.ts'
import { PEGBOARD_DEFAULT_CONFIG } from '/src/utils/pegboardSplit.ts'

export async function runStreamed3MFRegression() {
  const assert = (okay, message) => { if (!okay) throw new Error(message) }
  const panel = (id, x) => ({ id, x, y: 0, w: 40, h: 30,
    slots: [], round_holes: [], edge_holes: [], outerCorners: [true, true, true, true] })
  const input = { panels: [panel('A', 0), panel('B', 40)], cfg: PEGBOARD_DEFAULT_CONFIG,
    placedParts: [], boardTexture: { ...createDefaultBoardTexture(), enabled: true } }
  const old = await createManufacturing3MF(input)
  const current = await createManufacturing3MFStreamed(input, true)
  try {
    assert(current.data.length === 0 && current.streamedFile?.size, 'large export must spill to disk')
    const standard = unzipSync(old.data)
    const archive = unzipSync(new Uint8Array(await current.streamedFile.arrayBuffer()))
    const models = Object.keys(archive).filter(name => name.startsWith('3D/Objects/'))
    assert(models.length === 2, 'each panel must have its own model ZIP entry')
    const triangleCount = data => (strFromU8(data).match(/<triangle /g) ?? []).length
    assert(models.reduce((sum, name) => sum + triangleCount(archive[name]), 0)
      === triangleCount(standard['3D/Objects/object_1.model']), 'streaming changed manufacturing triangles')
    const root = strFromU8(archive['3D/3dmodel.model'])
    const relations = strFromU8(archive['3D/_rels/3dmodel.model.rels'])
    for (const name of models) {
      assert(strFromU8(archive[name]).trimEnd().endsWith('</model>'), `${name} is incomplete`)
      assert(root.includes(`/${name}`) && relations.includes(`/${name}`), `${name} is not referenced`)
    }
    return { status: 'pass', modelFiles: models.length, triangles: models.reduce((sum, name) => sum + triangleCount(archive[name]), 0) }
  } finally { await current.cleanup?.() }
}
