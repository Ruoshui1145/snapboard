# SnapColor 产品化封装与兼容说明

> 2026-09-23 新提案：[打印农场校色与 SnapColor 文件封装方案](SNAPCOLOR_FARM_CALIBRATION_PLAN_20260923.md)。在当前生产引擎内扩展候选 `.snapcolor` 档案包及旧 NPY 兼容，不接入另一套引擎；方案尚未实施。

> 2026-09-09 更新：SVG 与像素入口已恢复，布局编辑和工程重开保留模式；源图色板稳定化、SVG 自包含检查、像素预览和制造回归见 [打印与纹理修复记录](PRINT_TEXTURE_DEBUG_20260909.md)。下文“关闭入口”的内容为 2026-09-05 历史封装记录，不再表示当前状态。来源声明继续保留。

更新时间：2026-09-05

## 1. 本轮目标

本轮把 SnapBoard 主程序中的多色光学叠层统一包装为 **SnapColor**，并暂时收敛图片入口：

1. 新界面、新工程字段、运行时类型、LUT、资源目录、3MF对象名和进度提示统一使用 SnapColor；
2. 暂时关闭“像素艺术”和“SVG矢量”入口，只开放 PNG/JPG/WebP 高保真图片；
3. 保留多图片、自由放置、阵列、错列、每板分配、调色、封边和3MF制造能力；
4. 旧工程继续可读，读取后自动迁移到新字段；
5. 第三方许可证与原始归档保留真实来源，不将历史代码伪装成 SnapColor 自研资产。

## 2. 改前与改后对比

| 范围 | 改前 | 改后 | 兼容策略 |
| --- | --- | --- | --- |
| 产品名称 | Lumina | SnapColor | 只在 legal/legacy 说明中保留旧名称 |
| 表层模式 | `surfaceMode='lumina'` | `surfaceMode='snapcolor'` | 读取旧值时自动映射 |
| 默认LUT | `aliz-petg-rybw` | `snapcolor-petg-rybw` | Aliz/魔创/Bambu旧ID作为只读迁移别名 |
| LUT模块 | `luminaLut.ts` / `LuminaLut` | `snapColorLut.ts` / `SnapColorLut` | 运行时代码不再导入旧模块 |
| LUT资源 | `public/lumina/luts/*` | `public/snapcolor/luts/snapcolor-*` | 未使用的旧Bambu副本移入vendor归档 |
| 3MF对象名 | `P1 · Lumina 白色…` | `P1 · SnapColor 白色…` | 新导出只产生新名称 |
| Bambu模板 | 运行时直接依赖vendor路径 | `src/assets/snapcolor-bambu-config-template.json` | vendor仅作许可证/历史归档 |
| 图片模式 | 高保真、像素艺术、SVG矢量 | 只显示高保真图片 | 旧pixel/vector工程读取后转高保真 |
| 文件类型 | PNG/JPG/WebP/SVG | PNG/JPG/WebP | SVG会给出明确的暂未开放提示 |

## 3. 当前产品边界

当前开放：

- PNG、JPG/JPEG、WebP单图或多图导入；
- 自由叠放、矩形阵列、错列阵列、每板分配；
- Cover/Contain/Stretch、位置、尺寸、旋转、透明度；
- SnapColor RYBW、CMYW、黑白、5色、6色、8色校准组；
- 亮度、对比度、饱和度、设计色量化、色相保护；
- 基材单线封边、光学层和3MF多材料对象。

当前关闭：

- 像素艺术建模入口；
- SVG矢量纹理入口；
- `.svg` 文件选择与拖放导入。

功能门位于 `src/config/snapColorFeatures.ts`：

```ts
export const SNAPCOLOR_FEATURE_GATES = {
  pixelArtImport: false,
  svgVectorImport: false,
}
```

关闭入口不等于删除底层类型。`BoardTextureModelingMode` 仍保留 `pixel/vector`，只用于读取历史数据以及后续恢复功能时减少格式迁移。

## 4. 旧工程迁移

