# SnapBoard 当前开发指南

更新时间：2026-08-29
适用代码：`D:\自动切片设计软件\snapboard-v2`
文档定位：给接手开发者使用的当前实现指南。历史方案、竞品调研和未接线后端不以本文为运行时依据。

> 2026-08-29：官网与独立设计器的构建、EdgeOne Pages 双项目配置、环境变量和线上能力边界以 [`snapboard-v2/docs/DEVELOPMENT_GUIDE.md`](../../snapboard-v2/docs/DEVELOPMENT_GUIDE.md) 为准；本文保留内部代码修改规则。

## 1. 先读什么

按以下顺序阅读：

1. 根目录 [`README.md`](../../README.md)：仓库边界、启动入口和当前产品事实；
2. [`PROJECT_STRUCTURE.md`](../../PROJECT_STRUCTURE.md)：领域模块边界和迁移规则；
3. [`snapboard-v2/docs/PROJECT_DOCUMENTATION.md`](../../snapboard-v2/docs/PROJECT_DOCUMENTATION.md)：应用详细实现；
4. 本文：开发流程、修改边界和验证要求；
5. [`modules/`](../../modules/)：各领域模块的当前职责。

`docs-internal/architecture/总体架构.md` 和 `2D草图子系统架构.md` 保留早期 SolidWorks 对标和后端设想，阅读时以本文及 `snapboard-v2/docs/` 的当前实现覆盖为准。

## 2. 当前运行时边界

```text
apps/wiki/                 公开 Markdown 文档与开发日志源文件（不作为第二官网）

snapboard-v2/              官网与独立 Studio React/Vite 应用共同源码
        ├── 官网模式：`npm run site:build:public`，不打包设计器
        └── 设计器模式：`npm run build:designer`，独立网页发布
        ├── Canvas 2D 草图 + Planegcs WASM
        ├── Split Worker + 纯 TS 分割算法
        ├── Three.js WebGL 3D 装配
        ├── Lumina/PETG 纹理与复合板
        ├── 浏览器端 3MF 制造导出
        └── Vite 开发期本地 API

module2-segmentation/     历史 Python 模块，当前未接入 Studio
vendor/lumina-studio/     第三方参考源码/运行模板，不由 Studio 直接导入源码
商业运营/、workspace-data/ 内部或本地数据，不进入公开前端构建
```

当前不是“React 前端 + FastAPI 分割后端”的运行模式：2D、分割、3D 和 3MF 主要在浏览器端完成；Vite middleware 只提供开发期文件操作和资源包写回。云端项目存储通过 API 基址预留，但服务端不在本仓库运行时内。

## 3. 本地开发

```bash
cd D:\自动切片设计软件
npm install
npm run dev          # Studio，默认 http://localhost:5173
npm run build        # Studio 生产构建
npm run lint         # oxlint
npm run build:all    # Studio + Wiki
npm run site:build   # 统一公开站点，设计器挂在 /design/
npm run site:build:public # EdgeOne 官网产物（不含设计器）
npm --workspace snapboard-v2 run build:designer # EdgeOne 独立设计器产物
```

仅在 `snapboard-v2` 内运行资源包和回归脚本：

```bash
npm --workspace snapboard-v2 run parts:sync
npm --workspace snapboard-v2 run verify:3mf
npm --workspace snapboard-v2 run verify:assembly
npm --workspace snapboard-v2 run verify:parts
npm --workspace snapboard-v2 run verify:split
npm --workspace snapboard-v2 run verify:textured-3mf
```

`predev`/`prebuild` 会同步配件资源包。Vite 的 `server.watch.ignored` 必须保留，否则 Windows 编辑器原子保存的临时目录可能触发 EBUSY。

## 4. 修改功能时的依赖原则

### 4.1 工作区状态

`src/store/useAppStore.ts` 是唯一运行时工作区，主要字段是：

