import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile('src/components/viewport/Viewport3D.tsx', 'utf8')

// 相机会话必须覆盖方向、投影缩放、控制器目标和输入映射，不能只保存 position。
assert.match(source, /interface TextureViewSessionSnapshot[\s\S]*preset: ViewPreset/)
for (const field of ['scene', 'position', 'quaternion', 'up', 'zoom', 'target', 'controlsEnabled', 'enableRotate', 'enablePan', 'enableZoom', 'mouseButtons', 'touches']) {
  assert.match(source, new RegExp(`\\b${field}:`), `纹理视角快照缺少 ${field}`)
}

// 只在 textureStudioOpen 的上升/下降沿进入和恢复，连续纹理参数更新不得覆盖快照。
assert.match(source, /const wasOpen = textureStudioWasOpenRef\.current/)
assert.match(source, /if \(textureStudioOpen && \(!wasOpen \|\| textureViewSessionRef\.current\?\.scene !== scene\)\)[\s\S]*selectViewPreset\(editSide\)/)
assert.match(source, /textureViewSessionRef\.current\.scene !== scene/)
assert.match(source, /if \(!textureStudioOpen && wasOpen\)[\s\S]*camera\.position\.copy\(snapshot\.position\)/)
assert.match(source, /camera\.quaternion\.copy\(snapshot\.quaternion\)/)
assert.match(source, /controls\.target\.copy\(snapshot\.target\)/)
assert.match(source, /viewPresetRef\.current = snapshot\.preset[\s\S]*setViewPreset\(snapshot\.preset\)/)
assert.match(source, /\}, \[textureStudioOpen\]\)/)

// 图片定位只能在当前面的严格正视中工作；背面的 X 使用从背面观察的方向。
assert.match(source, /if \(!textureMappingMode \|\| viewPresetRef\.current !== editSide\) return null/)

// 指针取消和捕获丢失都必须恢复拖动前 controls.enabled，而不是无条件打开控制器。
assert.match(source, /controlsWasEnabled: controls\?\.enabled \?\? true/)
assert.match(source, /controls\.enabled = moving\.controlsWasEnabled/)
assert.match(source, /onPointerCancelCapture=\{cancelTextureMove\}/)
assert.match(source, /onLostPointerCapture=\{cancelTextureMove\}/)

console.log('Texture view-assist regression passed: edge snapshot, front/back mapping, exact restore and pointer-cancel recovery OK')