`normalizeBoardTexture()` 负责兼容，不提升 `.snapboard` schema版本：

| 旧值 | 新值 |
| --- | --- |
| `surfaceMode='lumina'` | `surfaceMode='snapcolor'` |
| `aliz-petg-rybw` | `snapcolor-petg-rybw` |
| `aliz-petg-cmyw` | `snapcolor-petg-cmyw` |
| `mochuang-petg-bw` | `snapcolor-petg-bw` |
| `aliz-petg-5color` | `snapcolor-petg-5color` |
| `aliz-petg-6color` | `snapcolor-petg-6color` |
| `aliz-petg-8color` | `snapcolor-petg-8color` |
| `modelingMode='pixel'/'vector'` | `modelingMode='high-fidelity'` |

旧字符串只能出现在 `snapColorLut.ts` 和 `projectFile.ts` 的迁移分支、测试夹具或第三方法律归档中。新工程序列化和新3MF不得再写出这些旧值。

## 5. 运行链路

```text
PNG/JPG/WebP
  → TextureStudio 文件校验与压缩
  → boardTexture 全局Canvas/多图编排
  → SnapColor 设计色量化
  → snapColorLut 实测颜色与层配方匹配
  → 3D正面预览
  → export3mf 基材/承托/封边/SnapColor光学对象
```

3D预览和3MF继续复用同一张处理结果，避免界面与制造颜色路径分叉。表层为 `veneer` 时仍走单耗材贴面分支，不进入SnapColor LUT。

## 6. 文件与职责

| 文件 | 职责 |
| --- | --- |
| `src/config/snapColorFeatures.ts` | 临时入口开关与允许的图片MIME |
| `src/utils/snapColorLut.ts` | SnapColor色卡、旧ID迁移、NPY读取、色差匹配、层配方 |
| `src/utils/boardTexture.ts` | 图片编排、调色、量化和3D纹理Canvas |
| `src/components/texture/TextureStudio.tsx` | 当前只开放高保真图片的产品界面 |
| `src/utils/export3mf.ts` | SnapColor多材料对象、层高与Bambu工程输出 |
| `src/utils/projectFile.ts` | 旧品牌字段和已封闭模式迁移 |
| `public/snapcolor/luts/` | 生产运行时LUT与stack资产 |
| `scripts/verify-snapcolor-packaging.mjs` | 品牌、入口、资源和迁移边界回归 |

## 7. 后续重新开放像素艺术

1. 将 `pixelArtImport` 改为 `true`；
2. 恢复像素格尺寸控件，确认其只在 `modelingMode='pixel'` 显示；
3. 修改 `normalizeBoardTexture()`，允许新工程继续保存pixel而不是强制迁移；
4. 增加0.4–6mm格尺寸的3D/3MF尺寸回归；
5. 验证封边宽度不会小于像素采样格导致空层。

## 8. 后续重新开放SVG矢量纹理

1. 将 `svgVectorImport` 改为 `true`；
2. 把 `image/svg+xml,.svg` 恢复到文件accept；
3. 恢复SVG data URL保存与`vector=true`路径；
4. 做script/use/foreignObject/外链和事件属性安全检查；
5. 验证Illustrator大型SVG的解码缓存、拖动防抖和工程体积；
6. 恢复vector模式序列化，并补旧工程/多图片/每板分配回归。

在这六项完成前，不应只把按钮重新显示出来。

## 9. 验证命令

```powershell
npm run verify:snapcolor
npm run verify:texture
npm run verify:i18n
npm run build
```

`verify:snapcolor`检查：功能门关闭、文件accept不含SVG、运行时LUT目录与文件全部使用SnapColor、3MF对象名使用SnapColor、旧Aliz与旧surfaceMode仍能迁移。

## 10. 法律与归档边界

`vendor/lumina-studio/`、根目录第三方声明和GPL许可证属于来源证据，不能通过产品换名删除或改写。主程序不再从vendor路径导入运行时代码；vendor仅承担历史审计和许可证留存。任何对外包仍需附带仓库现有许可证与第三方声明。