- `project`：草图、约束、材料和特征；
- `splitConfig/splitResult/splitJob`：分割输入、派生板件和 Worker 状态；
- `placedParts`：配件实例、吸附孔、旋转和参数；
- `boardTexture`：PETG/Lumina/图片纹理配置；
- `undoStack/redoStack`：会话命令；
- `ui`：工具、选择、工作区 tab、视图和面板状态。

项目文件只保存可恢复的工程数据，不保存命令对象、相机、选择、WebGL 缓存和临时预览。

### 4.2 Command 作用域

`src/commands/Command.ts` 的 `affectsSketch` 决定命令是否需要：

- 取消正在进行的草图分割；
- 刷新约束状态；
- 调用 `syncSplitToSketch()`。

草图命令默认影响草图；`AddBoardCommand`、`PlacePartCommand`、`MovePartCommand`、`RemovePartCommand` 明确设为 `false`。新增只修改配件、纹理或 UI 的命令必须设为 `false`，否则会在拖动配件时重新启动分割 Worker。

### 4.3 Split Worker

`runAutoSplit()` 和 `syncSplitToSketch()` 通过 `src/workers/splitEngine.worker.ts` 执行。Worker 请求必须只包含可结构化克隆的几何数据，不能传 React、Three.js 对象、文件句柄或函数。任务通过 `jobId`、源 `project` 引用和源 `splitConfig` 引用做过期结果检查。

分割结果改变不等于重新分割：手动开孔、装配命中候选孔只更新 `splitResult` 和板件网格；配件位置只更新 `placedParts` 和 3D 配件子树。

## 5. 2D 草图开发规则

2D 入口：`src/components/viewport/SketchViewport2D.tsx`、`src/hooks/useSketchTool.ts`、`src/engine/`、`src/commands/SketchCommands.ts`。

- 草图内部是 Canvas 世界坐标；`pixelToMM` 负责毫米换算；
- 外轮廓是 `outer`，内轮廓是 `inner`；构造线不进入制造；
- 圆、弧、槽口和多边形需要保持自己的参数字段，不要全部压成不可逆的点列；
- 命中阈值应通过 `viewportCamera` 从屏幕像素换算，不能写死世界单位；
- 修改几何必须通过 Command，保证 undo/redo 和分割同步；
- 含弧轮廓进入制造前必须完成离散、方向和自交检查；
- 2D 的候选孔虚线是交互信息，不是实体孔。

不要把 SolidWorks 功能清单中的所有工具直接当作当前需求。当前产品是单平面洞洞板设计器，椭圆、样条、3D 草图、方程式曲线和完整工程图标注仍属于后续范围。

## 6. 2D 分割开发规则

核心文件：`src/utils/pegboardSplit.ts`、`panelBoolean.ts`、`printBed.ts`、`contourMerge.ts`。

分割输出必须包含：

- 实际板件外环 `SplitPanel.contour`；
- 完整内孔 `cutouts`；
- 长圆孔、圆孔和边缘候选孔；
- `printRotation`、警告和覆盖率；
- 能被 3D、装配和导出直接复用的毫米坐标。

长圆孔默认 5×15 mm，全局错列；候选圆孔只有 `knocked=true` 才变成贯通实体。新增孔位规则要同时更新 2D 预览、3D 网格、装配目标和 3MF 回归。

## 7. 3D 与装配开发规则

核心文件：`Viewport3D.tsx`、`boardMesh.ts`、`glbLoader.ts`、`assemblySnap.ts`、`assemblySide.ts`。

### 7.1 网格

- 板件由 `Shape/Path + ExtrudeGeometry` 生成，单位为毫米；
- 真实孔进入 Shape holes/实体外环；候选孔使用 `LineDashedMaterial` 虚线；
- 预览对象通过 `userData.previewOnly` 标记，导出器必须忽略；
- 制造网格使用高精度曲线和倒角，并进行闭合边校验；
- 重建板件不应自动重置相机，除非板件布局 key 发生变化。

### 7.2 配件

