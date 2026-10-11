import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const outDir = path.join(root, '.tmp-3d-test', 'compiled-multi-scene-assembly')
const tscPath = createRequire(import.meta.url).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [
  tscPath,
  '--ignoreConfig',
  'src/utils/multiSceneAssembly.ts',
  '--outDir', outDir,
  '--module', 'esnext',
  '--moduleResolution', 'bundler',
  '--target', 'es2023',
  '--skipLibCheck', 'true',
], { cwd: root, stdio: 'inherit' })

const geometry = await import(`${pathToFileURL(path.join(outDir, 'multiSceneAssembly.js')).href}?t=${Date.now()}`)

const rail = {
  id: 'rail-1',
  axis: { start: [0, 0, 0], end: [100, 0, 0] },
  profile: 'EN60715:TH35-7.5',
}

const projection = geometry.projectPointToFiniteAxis([120, 10, 0], rail.axis)
assert.ok(projection)
assert.deepEqual(projection.point, [100, 0, 0])
assert.equal(projection.clamped, true)
assert.equal(projection.lineT, 1.2)

const railPlacement = geometry.fitRailClipPlacement({
  host: rail,
  desiredPoint: [40, 3, 0],
  axialSpan: 20,
  maxSnapDistance: 5,
  compatibleProfiles: ['EN60715:TH35-7.5'],
})
assert.equal(railPlacement.ok, true)
assert.equal(railPlacement.value.axialPosition, 40)
assert.deepEqual(railPlacement.value.occupancy, {
  kind: 'axial-interval', hostId: 'rail-1', channelId: undefined, start: 30, end: 50,
})

assert.deepEqual(geometry.fitRailClipPlacement({
  host: rail, desiredPoint: [4, 0, 0], axialSpan: 20,
}), { ok: false, reason: 'out-of-bounds' })

assert.deepEqual(geometry.fitRailClipPlacement({
  host: rail,
  desiredPoint: [45, 0, 0],
  axialSpan: 20,
  existingOccupancies: [{ kind: 'axial-interval', hostId: 'rail-1', start: 40, end: 60 }],
}), { ok: false, reason: 'occupied' })

const slot = {
  ...rail,
  id: 'slot-1',
  profile: 'item-line8',
  openingWidth: 8,
  cavityWidth: 18,
  openEnds: 'start',
  allowsSwivelIn: true,
}
const connector = {
  compatibleProfiles: ['item-line8'],
  neckWidth: 7,
  headWidth: 16,
  swivelInsertionWidth: 7.5,
  supportedModes: ['end-feed', 'swivel-in'],
  axialSpan: 12,
}

const endFeed = geometry.fitTSlotPlacement({
  host: slot, connector, mode: 'end-feed', desiredPoint: [70, 2, 0], maxSnapDistance: 3,
})
assert.equal(endFeed.ok, true)
assert.equal(endFeed.value.entry, 'start')

const swivel = geometry.fitTSlotPlacement({
  host: slot, connector, mode: 'swivel-in', desiredPoint: [50, 0, 0],
})
assert.equal(swivel.ok, true)
assert.equal(swivel.value.entry, undefined)

assert.deepEqual(geometry.fitTSlotPlacement({
  host: { ...slot, allowsSwivelIn: false },
  connector,
  mode: 'swivel-in',
  desiredPoint: [50, 0, 0],
}), { ok: false, reason: 'unsupported-insertion-mode' })

assert.deepEqual(geometry.fitTSlotPlacement({
  host: slot,
  connector: { ...connector, headWidth: 22 },
  mode: 'end-feed',
  desiredPoint: [50, 0, 0],
}), { ok: false, reason: 'incompatible-profile' })

const surface = {
  id: 'wall-1',
  frame: { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
  boundary: [[0, 0], [100, 0], [100, 80], [0, 80]],
}
const pad = [[-10, -5], [10, -5], [10, 5], [-10, 5]]
const padPlacement = geometry.fitSurfacePadPlacement({
  host: surface,
  desiredPoint: [40, 30, 2],
  footprint: pad,
  maxPlaneDistance: 3,
})
assert.equal(padPlacement.ok, true)
assert.deepEqual(padPlacement.value.point, [40, 30, 0])
assert.deepEqual(padPlacement.value.localPosition, [40, 30])

assert.deepEqual(geometry.fitSurfacePadPlacement({
  host: surface, desiredPoint: [4, 30, 0], footprint: pad,
}), { ok: false, reason: 'out-of-bounds' })

assert.deepEqual(geometry.fitSurfacePadPlacement({
  host: surface,
  desiredPoint: [48, 30, 0],
  footprint: pad,
  existingOccupancies: [padPlacement.value.occupancy],
}), { ok: false, reason: 'occupied' })

assert.equal(geometry.occupanciesConflict(
  { kind: 'discrete-hole', hostId: 'board', holeIds: ['P1', 'P2'] },
  { kind: 'discrete-hole', hostId: 'board', holeIds: ['P2'] },
), true)
assert.equal(geometry.occupanciesConflict(
  { kind: 'discrete-hole', hostId: 'board', holeIds: ['P1'] },
  { kind: 'discrete-hole', hostId: 'other-board', holeIds: ['P1'] },
), false)
assert.equal(geometry.occupanciesConflict(
  { kind: 'axial-interval', hostId: 'rail-1', start: 0, end: 10 },
  { kind: 'axial-interval', hostId: 'rail-1', start: 10, end: 20 },
), false, 'touching axial intervals must remain placeable')
assert.equal(geometry.occupanciesConflict(
  { kind: 'surface-footprint', hostId: 'wall-1', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  { kind: 'surface-footprint', hostId: 'wall-1', polygon: [[5, 5], [15, 5], [15, 15], [5, 15]] },
), true)

console.log('multi-scene assembly regression: rail, T-slot, surface pad, bounds and occupancy OK')
