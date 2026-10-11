import assert from 'node:assert/strict'
import {
  captureRedrawSnapshot,
  createClearedRedrawPatch,
  createRestoredRedrawPatch,
} from '../src/utils/redrawTransaction.ts'

const defaultTexture = {
  enabled: false,
  source: 'preset',
  presetId: 'mono-checker',
  avoidZones: [],
}

const before = {
  project: { metadata: { name: '重画回归' }, config: { pixelToMM: 0.5, material: 'PETG' } },
  splitConfig: { printerPreset: 'x2d', maxW: 240, maxH: 220 },
  resourceLibraryRevision: 88,
  occlusionMode: 'display',
  boards: [{ id: 'legacy-board' }],
  placedParts: [{ id: 'placed-hook', boardId: 'P1' }],
  boardTexture: {
    enabled: true,
    source: 'image',
    imageDataUrl: 'data:image/png;base64,TEST',
    avoidZones: [{ id: 'avoid-1' }],
  },
  assemblyScene: {
    schemaVersion: 1,
    hostPresetId: 'snapboard-pegboard-v1',
    hostDefinitions: [{ id: 'custom-host' }],
    connectorDefinitions: [{ id: 'custom-connector' }],
    hostInstances: [{ id: 'old-board-instance' }],
    placements: [{ id: 'old-placement' }],
  },
  splitResult: { panels: [{ id: 'P1' }], sources: [{ contourId: 'outer-1' }] },
  splitJob: { jobId: 7 },
  occlusionOverlayEnabled: true,
  ui: {
    activeTool: 'arc',
    newContourType: 'outer',
    selectedFeatureId: 'sketch-1',
    selectedContourId: 'outer-1',
    selectedConstraintId: 'radius-1',
    selectedPartId: 'placed-hook',
    textureStudioOpen: true,
    occlusionAnalysisOpen: true,
  },
}
const contours = [{ id: 'outer-1', points: [{ x: 0, y: 0 }] }]

const snapshot = captureRedrawSnapshot(before, contours)
const cleared = { ...before, ...createClearedRedrawPatch(before, defaultTexture) }

assert.deepEqual(cleared.boards, [])
assert.deepEqual(cleared.placedParts, [])
assert.equal(cleared.splitResult, null)
assert.equal(cleared.splitJob, null)
assert.equal(cleared.boardTexture, defaultTexture)
assert.equal(cleared.occlusionOverlayEnabled, false)
assert.deepEqual(cleared.assemblyScene.hostInstances, [])
assert.deepEqual(cleared.assemblyScene.placements, [])
assert.deepEqual(cleared.assemblyScene.hostDefinitions, before.assemblyScene.hostDefinitions)
assert.deepEqual(cleared.assemblyScene.connectorDefinitions, before.assemblyScene.connectorDefinitions)
assert.equal(cleared.assemblyScene.hostPresetId, before.assemblyScene.hostPresetId)
assert.equal(cleared.ui.selectedFeatureId, null)
assert.equal(cleared.ui.selectedContourId, null)
assert.equal(cleared.ui.selectedConstraintId, null)
assert.equal(cleared.ui.selectedPartId, null)
assert.equal(cleared.ui.textureStudioOpen, false)
assert.equal(cleared.ui.occlusionAnalysisOpen, false)

// 全局/资源配置没有进入清理补丁，展开补丁后必须保持原值。
assert.equal(cleared.project, before.project)
assert.equal(cleared.splitConfig, before.splitConfig)
assert.equal(cleared.resourceLibraryRevision, 88)
assert.equal(cleared.occlusionMode, 'display')
assert.equal(cleared.ui.activeTool, 'arc')
assert.equal(cleared.ui.newContourType, 'outer')

const restored = { ...cleared, ...createRestoredRedrawPatch(cleared, snapshot) }
assert.deepEqual(snapshot.contours, contours)
assert.equal(restored.boards, before.boards)
assert.equal(restored.placedParts, before.placedParts)
assert.equal(restored.boardTexture, before.boardTexture)
assert.equal(restored.assemblyScene, before.assemblyScene)
assert.equal(restored.splitResult, before.splitResult)
assert.equal(restored.splitJob, null, '旧的后台 Worker 不应随撤销复活')
assert.equal(restored.occlusionOverlayEnabled, true)
assert.equal(restored.ui.selectedContourId, 'outer-1')
assert.equal(restored.ui.selectedPartId, 'placed-hook')
assert.equal(restored.ui.textureStudioOpen, true)
assert.equal(restored.ui.occlusionAnalysisOpen, true)
assert.equal(restored.ui.activeTool, 'arc')

console.log('redraw transaction regression: dependent state cleared atomically; global configuration preserved; one-step restore complete')