配件通过 `part.json` 的 `model.preview`、`model.print`、单位、朝向和锚点加载。多锚点使用刚体 2D 配准，不能缩放零件凑孔距。正面/背面由 `assemblySide` 决定，并统一翻转锚点、法向、长轴和 `contactZ`。

装配新增/移动/删除只应更新 `placedParts`。如果命中未打通的候选圆孔，调用幂等 `openCoveredAssemblyTargets()`，只把对应孔切换为实体孔，不重新跑整套分割。

### 7.3 标定器

`PartMountCalibrator.tsx` 使用独立 Three.js 场景和 OrbitControls。朝向旋转绕模型变换后几何中心枢轴；X/Y/Z 环法向分别对应 `+X/+Y/+Z`。每个环有箭头抓手，角度通过环平面交点计算并吸附到 15° 刻度；拖动期间锁定相机位置、目标和缩放。

长孔锚点保存局部 `axis`。同一零件已有一致方向时，同步器会补齐采样失败的锚点；方向全部缺失或冲突时才要求人工复核。不要只检查第一个锚点来绕过方向校验。

## 8. 配件资源库开发规则

源目录是 `snapboard-v2/配件资源包/`，运行时索引是 `public/partLibrary/index.json`。同步脚本负责：

- 双布局扫描（`<包>/parts/<零件>` 和大类根布局）；
- 生成/更新 `part.json`、包索引和静态资源复制；
- 识别模型缩略图与实装照片；
- 按同件已有方向补齐缺失长孔 `axis`；
- 为网页导入、标定、改名、照片和分类 API 提供一致索引。

封面 `thumbnail` 与实装图 `model.usageImage` 必须分离。`usage-*`、`assembly-*`、`install-*`、`photo-*` 只属于实装照片；卡片默认用模型 WebGL 渲染，展开预览才展示实装图。实装照片接口支持上传替换和 DELETE 删除。

配件库 UI 的细分标签删除按钮必须保留布局占位，避免 hover 显示/隐藏造成换行抖动。资源库排序、移动、删除、照片和标定写回后必须发送 `snapboard:part-library-updated`，让 Hook 重新读取带时间戳的索引。

## 9. 文件、导出与部署

### 9.1 项目文件

`.snapboard` 当前 schema v1，保存草图、约束、分割和装配；打开前严格校验，版本不兼容不得静默降级。

### 9.2 3MF

3MF 由浏览器端 `fflate` 生成，包含板件、可制造配件、对象复用、热床排盘和 Bambu `model_settings.config`。`plater_id` 必须从 1 开始，网格必须闭合，预览虚线和标签不得进入制造对象。

### 9.3 本地与云端

本地开发默认写入 `已保存项目/`；用户选择的目录通过 File System Access API 授权并用 IndexedDB 记住。Vite API 提供项目保存/列表/打开和 3MF 导出。云端只需实现同名接口并设置：

```text
VITE_PROJECT_STORAGE_API_BASE=https://example.com/api/project-library
```

### 9.4 EdgeOne Pages / Makers 双网页

生产环境默认使用两个 EdgeOne Pages / Makers 项目：

| 项目 | 根目录 | 构建命令 | 输出目录 | 配置文件 |
|---|---|---|---|---|
| 官网 | 仓库根目录 `./` | `npm run site:build:public` | `snapboard-v2/dist` | [`edgeone.json`](../../edgeone.json) |
| 设计器 | `snapboard-v2` | `npm run build:designer` | `dist` | [`snapboard-v2/edgeone.json`](../../snapboard-v2/edgeone.json) |

两份配置中的输出目录都相对于各自项目根目录解析，并使用 Node.js `22.11.0`。两项目都连接 `main` 分支；官网设置 `VITE_DESIGNER_URL`，设计器设置 `VITE_WEBSITE_URL`，变量改变后必须重新部署。`VITE_*` 会进入浏览器 bundle，不得放 Token 或其他秘密。

