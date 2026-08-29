# SnapBoard v2

SnapBoard 是一个面向 3D 打印洞洞板的网页设计、自动分割、3D 装配和制造导出工具。

## 快速开始

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # 生产构建
npm run lint      # oxlint
npm run verify:3mf
npm run verify:texture
npm run verify:parts
npm run verify:holes
npm run verify:assembly
npm run verify:textured-3mf -- path/to/generated.3mf
```

统一官网入口：`http://localhost:5173/`；设计器入口：`http://localhost:5173/design`。官网的“项目资料”页集中链接公开文档、开发日志和 GitHub 仓库。

Windows 用户可直接双击项目目录中的 [`SnapBoard Studio.lnk`](SnapBoard%20Studio.lnk)，或运行 [`一键启动 SnapBoard.bat`](一键启动%20SnapBoard.bat)。脚本会等待 5173 服务真正就绪后再打开设计器，首次运行会自动安装依赖。

启动和构建前会自动执行 `npm run parts:sync`，把 `配件资源包/` 同步到 `public/partLibrary/`。Windows 下不要删除 `vite.config.ts` 的文件监听忽略规则，它用于避开编辑器临时目录导致的 EBUSY。

## 产品链路

```text
2D 草图 → 尺寸约束 → 自动分割 → 3D 孔位/装配预览 → .snapboard / 3MF
```

同一份 Zustand 工作区同时驱动 2D、3D、分割和制造输出：

- 2D 支持直线、矩形、圆、弧、槽口、多边形、等距实体、擦除和智能尺寸；
- 自动分割支持正交外轮廓、内孔、跨板孔、边缘融合和热床旋转；
- 3D 使用 Three.js 生成真实板厚、贯通孔、倒角和配件吸附预览；
- 未确认的候选孔只显示 2D/3D 虚线，不会生成薄盖或进入 3MF；
- 纹理工作室按“贴图纹理 / 材质纹理 / 自定义图片”三条流程组织；图片导入与 Lumina 建模模式并排，板面拖动/滚轮缩放只在操作结束时提交纹理重建，虚线边框实时显示整张图片范围，避免条纹拖影和位置回弹；
- 彩色板件支持“Lumina 彩色版画”和“普通 PETG 基材 + 约 1 mm 高级 PETG 质感贴面”两种制造方式；复合层绑定为一个可整体移动对象，外缘、内孔和孔口采用上下对称倒角；
- 结构基材使用 0.28 mm、2 壁、默认 15% gyroid；0.6 mm 承托/壳层同样使用 0.28 mm，只有 Lumina 光学叠色保持 0.08 mm、实心和慢速；细磨砂方案让装饰面朝下接触纹理 PEI 热床；
- 3MF 导出显示分阶段进度并支持取消，板件与配件分开排盘；
- 左右栏支持折叠、靠边悬停展开和拖动调宽；右栏为全高整列，分割/配件/纹理三个业务工作区入口固定在右栏顶部双层 tab 条，进入任一工作区自动收起左栏；第二工具栏提供紧凑的“自动/取消分割”和 2D/3D 开关，手动切回 2D 不关闭当前右栏业务；
- 配件资源包支持 8 个大类根目录、传统 `parts/` 布局、散模型自动拆分和网页批量导入；配件信息设置可修改名称、说明、序号与资源分类，也可永久删除零件；默认顺序写入 `part.json.sortOrder`，拖动排序会同步到资源包而非只保存在当前浏览器；
- 孔位默认采用 5×15 mm 长圆孔与用户确认的 φ5 固定圆孔；原始轮廓先建立唯一母阵，分板只裁取；内部接缝圆孔默认内缩 10 mm，非模数外周圆孔与最近长孔共线并取相邻中心中点；
- 配件标定支持长圆孔轴向、独立接触面 `contactZ`、旧误记数据恢复、正背面双向装配、全局孔位占用和候选圆孔自动打孔；拖拽时以半透明模型、胶囊/圆形锚点和附近候选孔共同预览；
- 导出前检查闭合网格和 Bambu 多盘实例映射。

## 文件操作

顶部【文件】卡提供新建、打开、保存、另存为、保存位置和排盘 3MF。

- `.snapboard`：可继续编辑的工程文件，保存草图、约束、分割参数、分割结果和装配数据；
- `3MF`：给 Bambu Studio、OrcaSlicer、PrusaSlicer 等使用的制造文件；
- 未选择工作目录时，开发环境默认写入 `已保存项目/`，3MF 写入 `已保存项目/制造导出/`；
- 点击“保存位置”可授权任意本地文件夹，项目写入目录根，3MF 写入该目录的 `制造导出/`；
- 排盘 3MF 会同步保存一个 `.snapboard` 项目快照，便于之后从“打开”列表恢复；
- 浏览器不能静默访问电脑绝对路径，首次选择目录必须由用户主动授权。

