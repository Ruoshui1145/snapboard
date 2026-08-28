# SnapBoard 项目文件与制造导出接口

更新时间：2026-08-27  
权威实现：`src/utils/projectFile.ts`、`src/utils/export3mf.ts`、`src/types/geometry.ts`。

## 1. 文件职责

| 文件 | 标识/格式 | 用途 | 可继续编辑 |
|---|---|---|---|
| `*.snapboard` | JSON，`snapboard-project` v1 | 完整编辑工作区 | 是 |
| `*-板件清单.json` | JSON，`snapboard-manufacturing` v1 | 旧制造几何接口 | 否 |
| `*-排盘-*.3mf` | 3MF Core + Bambu 盘元数据 | 切片器制造输入 | 否 |

`.snapboard` 保留草图、约束、分割参数、分割结果、板件和配件；3MF 只保留可打印制造实体。尺寸标注、P1/P2 标签、3D 虚线、相机和预览材质不属于 3MF。

## 2. `.snapboard` v1

```ts
interface SnapBoardProjectFile {
  format: 'snapboard-project'
  schemaVersion: 1
  appVersion: string
  savedAt: string                 // ISO 8601
  workspace: {
    project: Project
    boards: Board[]
    placedParts: PlacedPart[]
    boardTexture: BoardTextureConfig
    splitConfig: SplitConfig
    splitResult: SplitResultState | null
  }
}
```

`workspace.boardTexture` 保存纹理工作室状态，主要字段包括：

```ts
type BoardTextureModelingMode = 'high-fidelity' | 'pixel' | 'vector'
type BoardTextureLutId =
  | 'aliz-petg-rybw' | 'aliz-petg-cmyw' | 'mochuang-petg-bw'
  | 'aliz-petg-5color' | 'aliz-petg-6color' | 'aliz-petg-8color'

interface BoardTextureConfig {
  enabled: boolean
  source: 'preset' | 'image'
  imageDataUrl?: string
  fit: 'cover' | 'contain' | 'stretch' | 'tile'
  scale: number
  offsetX: number
  offsetY: number
  rotation: number
  modelingMode: BoardTextureModelingMode
  lutId: BoardTextureLutId
  quantizeColors: number
  hueWeight: number
  cleanup: boolean
  textureThickness: number
  pixelSize: number
  surfaceMode: 'lumina' | 'veneer'
  baseMaterialName: string
  surfaceMaterialName: string
  baseColor: string
  surfaceColor: string
  surfaceFinish: 'textured-pei' | 'smooth-top'
  baseInfillDensity: number
}
```

旧工程中的 `bambu-pla-*` LUT 标识会在打开时迁移到 PETG LUT；图片数据随工程保存，板面拖动/缩放只修改映射参数，不修改原图。

配件装配清单中的锚点与接触面：

```ts
interface PartMountAnchor {
  position: [number, number, number]
  normal?: [number, number, number]
  axis?: [number, number]        // 长圆孔局部长轴单位向量
  accepts: Array<'slot' | 'round' | 'either'>
}

interface PartMountDefinition {
  anchors: PartMountAnchor[]
  contactZ?: number              // 与板面贴合的局部接触面 Z
}
```

缺少 `axis` 的旧长圆孔锚点不会继续按无方向孔使用，必须打开标定器自动补算并保存。`PlacedPart.placement.targetIds` 是全局孔位占用依据，正背面共享同一 ID。

坐标由 `workspace.project.config.pixelToMM` 转换为毫米；分割配置中的热床、孔径、厚度、倒角和间隙均为毫米。

不保存：

- Command 撤销/重做对象；
- 当前工具、选择、悬停和弹窗；
- Three.js 相机、灯光、材质和网格缓存；
- 浏览器文件句柄。

打开时会校验 JSON、格式标识、schema、草图、板件、配件和分割结果。版本高于当前版本会拒绝打开；缺少后续新增的分割字段时按默认配置补齐，不能静默丢掉核心几何。

## 3. 制造清单 JSON v1

```ts
interface SnapBoardManufacturingFile {
  format: 'snapboard-manufacturing'
  schemaVersion: 1
  exportedAt: string
  units: 'millimeter'
  project: { name: string; version: string }
  config: SplitConfig
  panels: SplitPanel[]
}
```

