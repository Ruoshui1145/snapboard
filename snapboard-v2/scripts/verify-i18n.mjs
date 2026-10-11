import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [catalog, provider, main, designer, sidebar, parts, preview, settings, css] = await Promise.all([
  readFile('src/i18n/catalog.ts', 'utf8'),
  readFile('src/i18n/I18nProvider.tsx', 'utf8'),
  readFile('src/main.tsx', 'utf8'),
  readFile('src/components/designer/DesignerApp.tsx', 'utf8'),
  readFile('src/components/sidebar/Sidebar.tsx', 'utf8'),
  readFile('src/components/sidebar/PartLibraryPanel.tsx', 'utf8'),
  readFile('src/components/partLibrary/PartPreviewDialog.tsx', 'utf8'),
  readFile('src/components/settings/SettingsDialog.tsx', 'utf8'),
  readFile('src/App.css', 'utf8'),
])

const englishObject = catalog.match(/const EN: Record<string, string> = \{([\s\S]*?)\n\}/)?.[1] ?? ''
const keys = [...englishObject.matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1])
assert.ok(keys.length >= 250, `expected a broad built-in UI catalog, found ${keys.length} entries`)
assert.equal(new Set(keys).size, keys.length, 'built-in translation catalog must not contain duplicate keys')
for (const required of ['2D 草图工作台', '特征', '属性 (选中轮廓)', '约束 (选中轮廓)', '选择配件', '装配演示', '配件装配标定', '设置与资源中心', '纹理工作室', '数学密铺生成器', '图片资源与图层', '遮挡预览']) {
  assert.ok(keys.includes(required), `missing required built-in translation: ${required}`)
}

assert.match(provider, /snapboard-ui-language/)
assert.match(provider, /MutationObserver/)
assert.match(provider, /const root = document\.body/)
assert.match(provider, /document\.documentElement\.lang = locale/)
assert.match(provider, /data-i18n-ignore/)
assert.match(main, /<I18nProvider><App \/><\/I18nProvider>/)
assert.match(designer, /workbench-settings-button/)
assert.match(settings, /useI18n/)
assert.match(settings, /setLocale/)
assert.match(sidebar, /sb-project-name" data-i18n-ignore="true"/)
assert.match(sidebar, /sb-feature-meta/)
assert.match(parts, /data-i18n-ignore="true">\{part\.name\}/)
assert.match(preview, /part-preview-title" data-i18n-ignore="true"/)
assert.match(settings, /data-i18n-ignore="true">\{file\.name\}/)
assert.match(css, /\.mount-scene-heading > \.lib-step-index[^}]*justify-content:\s*center/)
assert.match(css, /html\[lang="en-US"\]/)
assert.match(css, /html\[lang="en-US"\] \.designer-shell \.sb-empty[^}]*font-size:\s*12\.5px/)
assert.match(css, /html\[lang="en-US"\] \.designer-shell \.tb-gbtn[^}]*font-size:\s*12\.5px/)

console.log(`i18n regression: zh-CN/en-US runtime, ${keys.length} built-in strings, portals, custom-name exclusions and centered step badges OK`)