本地开发 API 和云端接口预留说明见 [`docs/PROJECT_DOCUMENTATION.md`](docs/PROJECT_DOCUMENTATION.md)。云端部署设置：

```text
VITE_PROJECT_STORAGE_API_BASE=https://your-api.example.com/api/project-library
```

## 文档索引

技术文档(实现/规格/格式/路线/更新)在本仓库 `docs/`;商业与市场文档保留在本地 `../商业运营/`，不随公开 GitHub 仓库提交。公开用户文档、开发日志和架构说明的源文件位于 `../apps/wiki/`，普通用户从官网“项目资料”页进入。

配件资源包中部分模型来自 MakeWorld 等公开页面，仅作导入、渲染、装配和 3MF 回归测试，不用于商业化；第三方资源边界见根目录 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

| 文档 | 内容 |
|---|---|
| [`docs/PROJECT_DOCUMENTATION.md`](docs/PROJECT_DOCUMENTATION.md) | 当前实现的完整项目文档、架构、数据流、保存和排障 |
| [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md) | 技术栈、模块边界和几何事实摘要 |
| [`docs/SPLIT_ENGINE_RESEARCH.md`](docs/SPLIT_ENGINE_RESEARCH.md) | 分割、孔位安全域、规则/六边形模块研究与验证路线 |
| [`docs/TECHNICAL_EVOLUTION.md`](docs/TECHNICAL_EVOLUTION.md) | 分割算法、3D引擎、装配与制造链的创新候选和迭代路径 |
| [`docs/MECHANICAL_VALIDATION_PLAN.md`](docs/MECHANICAL_VALIDATION_PLAN.md) | PETG 材料、孔阵、接缝和长期耐久实验计划 |
| [`docs/PROJECT_FILE_FORMAT.md`](docs/PROJECT_FILE_FORMAT.md) | `.snapboard`、制造清单和 3MF 接口 |
| [`docs/PART_LIBRARY_ASSEMBLY_ROADMAP.md`](docs/PART_LIBRARY_ASSEMBLY_ROADMAP.md) | 配件包格式、锚点和装配路线 |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | 版本更新与制造格式兼容说明 |
| [`docs/AI交接提示词.md`](docs/AI交接提示词.md) | 开发交接提示词(技术侧,已被文档体系覆盖,仅供参考) |
| [`../商业运营/`](../商业运营/) | 商业侧资料包:报告书/商业模式/市场调研/演示讲稿等 |
| [`../商业运营/08-科创主线与商业验证决策指南.md`](../商业运营/08-科创主线与商业验证决策指南.md) | 科创主线、商业验证、竞赛、知识产权、投入边界与开发记录规范 |

## 主要代码入口

- `src/components/designer/DesignerApp.tsx`：三栏设计器与状态栏；
- `src/components/toolbar/Toolbar.tsx`：工具、文件、自动分割和视图切换；
- `src/store/useAppStore.ts`：运行时工作区和命令历史；
- `src/hooks/useSketchTool.ts`：2D 绘图状态机；
- `src/utils/pegboardSplit.ts`：分割、孔位和边缘融合；
- `src/utils/boardMesh.ts`：预览/制造板件网格；
- `src/components/viewport/Viewport3D.tsx`：Three.js 场景和装配；
- `src/utils/projectFile.ts`：项目文件、目录授权和存储 API；
- `src/utils/export3mf.ts`：3MF 生成、热床排盘和网格校验；
- `src/utils/luminaLut.ts`：PETG LUT、基础耗材与 Lumina 层配方；
- `src/utils/boardTexture.ts`：纹理预处理、视觉色映射和画布缓存；
- `src/components/texture/TextureStudio.tsx`：纹理、LUT、层厚和打印端调色设置；
- `vite.config.ts`：资源包同步、配件接口和本地项目库 API。

## 验证

```bash
npm run build
npm run lint
node .tmp-3d-test/verify-manufacturing-export.mjs
node .tmp-3d-test/verify-lumina-performance.mjs
node .tmp-3d-test/verify-texture-direct-manipulation.mjs
node .tmp-3d-test/verify-consumer-layout.mjs
node .tmp-3d-test/verify-hole-open-store.mjs
```

几何改动还应运行 `.tmp-3d-test/` 下相应的孔位、布尔、轮廓和项目文件回归脚本。Lint 中现有的轮盘组件 Fast Refresh 提示和临时脚本未使用变量提示不影响构建。