`SplitPanel.contour` 是实际外环，`cutouts` 是实际内孔；`slots` 是长圆孔；`edge_holes[].knocked=true` 才表示真实贯通圆孔。未确认候选孔不能由消费者自行解释为已切孔。

## 4. 3MF 内容

当前输出为浏览器端生成的 OPC/ZIP 3MF，至少包含：

```text
[Content_Types].xml
_rels/.rels
3D/3dmodel.model
Metadata/model_settings.config
```

`3D/3dmodel.model`：

- `unit="millimeter"`；
- 每个制造几何一个 `object`；
- 每个排盘实例一个 `build/item`；
- transform 是 3×4 仿射矩阵；
- 不写入预览虚线和标签。

有纹理的板件使用一个父 `object` 和多个 `<component>` 子零件；父对象负责整体移动，子零件负责不同耗材和 part 级切片参数。结构基材、承托层、Lumina 光学层或质感贴面不会分别生成独立 build item。

有纹理时，3MF 还会按 PETG HF 配置写入耗材类型、245/230°C 喷嘴和 70°C 热床。`surfaceMode=lumina` 输出基材、承托和多色光学层；`surfaceMode=veneer` 输出基材与单耗材质感贴面。所有制造层通过父对象 components 绑定，板件与配件分开排盘。

相同板件或相同配件只保留一个 object，多个摆放位置通过 build item 复用；配件没有 `model.print` 或模型导入失败时跳过，并在导出后提示。

## 5. Bambu/Orca 兼容约定

`Metadata/model_settings.config` 保存每盘的对象实例映射：

```xml
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="SnapBoard 第 1 盘"/>
    <model_instance>
      <metadata key="object_id" value="1"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="1"/>
    </model_instance>
  </plate>
</config>
```

复合对象的 `<part>` 可以附带 `layer_height`、`wall_loops`、`top_shell_thickness`、`bottom_shell_thickness`、`sparse_infill_density`、速度和 `fuzzy_skin` 等 metadata。当前导出将 0.28mm/2 壁/15% 的结构参数写入全局与基材 part，承托层写入 0.28mm/实心，Lumina 光学 part 写入 0.08mm/实心/慢速。

关键规则：

- `plater_id` 必须从 1 开始连续编号；
- `object_id` 必须对应 `3dmodel.model` 中存在的 object；
- `(object_id, instance_id)` 不能重复；
- `identify_id` 必须为正数且全局唯一；
- 实例数量必须与对象数量和重复数量一致；
- 盘为空、盘号越界或映射不一致时阻止导出。

旧版本曾写入 0-based `plater_id`，可能导致 Bambu Studio 读取第一盘时非法索引；旧文件需要重新导出，修复不会回写已经生成的文件。

## 6. 制造精度与网格校验

- 制造曲线：48 段离散；
- 制造倒角：默认约 0.35 mm，可由 `SplitConfig.manufacturingChamfer` 调整；
- 目标 Z 范围：`0..thickness`；
- 导出前合并近重复顶点；
- 每条无向边必须恰好使用两次；
- 检查失败时不产生可下载制造文件。

## 7. 保存位置与 API

默认开发库：

```text
已保存项目/
├── 项目名.snapboard
└── 制造导出/
    └── 项目名-排盘-*.3mf
```

用户通过“保存位置”选择的本地目录使用 File System Access API，目录句柄保存在 IndexedDB；项目写入目录根，3MF 写入 `制造导出/`。浏览器不允许网页读取绝对路径，因此 UI 只显示目录名和文件名。

开发期 Vite API：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/project-library/save?filename=...` | 校验并保存项目 JSON |
| GET | `/api/project-library/list` | 列出默认项目库 `.snapboard` |
| GET | `/api/project-library/open?filename=...` | 打开默认项目 |
| POST | `/api/project-library/export?filename=...` | 保存制造 3MF |

云端只需把 `VITE_PROJECT_STORAGE_API_BASE` 指向实现同样接口的服务；生产实现必须额外处理认证、权限、冲突和对象存储。
