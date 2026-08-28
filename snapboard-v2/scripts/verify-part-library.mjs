import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { categoryFromDirName, CATEGORY_DIRECTORY_NAMES } from './part-category-rules.mjs'

const read = file => readFile(file, 'utf8')
const expected = ['hook', 'bracket', 'shelf', 'bin', 'organizer', 'fastener', 'base', 'cable']
assert.deepEqual(CATEGORY_DIRECTORY_NAMES.map(categoryFromDirName), expected)
await Promise.all(CATEGORY_DIRECTORY_NAMES.map(name => access(`配件资源包/${name}/.gitkeep`)))

const [vite, sync, dialog, css, viewport, types, indexText] = await Promise.all([
  read('vite.config.ts'),
  read('scripts/sync-part-library.mjs'),
  read('src/components/partLibrary/PartImportDialog.tsx'),
  read('src/App.css'),
  read('src/components/viewport/Viewport3D.tsx'),
  read('src/partLibrary/types.ts'),
  read('public/partLibrary/index.json'),
])

assert.match(vite, /part-category-rules\.mjs/)
assert.match(sync, /part-category-rules\.mjs/)
assert.doesNotMatch(vite, /const categoryFromDirName/)
assert.doesNotMatch(sync, /function categoryFromDirName/)
assert.match(sync, /rootModels\.length > 0/)
assert.match(sync, /manifest\.category \?\? dirCategory/)
assert.match(vite, /大类目录采用 <大类>\/<零件>\/ 布局；不要创建空 parts\//)
assert.match(vite, /targetPackageId/)
assert.match(vite, /api\/part-library\/batch/)
assert.match(vite, /action === 'reorder'/)
assert.match(vite, /manifest\.sortOrder/)

assert.equal((dialog.match(/createPortal\(/g) ?? []).length, 2)
assert.equal((dialog.match(/document\.body/g) ?? []).length, 2)
assert.match(dialog, /单个模型失败不阻断其余文件/)
assert.match(dialog, /配件信息与文件位置/)
assert.match(dialog, /删除零件/)
assert.match(css, /max-height:\s*min\(88vh,\s*calc\(100vh - 48px\)\)/)
assert.match(css, /\.part-import-scroll[\s\S]*overflow-y:\s*auto/)

assert.match(vite, /findPartManifest/)
assert.match(vite, /向上找到最近持有 pack\.json/)
assert.match(vite, /api\/system\/shutdown/)
assert.match(vite, /process\.exit\(0\)/)
assert.match(viewport, /openCoveredAssemblyTargets/)
assert.match(viewport, /occupiedTargetIds\(moving\.partId\)/)
assert.match(types, /待补长孔方向/)

const index = JSON.parse(indexText)
assert.ok(index.parts.length >= 1)
assert.ok(index.packages.length >= 1)
const legacyMissingAxes = index.parts.filter(part => typeof part.mount === 'object' &&
  part.mount.anchors?.some(anchor => anchor.accepts?.includes('slot') && !anchor.axis)).length

console.log(`part library regression: ${CATEGORY_DIRECTORY_NAMES.length} categories, ${index.packages.length} packs, ${index.parts.length} parts, ${legacyMissingAxes} legacy parts require axis upgrade`)
