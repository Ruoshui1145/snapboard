import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } })
try {
  const { translateUiText } = await server.ssrLoadModule('/src/i18n/catalog.ts')
  const missing = new Set()
  for (const file of [
    'src/components/toolbar/Toolbar.tsx',
    'src/components/licensing/DiyExportQuota.tsx',
    'src/components/manufacturing/OrderEngravingShortcut.tsx',
    'src/components/texture/TextureSamplingDialog.tsx',
    'src/components/texture/TextureStudio.tsx',
    'src/components/shapeLibrary/ShapeLibraryDialog.tsx',
    'src/components/shapeLibrary/BoardDesignPanel.tsx',
    'src/components/assemblyMarking/AssemblyMarkingPanel.tsx',
    'src/components/sidebar/Sidebar.tsx',
    'src/components/sidebar/RightSidebar.tsx',
    'src/components/settings/SettingsDialog.tsx',
  ]) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      if (ts.isJsxText(node) || ts.isStringLiteral(node)) {
        const value = node.text.trim()
        if (/[一-龥]/.test(value) && translateUiText('en-US', value) === value) missing.add(value)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual([...missing], [], 'Built-in UI strings are missing English translations')
  assert.equal(translateUiText('en-US', '取消分割 · 0'), 'Cancel Split · 0')
  assert.equal(translateUiText('en-US', '取消分割 · 12'), 'Cancel Split · 12')
  assert.equal(translateUiText('en-US', '◆ 板型库'), '◆ Shape Library')
  assert.equal(translateUiText('en-US', '我的猫咪项目.snapboard'), '我的猫咪项目.snapboard')
  assert.equal(translateUiText('zh-CN', '纹理抽样'), '纹理抽样')
  assert.equal(translateUiText('en-US', '框选范围内没有完整轮廓'), 'No complete contours inside the selection')
  assert.equal(translateUiText('en-US', '已框选 3 个轮廓：拖框内移动，拖角点等比缩放，拖顶部圆点旋转'), '3 contours selected: drag inside to move, corners to scale, or the top handle to rotate')
  console.log('Workspace i18n: static UI copy, dynamic split counts and custom filenames passed')
} finally {
  await server.close()
}