`edgeone.json` 中的精确规则 `source: "/*"`、`destination: "/index.html"` 是 SPA fallback；官网和设计器都必须保留，否则刷新 `/community`、`/guide`、`/project` 或 `/design` 可能返回 404。EdgeOne 官方配置、CLI 和域名说明见：[`edgeone.json` 文档](https://pages.edgeone.ai/zh/document/edgeone-json)、[`EdgeOne CLI`](https://pages.edgeone.ai/zh/document/edgeone-cli)、[`自定义域名`](https://pages.edgeone.ai/zh/document/custom-domain)。

官网模式只复制 `public-site/`，不会将 `public/partLibrary` 中的模型资源打进官网；设计器模式保留完整资源库。设计器上线后仍是静态前端，本地 Vite middleware 提供的 `/api/part-library/*`、`/api/project-library/*` 和 `/api/system/shutdown` 不会自动变成云端接口；云端保存、多人协作和资源写回必须另行部署后端并设置 `VITE_PROJECT_STORAGE_API_BASE`。

EdgeOne 控制台 Git 自动部署是默认路径。需要 CI/手动上传时使用短期 API Token 和 `npx edgeone makers deploy <产物目录> -n <项目名> -e preview -t $env:EDGEONE_API_TOKEN`；Token 只放 Secret/环境变量，禁止提交到仓库。纯静态前端也可部署到 Vercel，但其 `vercel.json` 仅是备用配置。

## 10. 验证矩阵

| 改动范围 | 最低验证 |
|---|---|
| UI/文案/CSS | `npm run build`、必要时截图/浏览器冒烟 |
| Command/Store | `npm run build`、配件命令不触发分割的行为检查 |
| 2D 草图/约束 | `verify:dimensions`、草图相关回归 |
| 分割/孔位 | `verify:split`、`verify:split-shapes`、`verify:holes`、`verify:edge-holes` |
| 3D 装配 | `verify:assembly`、必要时运行浏览器 3D 流程 |
| 配件资源库 | `verify:parts`、资源同步和照片接口检查 |
| 3MF/纹理 | `verify:3mf`、`verify:textured-3mf`、`verify:texture` |
| 文件 schema | `verify-project-file` 或对应项目文件回归 |
| 官网/设计器部署 | `npm run site:build:public`、`npm --workspace snapboard-v2 run build:designer`，再检查 EdgeOne 预览地址和 SPA 刷新 |

构建中的 Planegcs externalization 和大 chunk 是已知提示；只要命令退出码为 0，不把它们误报成失败。Lint 当前也有若干 React 规则警告，新增代码不得引入类型错误或运行时异常。

## 11. 提交前清单

```text
[ ] 是否修改了权威类型/接口，而不是只改了 UI 文案？
[ ] 是否区分了预览对象与制造对象？
[ ] 配件操作是否错误触发了分割 Worker？
[ ] 新增文件是否有路径越界、大小和缓存考虑？
[ ] 2D/3D/装配/3MF 是否共用同一份毫米几何语义？
[ ] 资源包同步后是否发送更新事件？
[ ] 项目文件是否能保存、打开、校验和恢复？
[ ] 是否运行了对应 verify 脚本和 npm run build？
[ ] 是否同步更新了 docs、modules 和 Wiki 中的当前事实？
```

## 12. 变更记录模板

每次提交或 Issue 至少填写一次，避免用“已优化”替代证据：

```text
日期 / 分支 / 版本：
用户问题与验收标准：
所属模块：Sketch / Split / Assembly / Texture / Manufacturing / Part Platform / Site
输入样本与当前假设：
修改文件、数据格式和 API 影响：
采用方案与放弃方案：
验证命令、结果、耗时、截图：
已知限制、风险和回滚提交：
EdgeOne 预览地址 / 环境变量变更：
Release 标签（如有）：
下一步与停止条件：
```

新增第三方模型或图片时，还必须同步更新根目录 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)，记录来源、作者/页面、许可证状态、测试用途和后续授权/移除责任。
