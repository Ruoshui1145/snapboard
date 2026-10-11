import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [types, boardTexture, studio, viewport, projectFile, exporter] = await Promise.all([
  readFile('src/types/geometry.ts', 'utf8'),
  readFile('src/utils/boardTexture.ts', 'utf8'),
  readFile('src/components/texture/TextureStudio.tsx', 'utf8'),
  readFile('src/components/viewport/Viewport3D.tsx', 'utf8'),
  readFile('src/utils/projectFile.ts', 'utf8'),
  readFile('src/utils/export3mf.ts', 'utf8'),
])

assert.match(types, /BoardTextureSource = 'preset' \| 'image' \| 'composition' \| 'pattern'/)
assert.match(types, /composition: TextureComposition/)
assert.match(types, /pattern: TexturePatternConfig/)
assert.match(boardTexture, /renderTextureComposition/)
assert.match(boardTexture, /renderTexturePatternToContext/)
assert.match(boardTexture, /resolveTextureLayerPlacements/)
assert.match(boardTexture, /clipTexturePanel/)
assert.match(boardTexture, /createBoardTextureCanvas\(config: BoardTextureConfig, aspect: number, panels: SplitPanel\[\]/)
assert.match(boardTexture, /const textureImageCache = new Map/)
assert.match(boardTexture, /loadImage\(asset\.dataUrl, asset\.revision\)/)
assert.match(boardTexture, /requiredAssetIds/)
assert.match(boardTexture, /纹理资源解码失败/)
assert.match(studio, /type="file" multiple/)
assert.equal((studio.match(/type="file"/g) ?? []).length, 1, '图片导入只保留一个入口')
assert.doesNotMatch(studio, /singleInputRef/)
assert.match(studio, /texture-import-primary/)
assert.match(studio, /source: 'composition', surfaceMode: 'snapcolor'/)
assert.match(studio, /texture-source-shortcuts/)
assert.doesNotMatch(studio, /texture-import-actions/)
assert.doesNotMatch(studio, /migrateLegacySingleImageTexture/)
assert.match(studio, /const avoidPreviewImage = selectedAsset\?\.dataUrl/)
assert.match(studio, /数学纹样/)
assert.match(studio, /整幅/)
assert.match(studio, /阵列方式/)
assert.match(studio, /distributeImagesToPanels/)
assert.match(studio, /逐板指定图片/)
assert.match(studio, /panelAssetMap/)
assert.match(studio, /restoreAssetsAsFreeLayers/)
assert.match(studio, /setComposition\(\{ \.\.\.composition, layers \}/)
assert.doesNotMatch(studio, /assets:\s*composition\.assets\.filter/)
assert.match(viewport, /selectedEditableTextureLayer/)
assert.match(viewport, /updateCompositionBoundsOverlay/)
assert.match(viewport, /originXmm/)
assert.match(viewport, /rebuildPanels\(\)\.then\([\s\S]*lastPanelInputsRef\.current = inputs/,
  '视图恢复时应直接重建板件并记录输入，不能等旧的延迟定时器')
assert.match(viewport, /if \(prepared && token === texturePreviewTokenRef\.current && sceneRef\.current === scene && root === scene\.getObjectByName\('split-assembly'\)[^\n]*\)\s*applyTexturePreview\(prepared\.canvas, prepared\.config, 'front', root, panels, prepared\.key\)/,
  '只有新纹理画布成功生成时才能替换上一帧')
assert.match(viewport, /\}\)\.catch\(error => console\.warn\('纹理排版预览失败', error\)\)/,
  '纹理失败时只记录错误，不得用空纹理替换上一帧')
assert.match(projectFile, /normalizeTextureComposition/)
assert.match(projectFile, /normalizeTexturePattern/)
assert.match(exporter, /createBoardTextureCanvas\(config, bounds\.width \/ bounds\.height, input\.panels\)/)

console.log('Texture workspace wiring verification passed: pattern, multi-image, per-panel clipping, selected-layer 3D editing and shared 3MF canvas OK')
