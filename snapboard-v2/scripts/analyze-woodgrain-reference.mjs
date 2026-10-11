// Reference analysis only. No meshes or printer G-code are bundled into SnapBoard.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', server: { middlewareMode: true } })
try {
  const { importWoodModifier, woodModifierGeometry } = await server.ssrLoadModule('/src/utils/woodGrainReference.ts')
  const filename = process.env.SNAPBOARD_WOOD_MODIFIER ?? 'D:/desktop/3Dprint/图纸/木纹修改器.3mf'
  const source = await importWoodModifier(await readFile(filename), '木纹修改器.3mf')
  const { vertices, triangles } = woodModifierGeometry(source)
  const parent = Uint32Array.from({ length: source.vertexCount }, (_, i) => i)
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a, b) => { a = root(a); b = root(b); if (a !== b) parent[b] = a }
  for (let i = 0; i < triangles.length; i += 3) { union(triangles[i], triangles[i + 1]); union(triangles[i], triangles[i + 2]) }
  const shells = new Map()
  for (let i = 0; i < source.vertexCount; i++) {
    const id = root(i)
    let shell = shells.get(id)
    if (!shell) { shell = { vertices: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], lines: [] }; shells.set(id, shell) }
    shell.vertices++
    for (let axis = 0; axis < 3; axis++) { const n = vertices[i * 3 + axis]; shell.min[axis] = Math.min(shell.min[axis], n); shell.max[axis] = Math.max(shell.max[axis], n) }
  }
  // Intersect triangles with original local Z=0; measure annular band thickness.
  for (let i = 0; i < triangles.length; i += 3) {
    const hits = []
    for (let edge = 0; edge < 3; edge++) {
      const a = triangles[i + edge] * 3, b = triangles[i + (edge + 1) % 3] * 3
      const za = vertices[a + 2], zb = vertices[b + 2]
      if ((za < 0) === (zb < 0)) continue
      const t = za / (za - zb)
      hits.push([vertices[a] + t * (vertices[b] - vertices[a]), vertices[a + 1] + t * (vertices[b + 1] - vertices[a + 1])])
    }
    if (hits.length === 2) shells.get(root(triangles[i])).lines.push(hits)
  }
  const section = [...shells.values()].sort((a, b) => a.max[0] - a.min[0] - (b.max[0] - b.min[0])).map(shell => {
    const min = [Infinity, Infinity], max = [-Infinity, -Infinity]
    for (const line of shell.lines) for (const p of line) for (let axis = 0; axis < 2; axis++) { min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]) }
    const center = min.map((n, axis) => (n + max[axis]) / 2), boundaries = []
    for (const [a, b] of shell.lines) {
      if ((a[1] < center[1]) === (b[1] < center[1])) continue
      const x = a[0] + (center[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
      if (x >= center[0]) boundaries.push(x)
    }
    assert.equal(boundaries.length, 2, '中间截面的每个连通体应具有内、外两条环边界')
    boundaries.sort((a, b) => a - b)
    return { center, bandWidthMm: boundaries[1] - boundaries[0], positiveXMidpoint: (boundaries[0] + boundaries[1]) / 2 }
  })
  const range = values => { values.sort((a, b) => a - b); return { min: values[0], median: (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2, max: values.at(-1) } }
  const report = {
    reference: { author: source.author, sha256: source.sha256, vertices: source.vertexCount, triangles: source.triangleCount },
    connectedAnnularShells: shells.size,
    originalLocalZ0: { bandWidthMm: range(section.map(s => s.bandWidthMm)), spacingMm: range(section.slice(1).map((s, i) => s.positiveXMidpoint - section[i].positiveXMidpoint)) },
    globalSettings: source.globalSettings, modifierSettings: source.modifierSettings,
    toolpathCases: [],
  }
  assert.equal(shells.size, 51)
  assert.equal(source.globalSettings.infill_direction, '45')
  assert.equal(source.modifierSettings.infill_direction, '135')
  for (const filename of process.argv.slice(2).filter(arg => arg !== '--mesh-cache')) {
    const lines = (await readFile(filename, 'utf8')).split('\n')
    const topZ = Math.max(...lines.flatMap(line => line.startsWith('; Z_HEIGHT:') ? [Number(line.split(':')[1])] : []))
    let feature = '', height = 0, x = 0, y = 0, e = 0, relativeE = true, relativeXY = false
    const lengthMm = { angle45: 0, angle135: 0, connectionOrOther: 0 }
    for (const line of lines) {
      if (line.startsWith('; FEATURE:')) feature = line.split(':')[1].trim()
      if (line.startsWith('; Z_HEIGHT:')) height = Number(line.split(':')[1])
      if (/^M83\b/.test(line)) relativeE = true
      if (/^M82\b/.test(line)) relativeE = false
      if (/^G90\b/.test(line)) relativeXY = false
      if (/^G91\b/.test(line)) relativeXY = true
      const fields = Object.fromEntries([...line.matchAll(/([XYE])(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g)].map(m => [m[1], Number(m[2])]))
      if (/^G92\b/.test(line)) { if (fields.E !== undefined) e = fields.E; continue }
      if (!/^G[01]\s/.test(line)) continue
      const nx = fields.X === undefined ? x : fields.X + (relativeXY ? x : 0), ny = fields.Y === undefined ? y : fields.Y + (relativeXY ? y : 0)
      const extrusion = fields.E === undefined ? 0 : relativeE ? fields.E : fields.E - e
      if (feature === 'Top surface' && height === topZ && extrusion > 0) {
        const dx = nx - x, dy = ny - y, length = Math.hypot(dx, dy), angle = (Math.atan2(dy, dx) * 180 / Math.PI + 180) % 180
        if (length > .05) lengthMm[Math.abs(angle - 45) < 1 ? 'angle45' : Math.abs(angle - 135) < 1 ? 'angle135' : 'connectionOrOther'] += length
      }
      if (fields.E !== undefined) e = relativeE ? e + fields.E : fields.E
      x = nx; y = ny
    }
    assert.ok(lengthMm.angle45 + lengthMm.angle135 > 0, '应从真正的顶面挤出中测量方向')
    report.toolpathCases.push({ file: filename.replace(/^.*[\\/]/, ''), topZmm: topZ, lengthMm })
  }
  await mkdir('output/woodgrain-analysis', { recursive: true })
  await writeFile('output/woodgrain-analysis/measurements.json', JSON.stringify(report, null, 2))
  if (process.argv.includes('--mesh-cache')) {
    const ordered=[...shells.entries()].sort(([,a],[,b])=>a.max[0]-a.min[0]-(b.max[0]-b.min[0]))
    const ids=new Map(ordered.map(([id],index)=>[id,index]))
    const labels=Uint16Array.from({length:source.vertexCount},(_,i)=>ids.get(root(i)))
    await writeFile('output/woodgrain-analysis/geometry.bin',new Uint8Array(vertices.buffer,vertices.byteOffset-8,8+vertices.byteLength+triangles.byteLength))
    await writeFile('output/woodgrain-analysis/labels.bin',new Uint8Array(labels.buffer))
  }
  console.log(JSON.stringify(report, null, 2))
} finally { await server.close() }
